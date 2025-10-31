import type { NextApiRequest, NextApiResponse } from 'next';
import { processScheduledNotifications } from '@/lib/sendScheduledNotifications';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
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
