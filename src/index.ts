// server/index.ts
import express from 'express';
import cors from 'cors';
import * as admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

// Khởi tạo Firebase Admin SDK
const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
let serviceAccountConfig: admin.ServiceAccount;

if (serviceAccountBase64) {
  serviceAccountConfig = JSON.parse(
    Buffer.from(serviceAccountBase64, 'base64').toString('utf8')
  ) as admin.ServiceAccount;
} else {
  const serviceAccountPath = path.resolve(process.cwd(), 'serviceAccountKey.json');
  if (!existsSync(serviceAccountPath)) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 not set and serviceAccountKey.json missing');
  }
  serviceAccountConfig = JSON.parse(
    readFileSync(serviceAccountPath, 'utf8')
  ) as admin.ServiceAccount;
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountConfig),
  });
}

const app = express();
const db = admin.firestore();
const messaging = admin.messaging();

app.use(cors());
app.use(express.json());

// Middleware xác thực
async function authenticate(req: any, res: any, next: any) {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Middleware kiểm tra admin
async function requireAdmin(req: any, res: any, next: any) {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userData = userDoc.data();

    if (userData?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
}

// ===== API ENDPOINTS =====

// 1. Gửi thông báo đến tất cả NGAY LẬP TỨC
app.post('/api/notifications/send-all', authenticate, requireAdmin, async (req, res) => {
  try {
    const { title, body } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body are required' });
    }

    // Lấy tất cả device tokens
    const tokensSnapshot = await db.collection('deviceTokens').get();
    const tokens = tokensSnapshot.docs.map(doc => doc.data().token);

    if (tokens.length === 0) {
      return res.json({
        success: false,
        message: 'No devices registered',
        successCount: 0,
        failureCount: 0,
      });
    }

    // Gửi thông báo (batch 500 tokens)
    const batchSize = 500;
    let successCount = 0;
    let failureCount = 0;
    const failedTokens: string[] = [];

    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);

      const message = {
        notification: { title, body },
        tokens: batch,
      };

      const response = await messaging.sendEachForMulticast(message);
      successCount += response.successCount;
      failureCount += response.failureCount;

      // Lưu token thất bại
      if (response.failureCount > 0) {
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            failedTokens.push(batch[idx]);
          }
        });
      }
    }

    // Xóa token không hợp lệ
    if (failedTokens.length > 0) {
      await Promise.all(
        failedTokens.map(async (token) => {
          const snapshot = await db
            .collection('deviceTokens')
            .where('token', '==', token)
            .get();
          
          return Promise.all(snapshot.docs.map(doc => doc.ref.delete()));
        })
      );
    }

    // Lưu vào notificationHistory
    await db.collection('notificationHistory').add({
      title,
      body,
      targetType: 'all',
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      totalDevices: tokens.length,
      successCount,
      failureCount,
      readBy: [],
    });

    res.json({
      success: true,
      message: `Sent to ${successCount}/${tokens.length} devices`,
      successCount,
      failureCount,
      totalDevices: tokens.length,
    });
  } catch (error: any) {
    console.error('Error sending notification:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Gửi thông báo đến user cụ thể
app.post('/api/notifications/send-to-user', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId, title, body } = req.body;

    if (!userId || !title || !body) {
      return res.status(400).json({ error: 'userId, title and body are required' });
    }

    const tokensSnapshot = await db
      .collection('deviceTokens')
      .where('userId', '==', userId)
      .get();

    const tokens = tokensSnapshot.docs.map(doc => doc.data().token);

    if (tokens.length === 0) {
      return res.json({ 
        success: false, 
        message: 'User has no devices',
        successCount: 0,
        failureCount: 0,
      });
    }

    const message = {
      notification: { title, body },
      tokens,
    };

    const response = await messaging.sendEachForMulticast(message);

    // Lưu vào notificationHistory
    await db.collection('notificationHistory').add({
      title,
      body,
      targetType: 'user',
      targetIds: [userId],
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      totalDevices: tokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      readBy: [],
    });

    res.json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
      totalDevices: tokens.length,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Lên lịch thông báo
app.post('/api/notifications/schedule', authenticate, requireAdmin, async (req, res) => {
  try {
    const { title, body, scheduledTime, recurring } = req.body;

    if (!title || !body || !scheduledTime) {
      return res.status(400).json({ error: 'title, body and scheduledTime are required' });
    }

    const scheduledDate = new Date(scheduledTime);
    
    if (scheduledDate <= new Date()) {
      return res.status(400).json({ error: 'scheduledTime must be in the future' });
    }

    const notification = {
      title,
      body,
      scheduledTime: admin.firestore.Timestamp.fromDate(scheduledDate),
      status: 'pending',
      targetType: 'all',
      createdBy: req.user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      recurring: recurring || null,
    };

    const docRef = await db.collection('scheduledNotifications').add(notification);

    res.json({
      success: true,
      notificationId: docRef.id,
      message: 'Notification scheduled successfully',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Lấy danh sách thông báo đã lên lịch
app.get('/api/notifications/scheduled', authenticate, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status as string || 'pending';
    
    let query = db.collection('scheduledNotifications');
    
    if (status && status !== 'all') {
      query = query.where('status', '==', status) as any;
    }
    
    const snapshot = await query.orderBy('scheduledTime', 'asc').get();

    const notifications = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        scheduledTime: data.scheduledTime?.toDate()?.toISOString(),
        createdAt: data.createdAt?.toDate()?.toISOString(),
        sentAt: data.sentAt?.toDate()?.toISOString(),
      };
    });

    res.json(notifications);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Hủy thông báo đã lên lịch
app.patch('/api/notifications/scheduled/:id/cancel', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const docRef = db.collection('scheduledNotifications').doc(id);
    const doc = await docRef.get();
    
    if (!doc.exists) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    
    const data = doc.data();
    
    if (data?.status !== 'pending') {
      return res.status(400).json({ error: 'Can only cancel pending notifications' });
    }

    await docRef.update({ 
      status: 'cancelled',
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      cancelledBy: req.user.uid,
    });

    res.json({ success: true, message: 'Notification cancelled' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Xóa thông báo đã lên lịch
app.delete('/api/notifications/scheduled/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    await db.collection('scheduledNotifications').doc(id).delete();

    res.json({ success: true, message: 'Notification deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 7. Lấy lịch sử thông báo
app.get('/api/notifications/history', authenticate, async (req, res) => {
  try {
    const limitCount = parseInt(req.query.limit as string) || 100;
    
    const snapshot = await db
      .collection('notificationHistory')
      .orderBy('sentAt', 'desc')
      .limit(limitCount)
      .get();

    const history = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        sentAt: data.sentAt?.toDate()?.toISOString(),
      };
    });

    res.json(history);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 8. Xóa lịch sử thông báo
app.delete('/api/notifications/history/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    await db.collection('notificationHistory').doc(id).delete();

    res.json({ success: true, message: 'Notification history deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 9. Đánh dấu thông báo đã đọc
app.patch('/api/notifications/history/:id/read', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    const docRef = db.collection('notificationHistory').doc(id);
    
    await docRef.update({
      readBy: admin.firestore.FieldValue.arrayUnion(req.user.uid),
    });

    res.json({ success: true, message: 'Marked as read' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 10. Lấy thống kê thông báo
app.get('/api/notifications/stats', authenticate, requireAdmin, async (req, res) => {
  try {
    const [scheduledSnapshot, historySnapshot] = await Promise.all([
      db.collection('scheduledNotifications').get(),
      db.collection('notificationHistory').get(),
    ]);

    const scheduled = {
      total: scheduledSnapshot.size,
      pending: scheduledSnapshot.docs.filter(d => d.data().status === 'pending').length,
      sent: scheduledSnapshot.docs.filter(d => d.data().status === 'sent').length,
      failed: scheduledSnapshot.docs.filter(d => d.data().status === 'failed').length,
      cancelled: scheduledSnapshot.docs.filter(d => d.data().status === 'cancelled').length,
    };

    let totalDevices = 0;
    let totalSuccess = 0;
    let totalFailure = 0;

    historySnapshot.docs.forEach(doc => {
      const data = doc.data();
      totalDevices += data.totalDevices || 0;
      totalSuccess += data.successCount || 0;
      totalFailure += data.failureCount || 0;
    });

    const history = {
      total: historySnapshot.size,
      totalDevices,
      totalSuccess,
      totalFailure,
      successRate: totalDevices > 0 ? ((totalSuccess / totalDevices) * 100).toFixed(2) : 0,
    };

    res.json({
      scheduled,
      history,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ===== CRON JOB - Xử lý thông báo đã lên lịch =====
// Chạy mỗi phút
if (!process.env.VERCEL) {
  setInterval(async () => {
    try {
      const now = admin.firestore.Timestamp.now();
      
      const snapshot = await db
        .collection('scheduledNotifications')
        .where('status', '==', 'pending')
        .where('scheduledTime', '<=', now)
        .get();

      if (snapshot.empty) return;

      console.log(`📬 Processing ${snapshot.size} scheduled notifications...`);

      for (const doc of snapshot.docs) {
        const notification = doc.data();

        try {
          const tokensSnapshot = await db.collection('deviceTokens').get();
          const tokens = tokensSnapshot.docs.map(d => d.data().token);

          if (tokens.length === 0) {
            console.log(`⚠️  No devices for notification ${doc.id}`);
            await doc.ref.update({ status: 'failed', error: 'No devices registered' });
            continue;
          }

          // Gửi thông báo (batch 500)
          const batchSize = 500;
          let successCount = 0;
          let failureCount = 0;

          for (let i = 0; i < tokens.length; i += batchSize) {
            const batch = tokens.slice(i, i + batchSize);

            const message = {
              notification: {
                title: notification.title,
                body: notification.body,
              },
              tokens: batch,
            };

            const response = await messaging.sendEachForMulticast(message);
            successCount += response.successCount;
            failureCount += response.failureCount;
          }

          // Lưu vào history
          await db.collection('notificationHistory').add({
            title: notification.title,
            body: notification.body,
            targetType: notification.targetType,
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            totalDevices: tokens.length,
            successCount,
            failureCount,
            readBy: [],
            scheduledNotificationId: doc.id,
          });

          // Cập nhật status
          const updateData: any = {
            status: 'sent',
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            successCount,
            failureCount,
          };

          // Nếu là recurring, tính thời gian tiếp theo
          if (notification.recurring?.enabled) {
            const nextTime = calculateNextScheduledTime(
              notification.scheduledTime.toDate(),
              notification.recurring
            );
            updateData.scheduledTime = admin.firestore.Timestamp.fromDate(nextTime);
            updateData.status = 'pending';
          }

          await doc.ref.update(updateData);

          console.log(`✅ Sent notification ${doc.id}: ${successCount}/${tokens.length} devices`);
        } catch (error) {
          console.error(`❌ Error sending notification ${doc.id}:`, error);
          await doc.ref.update({
            status: 'failed',
            error: String(error),
            failedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    } catch (error) {
      console.error('❌ Cron job error:', error);
    }
  }, 60000); // Mỗi 60 giây

  console.log('⏰ Notification scheduler started (runs every 60 seconds)');
}

// Hàm tính thời gian tiếp theo cho recurring notification
function calculateNextScheduledTime(currentTime: Date, recurring: any): Date {
  const next = new Date(currentTime);

  if (recurring.frequency === 'daily') {
    next.setDate(next.getDate() + 1);
  } else if (recurring.frequency === 'weekly') {
    next.setDate(next.getDate() + 7);
  } else if (recurring.frequency === 'monthly') {
    next.setMonth(next.getMonth() + 1);
  }

  // Set time if specified
  if (recurring.time) {
    const [hours, minutes] = recurring.time.split(':');
    next.setHours(parseInt(hours), parseInt(minutes), 0, 0);
  }

  return next;
}

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date(),
    uptime: process.uptime(),
  });
});

// Ping endpoint
app.get('/ping', (req, res) => {
  res.json({ message: 'pong' });
});

const PORT = process.env.PORT || 3001;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 Health check: http://localhost:${PORT}/health`);
  });
}

export default app;
