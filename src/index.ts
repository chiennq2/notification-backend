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

// 1. Gửi thông báo đến tất cả
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
      });
    }

    // Gửi thông báo (batch 500 tokens)
    const batchSize = 500;
    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);

      const message = {
        notification: { title, body },
        tokens: batch,
      };

      const response = await messaging.sendEachForMulticast(message);
      successCount += response.successCount;
      failureCount += response.failureCount;

      // Xóa token không hợp lệ
      if (response.failureCount > 0) {
        const failedTokens: string[] = [];
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            failedTokens.push(batch[idx]);
          }
        });

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
    }

    // Lưu lịch sử
    await db.collection('notificationHistory').add({
      title,
      body,
      targetType: 'all',
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      // sentBy: req.user.uid,
      totalDevices: tokens.length,
      successCount,
      failureCount,
    });

    res.json({
      success: true,
      message: `Sent to ${successCount}/${tokens.length} devices`,
      successCount,
      failureCount,
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

    const tokensSnapshot = await db
      .collection('deviceTokens')
      .where('userId', '==', userId)
      .get();

    const tokens = tokensSnapshot.docs.map(doc => doc.data().token);

    if (tokens.length === 0) {
      return res.json({ success: false, message: 'User has no devices' });
    }

    const message = {
      notification: { title, body },
      tokens,
    };

    const response = await messaging.sendEachForMulticast(message);

    res.json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Lên lịch thông báo
app.post('/api/notifications/schedule', authenticate, requireAdmin, async (req, res) => {
  try {
    const { title, body, scheduledTime, recurring } = req.body;

    const notification = {
      title,
      body,
      scheduledTime: new Date(scheduledTime),
      status: 'pending',
      targetType: 'all',
      // createdBy: req.user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      recurring: recurring || null,
    };

    const docRef = await db.collection('scheduledNotifications').add(notification);

    res.json({
      success: true,
      notificationId: docRef.id,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Lấy danh sách thông báo đã lên lịch
app.get('/api/notifications/scheduled', authenticate, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db
      .collection('scheduledNotifications')
      .where('status', '==', 'pending')
      .orderBy('scheduledTime', 'asc')
      .get();

    const notifications = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(notifications);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Hủy thông báo đã lên lịch
app.delete('/api/notifications/scheduled/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await db
      .collection('scheduledNotifications')
      .doc(req.params.id)
      .update({ status: 'cancelled' });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ===== CRON JOB - Xử lý thông báo đã lên lịch =====
// Chạy mỗi phút
if (!process.env.VERCEL) {
  setInterval(async () => {
    try {
      const now = new Date();
      
      const snapshot = await db
        .collection('scheduledNotifications')
        .where('status', '==', 'pending')
        .where('scheduledTime', '<=', now)
        .get();

      if (snapshot.empty) return;

      for (const doc of snapshot.docs) {
        const notification = doc.data();

        try {
          const tokensSnapshot = await db.collection('deviceTokens').get();
          const tokens = tokensSnapshot.docs.map(d => d.data().token);

          if (tokens.length === 0) continue;

          const message = {
            notification: {
              title: notification.title,
              body: notification.body,
            },
            tokens,
          };

          const response = await messaging.sendEachForMulticast(message);

          const updateData: any = {
            status: 'sent',
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            successCount: response.successCount,
            failureCount: response.failureCount,
          };

          if (notification.recurring?.enabled) {
            const nextTime = calculateNextScheduledTime(
              notification.scheduledTime.toDate(),
              notification.recurring
            );
            updateData.scheduledTime = nextTime;
            updateData.status = 'pending';
          }

          await doc.ref.update(updateData);

          console.log(`✅ Sent notification: ${doc.id}`);
        } catch (error) {
          console.error(`❌ Error sending notification ${doc.id}:`, error);
          await doc.ref.update({
            status: 'failed',
            error: String(error),
          });
        }
      }
    } catch (error) {
      console.error('Cron job error:', error);
    }
  }, 60000);
}

// Hàm tính thời gian tiếp theo
function calculateNextScheduledTime(currentTime: Date, recurring: any): Date {
  const next = new Date(currentTime);

  if (recurring.frequency === 'daily') {
    next.setDate(next.getDate() + 1);
  } else if (recurring.frequency === 'weekly') {
    next.setDate(next.getDate() + 7);
  } else if (recurring.frequency === 'monthly') {
    next.setMonth(next.getMonth() + 1);
  }

  return next;
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

const PORT = process.env.PORT || 3001;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

export default app;
