import { IncomingMessage, ServerResponse } from 'http';
import * as admin from 'firebase-admin';
import calculateNextScheduledTime from '../src/sendScheduledNotifications';
import sendNotificationWithOfflineSupport from '../src/sendScheduledNotifications';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // Chuyển kiểu `res` thành `NextApiResponse` (kiểu được hỗ trợ trên Vercel)
  const response = res as any;

  if (req.method === 'GET') {
    try {
      const now = new Date();
      const snapshot = await admin.firestore()
        .collection('scheduledNotifications')
        .where('status', '==', 'pending')
        .where('scheduledTime', '<=', now)
        .get();

      if (snapshot.empty) {
        return response.status(200).json({ message: 'No scheduled notifications to send' });
      }

      console.log(`⏰ Processing ${snapshot.docs.length} scheduled notifications`);

      for (const doc of snapshot.docs) {
        const notification = doc.data();
        try {
          const tokensSnapshot = await admin.firestore().collection('deviceTokens').get();
          const tokens = tokensSnapshot.docs.map(d => d.data().token);

          if (tokens.length === 0) continue;

          const result = await sendNotificationWithOfflineSupport(tokens, {
            title: notification.title,
            body: notification.body,
            imageUrl: notification.imageUrl,
            clickAction: notification.clickAction,
            data: notification.data,
          });

          const updateData: {
            status: string;
            sentAt: admin.firestore.FieldValue;
            successCount: any;
            failureCount: any;
            scheduledTime?: admin.firestore.Timestamp;
          } = {
            status: 'sent',
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            successCount: result.successCount,
            failureCount: result.failureCount,
          };

          if (notification.recurring?.enabled) {
            const nextTime = await calculateNextScheduledTime(notification.scheduledTime.toDate(), notification.recurring);
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

      response.status(200).json({ message: 'Scheduled notifications processed successfully' });
    } catch (error) {
      console.error('Error processing scheduled notifications:', error);
      response.status(500).json({ error: 'Server error' });
    }
  } else {
    response.status(405).json({ error: 'Method Not Allowed' });
  }
}
