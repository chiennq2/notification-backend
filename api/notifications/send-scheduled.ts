import { processScheduledNotifications } from '../../lib/sendScheduledNotifications';

export default async function handler(req, res) {
if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const result = await processScheduledNotifications();
    return res.status(200).json(result);
  } catch (error) {
    console.error('Error processing scheduled notifications:', error);
    return res.status(500).json({ error: 'Server error' });
  }
}
