// server/index.ts - Version with Offline Support
import express from 'express';
import cors from 'cors';
import * as admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Firebase
const initializeFirebase = () => {
  const base64ServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!base64ServiceAccount) {
    throw new Error('❌ FIREBASE_SERVICE_ACCOUNT_BASE64 not set');
  }

  const serviceAccountJson = Buffer.from(base64ServiceAccount, 'base64').toString('utf8');
  const serviceAccount = JSON.parse(serviceAccountJson);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log('✅ Firebase initialized');
};

initializeFirebase();

const app = express();
const db = admin.firestore();
const messaging = admin.messaging();

app.use(cors());
app.use(express.json());

// Auth middleware
async function authenticate(req: any, res: any, next: any) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error: any) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

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

// ===== HÀM GỬI THÔNG BÁO VỚI HỖ TRỢ OFFLINE =====
interface NotificationOptions {
  title: string;
  body: string;
  imageUrl?: string;
  clickAction?: string;
  data?: Record<string, string>;
}

async function sendNotificationWithOfflineSupport(
  tokens: string[],
  options: NotificationOptions
) {
  const { title, body, imageUrl, clickAction, data } = options;

  const batchSize = 500;
  let successCount = 0;
  let failureCount = 0;
  const failedTokens: string[] = [];

  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);

    // ✅ Cấu hình message với offline support
    const message: admin.messaging.MulticastMessage = {
      notification: {
        title,
        body,
        ...(imageUrl && { imageUrl }),
      },
      // 🔥 DATA PAYLOAD - Quan trọng cho offline
      data: {
        title,
        body,
        timestamp: new Date().toISOString(),
        notificationId: `notif_${Date.now()}`,
        ...(clickAction && { clickAction }),
        ...data,
      },
      // ⚙️ Android config
      android: {
        priority: 'high', // ✅ Priority cao để nhận khi offline
        ttl: 2419200000, // ✅ 4 weeks (28 days) in milliseconds
        notification: {
          sound: 'default',
          clickAction: clickAction || '/',
          channelId: 'default',
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      // ⚙️ APNS config (iOS - nếu có)
      apns: {
        payload: {
          aps: {
            alert: {
              title,
              body,
            },
            sound: 'default',
            badge: 1,
            contentAvailable: true, // ✅ Wake up app in background
          },
        },
        headers: {
          'apns-priority': '10', // ✅ High priority
          'apns-expiration': String(Math.floor(Date.now() / 1000) + 2419200), // 28 days
        },
      },
      // ⚙️ Web Push config
      webpush: {
        notification: {
          title,
          body,
          icon: '/favicon.ico',
          badge: '/badge-icon.png',
          ...(imageUrl && { image: imageUrl }),
          requireInteraction: true, // ✅ Notification không tự đóng
          tag: `notif_${Date.now()}`, // Group notifications
          renotify: true,
          vibrate: [200, 100, 200],
          actions: [
            {
              action: 'open',
              title: 'Mở',
            },
            {
              action: 'close',
              title: 'Đóng',
            },
          ],
        },
        headers: {
          TTL: '2419200', // ✅ 28 days in seconds
          Urgency: 'high', // ✅ High urgency
        },
        fcmOptions: {
          link: clickAction || '/',
        },
      },
      tokens: batch,
    };

    try {
      const response = await messaging.sendEachForMulticast(message);
      successCount += response.successCount;
      failureCount += response.failureCount;

      // Thu thập token lỗi
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errorCode = resp.error?.code;
          // Chỉ xóa token nếu là lỗi vĩnh viễn
          if (
            errorCode === 'messaging/invalid-registration-token' ||
            errorCode === 'messaging/registration-token-not-registered'
          ) {
            failedTokens.push(batch[idx]);
          }
          console.log(`❌ Token ${idx}: ${errorCode}`);
        }
      });
    } catch (error: any) {
      console.error('Batch send error:', error);
      failureCount += batch.length;
    }
  }

  // Xóa token không hợp lệ
  if (failedTokens.length > 0) {
    console.log(`🗑️  Removing ${failedTokens.length} invalid tokens`);
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

  return { successCount, failureCount, totalDevices: tokens.length };
}

// ===== API ENDPOINTS =====

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date(),
    firebase: admin.apps.length > 0 ? 'connected' : 'disconnected',
    features: ['offline-support', 'scheduled-notifications', 'ttl-28-days']
  });
});

// 1. Gửi thông báo đến tất cả (với offline support)
app.post('/api/notifications/send-all', authenticate, requireAdmin, async (req, res) => {
  try {
    const { title, body, imageUrl, clickAction, data } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body are required' });
    }

    console.log(`📨 Sending notification: "${title}"`);

    const tokensSnapshot = await db.collection('deviceTokens').get();
    const tokens = tokensSnapshot.docs.map(doc => doc.data().token);

    if (tokens.length === 0) {
      return res.json({ success: false, message: 'No devices registered' });
    }

    console.log(`📱 Sending to ${tokens.length} devices (with 28-day TTL)`);

    const result = await sendNotificationWithOfflineSupport(tokens, {
      title,
      body,
      imageUrl,
      clickAction,
      data,
    });

    // Lưu lịch sử
    await db.collection('notificationHistory').add({
      title,
      body,
      imageUrl: imageUrl || null,
      clickAction: clickAction || null,
      data: data || null,
      targetType: 'all',
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      // sentBy: req.user.uid,
      ...result,
    });

    console.log(`✅ Sent to ${result.successCount}/${result.totalDevices} devices`);
    console.log(`⏳ Messages valid for 28 days for offline devices`);

    res.json({
      success: true,
      message: `Sent to ${result.successCount}/${result.totalDevices} devices`,
      ...result,
      offlineSupport: {
        ttl: '28 days',
        priority: 'high',
        description: 'Offline devices will receive notification when they come online (within 28 days)'
      }
    });
  } catch (error: any) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Gửi thông báo đến user cụ thể
app.post('/api/notifications/send-to-user', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId, title, body, imageUrl, clickAction, data } = req.body;

    const tokensSnapshot = await db
      .collection('deviceTokens')
      .where('userId', '==', userId)
      .get();

    const tokens = tokensSnapshot.docs.map(doc => doc.data().token);

    if (tokens.length === 0) {
      return res.json({ success: false, message: 'User has no devices' });
    }

    const result = await sendNotificationWithOfflineSupport(tokens, {
      title,
      body,
      imageUrl,
      clickAction,
      data,
    });

    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Lên lịch thông báo
app.post('/api/notifications/schedule', authenticate, requireAdmin, async (req, res) => {
  try {
    const { title, body, scheduledTime, recurring, imageUrl, clickAction, data } = req.body;

    const notification = {
      title,
      body,
      imageUrl: imageUrl || null,
      clickAction: clickAction || null,
      data: data || null,
      scheduledTime: new Date(scheduledTime),
      status: 'pending',
      targetType: 'all',
      // createdBy: req.user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      recurring: recurring || null,
    };

    const docRef = await db.collection('scheduledNotifications').add(notification);

    res.json({ success: true, notificationId: docRef.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ===== 3.5. Xử lý gửi thông báo đã lên lịch (chuyển từ sendScheduledNotifications.ts) =====

// API endpoint để xử lý gửi thông báo đã lên lịch
app.get('/api/notifications/send-scheduled', authenticate, requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const snapshot = await db
      .collection('scheduledNotifications')
      .where('status', '==', 'pending')
      .where('scheduledTime', '<=', now)
      .get();

    if (snapshot.empty) {
      return res.status(200).json({ message: 'No scheduled notifications to send' });
    }

    console.log(`⏰ Processing ${snapshot.docs.length} scheduled notifications`);

    for (const doc of snapshot.docs) {
      const notification = doc.data();
      try {
        const tokensSnapshot = await db.collection('deviceTokens').get();
        const tokens = tokensSnapshot.docs.map((d) => d.data().token);

        if (tokens.length === 0) continue;

        const result = await sendNotificationWithOfflineSupport(tokens, {
          title: notification.title,
          body: notification.body,
          imageUrl: notification.imageUrl,
          clickAction: notification.clickAction,
          data: notification.data,
        });

        const updateData: any = {
          status: 'sent',
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          successCount: result.successCount,
          failureCount: result.failureCount,
        };

        if (notification.recurring?.enabled) {
          const nextTime = calculateNextScheduledTime(
            notification.scheduledTime.toDate(),
            notification.recurring
          );
          updateData.scheduledTime = admin.firestore.Timestamp.fromDate(nextTime);
          updateData.status = 'pending';
        }

        await doc.ref.update(updateData);
        console.log(`✅ Sent scheduled notification: ${doc.id}`);
      } catch (error) {
        console.error(`❌ Error: ${doc.id}`, error);
        await doc.ref.update({
          status: 'failed',
          error: String(error),
        });
      }
    }

    res.status(200).json({ message: 'Scheduled notifications processed successfully' });
  } catch (error) {
    console.error('Error processing scheduled notifications:', error);
    res.status(500).json({ error: 'Server error' });
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
      .update({ 
        status: 'cancelled',
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        // cancelledBy: req.user.uid
      });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ===== CRON JOB =====
setInterval(async () => {
  try {
    const now = new Date();
    
    const snapshot = await db
      .collection('scheduledNotifications')
      .where('status', '==', 'pending')
      .where('scheduledTime', '<=', now)
      .get();

    if (snapshot.empty) return;

    console.log(`⏰ Processing ${snapshot.docs.length} scheduled notifications`);

    for (const doc of snapshot.docs) {
      const notification = doc.data();

      try {
        const tokensSnapshot = await db.collection('deviceTokens').get();
        const tokens = tokensSnapshot.docs.map(d => d.data().token);

        if (tokens.length === 0) continue;

        const result = await sendNotificationWithOfflineSupport(tokens, {
          title: notification.title,
          body: notification.body,
          imageUrl: notification.imageUrl,
          clickAction: notification.clickAction,
          data: notification.data,
        });

        const updateData: any = {
          status: 'sent',
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          ...result,
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
        console.log(`✅ Sent scheduled notification: ${doc.id}`);
      } catch (error) {
        console.error(`❌ Error: ${doc.id}`, error);
        await doc.ref.update({
          status: 'failed',
          error: String(error),
        });
      }
    }
  } catch (error) {
    console.error('Cron error:', error);
  }
}, 60000);

function calculateNextScheduledTime(currentTime: Date, recurring: any): Date {
  const next = new Date(currentTime);
  if (recurring.frequency === 'daily') next.setDate(next.getDate() + 1);
  else if (recurring.frequency === 'weekly') next.setDate(next.getDate() + 7);
  else if (recurring.frequency === 'monthly') next.setMonth(next.getMonth() + 1);
  return next;
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 Notification Server (Offline Support)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🏥 Health: http://localhost:${PORT}/health`);
  console.log('⏳ TTL: 28 days for offline devices');
  console.log('🔔 Priority: High');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
