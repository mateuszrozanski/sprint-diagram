import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env['KV_REST_API_URL']   ?? '',
  token: process.env['KV_REST_API_TOKEN'] ?? '',
});

const KEY = 'sprint-comments';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!process.env['KV_REST_API_URL'] || !process.env['KV_REST_API_TOKEN']) {
    return res.status(500).json({ error: 'KV not configured' });
  }

  try {
    if (req.method === 'GET') {
      const data = await redis.get<Record<string, { text: string; author: string; updatedAt: string }>>(KEY);
      return res.status(200).json({ comments: data ?? {} });
    }

    if (req.method === 'POST') {
      const body = req.body;
      if (!body || typeof body !== 'object' || !body.cardId) {
        return res.status(400).json({ error: 'Body needs cardId' });
      }
      const existing = (await redis.get<Record<string, any>>(KEY)) ?? {};
      const cardId = String(body.cardId).slice(0, 100);
      const text = String(body.text ?? '').slice(0, 1000);
      const author = String(body.author ?? 'anonymous').slice(0, 64);
      if (!text.trim()) {
        delete existing[cardId];
      } else {
        existing[cardId] = { text, author, updatedAt: new Date().toISOString() };
      }
      await redis.set(KEY, existing);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? 'Redis error' });
  }
}
