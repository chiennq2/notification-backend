import * as admin from 'firebase-admin';

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// Hàm hỗ trợ gửi thông báo (với offline support)
async function sendNotificationWithOfflineSupport(tokens, options) {
  const { title, body, imageUrl, clickAction, data } = options;
  const batchSize = 500;
  let successCount = 0;
  let failureCount = 0;
  const failedTokens = [];

  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);

    const message = {
      notification: { title, body, ...(imageUrl && { imageUrl }) },
      data: {
        title,
        body,
        timestamp: new Date().toISOString(),
        notificationId: `notif_${Date.now()}`,
        ...(clickAction && { clickAction }),
        ...data,
      },
      android: {
        priority: "high" as "high" | "normal",
        ttl: 2419200000, // 28 days
        notification: {
          sound: 'default',
          clickAction: clickAction || '/',
          channelId: 'default',
        },
      },
      apns: {
        payload: {
          aps: {
            alert: { title, body },
            sound: 'default',
            badge: 1,
            contentAvailable: true,
          },
        },
        headers: { 'apns-priority': '10' },
      },
      webpush: {
        notification: {
          title,
          body,
          icon: '/favicon.ico',
          badge: '/badge-icon.png',
          ...(imageUrl && { image: imageUrl }),
          requireInteraction: true,
        },
        headers: { TTL: '2419200', Urgency: 'high' },
      },
      tokens: batch,
    };

    try {
      const response = await messaging.sendEachForMulticast(message);
      successCount += response.successCount;
      failureCount += response.failureCount;

      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errorCode = resp.error?.code;
          if (errorCode === 'messaging/invalid-registration-token' ||
              errorCode === 'messaging/registration-token-not-registered') {
            failedTokens.push(batch[idx]);
          }
        }
      });
    } catch (error) {
      failureCount += batch.length;
    }
  }

  if (failedTokens.length > 0) {
    await Promise.all(
      failedTokens.map(async (token) => {
        const snapshot = await db.collection('deviceTokens').where('token', '==', token).get();
        return Promise.all(snapshot.docs.map(doc => doc.ref.delete()));
      })
    );
  }

  return { successCount, failureCount, totalDevices: tokens.length };
}

// Hàm tính toán thời gian tiếp theo cho lịch gửi thông báo
function calculateNextScheduledTime(currentTime, recurring) {
  const next = new Date(currentTime);
  if (recurring.frequency === 'daily') next.setDate(next.getDate() + 1);
  else if (recurring.frequency === 'weekly') next.setDate(next.getDate() + 7);
  else if (recurring.frequency === 'monthly') next.setMonth(next.getMonth() + 1);
  return next;
}

// API function để xử lý gửi thông báo đã lên lịch
export default async function handler(req, res) {
  if (req.method === 'GET') {
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
          const tokens = tokensSnapshot.docs.map(d => d.data().token);

          if (tokens.length === 0) continue;

          const result = await sendNotificationWithOfflineSupport(tokens, {
            title: notification.title,
            body: notification.body,
            imageUrl: notification.imageUrl,
            clickAction: notification.clickAction,
            data: notification.data,
          });

          let updateData: {
            status: string;
            sentAt: admin.firestore.FieldValue;
            successCount: number;
            failureCount: number;
            scheduledTime?: admin.firestore.Timestamp;
            [key: string]: any;
          } = {
            status: 'sent',
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            successCount: result.successCount,
            failureCount: result.failureCount,
          };

          // Nếu thông báo có chế độ lặp lại (recurring)
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
  } else {
    res.status(405).json({ error: 'Method Not Allowed' });
  }
}
