import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env['KV_REST_API_URL']   ?? '',
  token: process.env['KV_REST_API_TOKEN'] ?? '',
});

const KEY_PREFIX = 'sprint-board:';
const DEFAULT_BOARD = 'current';

function keyFor(req: VercelRequest): string {
  const board = String(req.query['board'] ?? DEFAULT_BOARD).slice(0, 64);
  return KEY_PREFIX + (board || DEFAULT_BOARD);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!process.env['KV_REST_API_URL'] || !process.env['KV_REST_API_TOKEN']) {
    return res.status(500).json({ error: 'KV not configured' });
  }

  const key = keyFor(req);

  try {
    if (req.method === 'GET') {
      const data = await redis.get(key);
      return res.status(200).json({ state: data ?? null });
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'Body must be a JSON object' });
      }
      const payload = { ...body, updatedAt: new Date().toISOString() };
      const json = JSON.stringify(payload);
      if (json.length > 1_000_000) {
        return res.status(413).json({ error: 'State too large (>1MB)' });
      }
      await redis.set(key, payload);
      return res.status(200).json({ ok: true, updatedAt: payload.updatedAt });
    }

    if (req.method === 'DELETE') {
      await redis.del(key);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? 'Redis error' });
  }
}
