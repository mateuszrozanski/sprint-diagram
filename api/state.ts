import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env['KV_REST_API_URL']   ?? '',
  token: process.env['KV_REST_API_TOKEN'] ?? '',
});

const LIVE_KEY      = 'sprint-board:live';
const WHATIF_KEY    = 'sprint-board:whatif';
const SCENARIO_PFX  = 'sprint-scenario:';
const SNAPSHOT_PFX  = 'sprint-snapshot:';

const WHATIF_TTL_SEC = 4 * 60 * 60;          // 4h auto-reset
const SCENARIO_TTL   = 60 * 60 * 24 * 30;    // 30d
const SNAPSHOT_TTL   = 60 * 60 * 24 * 30;

function isoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function badName(name: string): string | null {
  if (!name) return 'empty';
  if (name.length > 64) return 'too long';
  if (!/^[a-zA-Z0-9 _-]+$/.test(name)) return 'invalid chars';
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!process.env['KV_REST_API_URL'] || !process.env['KV_REST_API_TOKEN']) {
    return res.status(500).json({ error: 'KV not configured' });
  }

  const url = new URL(req.url ?? '', 'http://x');
  const mode = url.searchParams.get('mode');                // 'live' | 'whatif'
  const snapshot = url.searchParams.get('snapshot');        // YYYY-MM-DD → snapshot read
  const scenariosList = url.searchParams.get('scenarios');  // 'list'
  const scenario = url.searchParams.get('scenario');        // <name>
  const saveScenarioAs = url.searchParams.get('save-scenario'); // <name>

  try {
    // ── GET ────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (snapshot) {
        const snap = await redis.get(SNAPSHOT_PFX + snapshot);
        return res.status(200).json({ state: snap ?? null, snapshotDate: snapshot });
      }
      if (scenariosList === 'list') {
        // skanujemy wszystkie scenario keys
        const keys: string[] = [];
        let cursor = 0;
        for (let i = 0; i < 10; i++) {
          const [nextCursor, batch] = await redis.scan(cursor, { match: SCENARIO_PFX + '*', count: 100 });
          for (const k of batch as string[]) keys.push(k.replace(SCENARIO_PFX, ''));
          cursor = Number(nextCursor);
          if (!cursor) break;
        }
        return res.status(200).json({ scenarios: keys.sort() });
      }
      if (scenario) {
        const data = await redis.get(SCENARIO_PFX + scenario);
        return res.status(200).json({ state: data ?? null, scenario });
      }
      if (url.searchParams.get('snapshots') === 'list') {
        const days: string[] = [];
        const now = new Date();
        for (let i = 0; i < 30; i++) {
          const d = new Date(now);
          d.setDate(d.getDate() - i);
          const k = SNAPSHOT_PFX + isoDate(d);
          if (await redis.exists(k)) days.push(isoDate(d));
        }
        return res.status(200).json({ days });
      }

      // Default: zwróć cały stan { live, whatif, whatifAge }
      const live = await redis.get(LIVE_KEY);
      const whatif = await redis.get<any>(WHATIF_KEY);
      let whatifAgeSec: number | null = null;
      if (whatif?.updatedAt) {
        whatifAgeSec = Math.round((Date.now() - new Date(whatif.updatedAt).getTime()) / 1000);
      }
      return res.status(200).json({ live: live ?? null, whatif: whatif ?? null, whatifAgeSec });
    }

    // ── POST ───────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = req.body;
      if (!body || typeof body !== 'object') return res.status(400).json({ error: 'bad body' });
      const payload = { ...body, updatedAt: new Date().toISOString() };
      const json = JSON.stringify(payload);
      if (json.length > 1_000_000) return res.status(413).json({ error: 'State too large (>1MB)' });

      if (saveScenarioAs) {
        const err = badName(saveScenarioAs);
        if (err) return res.status(400).json({ error: 'Bad scenario name: ' + err });
        await redis.set(SCENARIO_PFX + saveScenarioAs, payload, { ex: SCENARIO_TTL });
        return res.status(200).json({ ok: true, scenario: saveScenarioAs });
      }

      if (mode === 'whatif') {
        await redis.set(WHATIF_KEY, payload, { ex: WHATIF_TTL_SEC });
        return res.status(200).json({ ok: true, updatedAt: payload.updatedAt });
      }

      // Default = 'live' (Load from ADO writes here)
      await redis.set(LIVE_KEY, payload);

      // Daily snapshot (pierwszy POST danego dnia)
      const today = isoDate();
      const snapKey = SNAPSHOT_PFX + today;
      if (!(await redis.exists(snapKey))) {
        await redis.set(snapKey, payload, { ex: SNAPSHOT_TTL });
      }
      return res.status(200).json({ ok: true, updatedAt: payload.updatedAt });
    }

    // ── DELETE ─────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (scenario) {
        const err = badName(scenario);
        if (err) return res.status(400).json({ error: 'Bad scenario name: ' + err });
        await redis.del(SCENARIO_PFX + scenario);
        return res.status(200).json({ ok: true, scenario });
      }
      if (mode === 'whatif') {
        await redis.del(WHATIF_KEY);
        return res.status(200).json({ ok: true });
      }
      // Old behavior — pełny reset (live + whatif)
      await redis.del(LIVE_KEY);
      await redis.del(WHATIF_KEY);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? 'Redis error' });
  }
}
