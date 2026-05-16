import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env['KV_REST_API_URL']   ?? '',
  token: process.env['KV_REST_API_TOKEN'] ?? '',
});

const KEY = 'sprint-audit';
const MAX_ENTRIES = 200;

interface AuditEntry {
  ts: string;           // ISO timestamp
  who: string;          // best-effort user (e.g. DEMO_USER session, browser fingerprint, or 'anon')
  what: string;         // krótki opis akcji
  cardId?: string;
  before?: string;
  after?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!process.env['KV_REST_API_URL'] || !process.env['KV_REST_API_TOKEN']) {
    return res.status(500).json({ error: 'KV not configured' });
  }

  try {
    if (req.method === 'GET') {
      const data = await redis.get<AuditEntry[]>(KEY);
      return res.status(200).json({ entries: data ?? [] });
    }

    if (req.method === 'POST') {
      const body = req.body;
      if (!body || typeof body !== 'object') return res.status(400).json({ error: 'bad body' });
      const entry: AuditEntry = {
        ts:     new Date().toISOString(),
        who:    String(body.who ?? 'anon').slice(0, 64),
        what:   String(body.what ?? '').slice(0, 200),
        cardId: body.cardId ? String(body.cardId).slice(0, 100) : undefined,
        before: body.before ? String(body.before).slice(0, 200) : undefined,
        after:  body.after  ? String(body.after).slice(0, 200)  : undefined,
      };
      const existing = (await redis.get<AuditEntry[]>(KEY)) ?? [];
      existing.unshift(entry);
      const trimmed = existing.slice(0, MAX_ENTRIES);
      await redis.set(KEY, trimmed);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? 'Redis error' });
  }
}
