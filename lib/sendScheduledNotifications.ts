import { db, messaging, FieldValue, Timestamp } from './firebaseAdmin';
import calculateNextScheduledTime from '../src/sendScheduledNotifications';
import sendNotificationWithOfflineSupport from '../src/sendScheduledNotifications';

export async function processScheduledNotifications() {
  const now = new Date();
  const snapshot = await db
    .collection('scheduledNotifications')
    .where('status', '==', 'pending')
    .where('scheduledTime', '<=', now)
    .get();

  if (snapshot.empty) {
    console.log('⏰ No scheduled notifications to send');
    return { success: true, message: 'No scheduled notifications to send' };
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
        sentAt: FieldValue.serverTimestamp(),
        successCount: result.successCount,
        failureCount: result.failureCount,
      };

      if (notification.recurring?.enabled) {
        const nextTime = await calculateNextScheduledTime(notification.scheduledTime.toDate(), notification.recurring);
        updateData.scheduledTime = Timestamp.fromDate(nextTime);
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

  return { success: true, message: 'Scheduled notifications processed successfully' };
}
