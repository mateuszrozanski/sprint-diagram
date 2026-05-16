import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env['KV_REST_API_URL']   ?? '',
  token: process.env['KV_REST_API_TOKEN'] ?? '',
});

const KEY_PREFIX = 'sprint-board:';
const DEFAULT_BOARD = 'current';
const SNAPSHOT_PREFIX = 'sprint-snapshot:';

function keyFor(req: VercelRequest): string {
  const board = String(req.query['board'] ?? DEFAULT_BOARD).slice(0, 64);
  return KEY_PREFIX + (board || DEFAULT_BOARD);
}

function isoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!process.env['KV_REST_API_URL'] || !process.env['KV_REST_API_TOKEN']) {
    return res.status(500).json({ error: 'KV not configured' });
  }

  const key = keyFor(req);

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '', 'http://x');
      const snapshotDate = url.searchParams.get('snapshot');
      if (snapshotDate) {
        const snap = await redis.get(SNAPSHOT_PREFIX + snapshotDate);
        return res.status(200).json({ state: snap ?? null, snapshotDate });
      }
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

      // Daily snapshot — pierwszy POST danego dnia tworzy snapshot pod sprint-snapshot:YYYY-MM-DD.
      // Snapshoty trzymamy 30 dni (EX 2592000s).
      const today = isoDate();
      const snapKey = SNAPSHOT_PREFIX + today;
      const existing = await redis.get(snapKey);
      if (!existing) {
        await redis.set(snapKey, payload, { ex: 60 * 60 * 24 * 30 });
      }

      return res.status(200).json({ ok: true, updatedAt: payload.updatedAt });
    }

    // GET /api/state?snapshots=list → ostatnie 14 dni dostępnych snapshotów
    if (req.method === 'GET' && new URL(req.url ?? '', 'http://x').searchParams.get('snapshots') === 'list') {
      // Iterate przez ostatnie 30 dni i sprawdzaj które istnieją
      const days: string[] = [];
      const now = new Date();
      for (let i = 0; i < 30; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const key2 = SNAPSHOT_PREFIX + isoDate(d);
        const exists = await redis.exists(key2);
        if (exists) days.push(isoDate(d));
      }
      return res.status(200).json({ days });
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
