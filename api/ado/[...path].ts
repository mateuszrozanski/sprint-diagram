import type { VercelRequest, VercelResponse } from '@vercel/node';

// ── Config ────────────────────────────────────────────────────────────────────
const ADO_ORG     = process.env['ADO_ORG']        ?? '';
const ADO_PROJECT = process.env['ADO_PROJECT']    ?? '';
const ADO_TEAM    = process.env['ADO_TEAM']       ?? '';
const ADO_ITER    = process.env['ADO_ITERATION']  ?? '';
const ADO_AREA    = process.env['ADO_AREA_PATH']  ?? '';
const ADO_PAT     = process.env['ADO_PAT']        ?? '';
const API_VER     = process.env['ADO_API_VERSION'] ?? '7.1';

const QA_TESTERS  = (process.env['ADO_QA_TESTERS'] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Lista wszystkich devów w sprincie (display names CSV) — żeby na board byli widoczni
// nawet bez przypisanych tasków. Bez tego osoby bez tasków znikają.
const DEVS = (process.env['ADO_DEVS'] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const DEMO_USER   = process.env['DEMO_USER']      ?? '';
const DEMO_PASS   = process.env['DEMO_PASS']      ?? '';

const ADO_BASE      = `https://dev.azure.com/${encodeURIComponent(ADO_ORG)}/${encodeURIComponent(ADO_PROJECT)}/_apis/wit`;
const ADO_WORK_BASE = `https://dev.azure.com/${encodeURIComponent(ADO_ORG)}/${encodeURIComponent(ADO_PROJECT)}/${encodeURIComponent(ADO_TEAM)}/_apis/work`;
const AUTH_HEADER_VALUE = 'Basic ' + Buffer.from(`:${ADO_PAT}`).toString('base64');

// ── Basic Auth gate ───────────────────────────────────────────────────────────
function unauthorized(res: VercelResponse) {
  res.setHeader('WWW-Authenticate', 'Basic realm="Sprint Diagram", charset="UTF-8"');
  res.status(401).json({ error: 'Authentication required' });
}

function checkBasicAuth(req: VercelRequest, res: VercelResponse): boolean {
  if (!DEMO_USER || !DEMO_PASS) {
    res.status(500).json({ error: 'Auth not configured (DEMO_USER/DEMO_PASS missing)' });
    return false;
  }
  const header = req.headers['authorization'] ?? '';
  if (!header.startsWith('Basic ')) {
    unauthorized(res);
    return false;
  }
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx < 0) {
    unauthorized(res);
    return false;
  }
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  if (user !== DEMO_USER || pass !== DEMO_PASS) {
    unauthorized(res);
    return false;
  }
  return true;
}

// ── ADO helpers ───────────────────────────────────────────────────────────────
async function adoFetch(path: string, init: RequestInit = {}, base: string = ADO_BASE): Promise<any> {
  const url = `${base}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Authorization': AUTH_HEADER_VALUE,
      'Accept':        'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    const err: any = new Error(`ADO ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function buildSprintWiql(): { query: string } {
  const iterClause = ADO_ITER
    ? `[System.IterationPath] = '${ADO_ITER.replace(/'/g, "''")}'`
    : (ADO_TEAM
        ? `[System.IterationPath] = @CurrentIteration('[${ADO_PROJECT}]\\${ADO_TEAM}')`
        : `[System.IterationPath] = @CurrentIteration`);
  const areaClause = ADO_AREA
    ? ` AND [System.AreaPath] UNDER '${ADO_AREA.replace(/'/g, "''")}'`
    : '';
  return {
    query:
      `SELECT [System.Id] FROM WorkItems ` +
      `WHERE [System.TeamProject] = '${ADO_PROJECT.replace(/'/g, "''")}' ` +
      `AND [System.WorkItemType] IN ('User Story','Product Backlog Item','Bug') ` +
      `AND [System.State] NOT IN ('Closed','Done','Resolved','Removed','Rejected') ` +
      `AND ${iterClause}` +
      areaClause,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!checkBasicAuth(req, res)) return;

  const missing: string[] = [];
  if (!ADO_ORG)     missing.push('ADO_ORG');
  if (!ADO_PROJECT) missing.push('ADO_PROJECT');
  if (!ADO_PAT)     missing.push('ADO_PAT');
  if (missing.length) {
    return res.status(500).json({ error: `Server misconfigured, missing env: ${missing.join(', ')}` });
  }

  // Parsuj ścieżkę z req.url zamiast z req.query.path — bardziej niezawodne
  // niż dynamic segment dla non-Next Vercel Function.
  const rawPath = (req.url ?? '').split('?')[0];
  const after   = rawPath.replace(/^\/api\/ado\/?/, '');
  const segments = after.split('/').filter(Boolean);
  const route    = segments.join('/');

  try {
    // POST /api/ado/wiql — listę PBI buduje serwer (ignorujemy ciało klienta)
    if (route === 'wiql' && req.method === 'POST') {
      const data = await adoFetch(`/wiql?api-version=${API_VER}`, {
        method: 'POST',
        body:   JSON.stringify(buildSprintWiql()),
      });
      return res.status(200).json(data);
    }

    // GET /api/ado/workitems?ids=1,2,3
    if (route === 'workitems' && req.method === 'GET') {
      const ids = String(req.query['ids'] ?? '');
      if (!/^[\d,]+$/.test(ids)) {
        return res.status(400).json({ error: 'Invalid ids parameter' });
      }
      const expand = String(req.query['$expand'] ?? 'relations');
      if (!/^[a-zA-Z]+$/.test(expand)) {
        return res.status(400).json({ error: 'Invalid $expand parameter' });
      }
      const data = await adoFetch(
        `/workitems?ids=${ids}&$expand=${expand}&api-version=${API_VER}`,
      );
      return res.status(200).json(data);
    }

    // GET /api/ado/iteration → current iteration metadata (startDate, finishDate)
    if (route === 'iteration' && req.method === 'GET') {
      if (!ADO_TEAM) {
        return res.status(500).json({ error: 'ADO_TEAM not configured — required for iteration lookup' });
      }
      const data = await adoFetch(
        `/teamsettings/iterations?$timeframe=current&api-version=${API_VER}`,
        {},
        ADO_WORK_BASE,
      );
      const it = data.value?.[0];
      if (!it) {
        return res.status(404).json({ error: 'No current iteration found for team ' + ADO_TEAM });
      }
      return res.status(200).json({
        id:         it.id,
        name:       it.name,
        path:       it.path,
        startDate:  it.attributes?.startDate ?? null,
        finishDate: it.attributes?.finishDate ?? null,
        qaTesters:  QA_TESTERS,
        devs:       DEVS,
      });
    }

    // GET /api/ado/workitems/:id
    if (segments[0] === 'workitems' && segments.length === 2 && req.method === 'GET') {
      const id = segments[1];
      if (!/^\d+$/.test(String(id))) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const data = await adoFetch(`/workitems/${id}?$expand=relations&api-version=${API_VER}`);
      return res.status(200).json(data);
    }

    return res.status(404).json({ error: `Unknown route: ${req.method} ${route}`, debug: { url: req.url, segments } });
  } catch (e: any) {
    return res.status(e.status ?? 500).json({ error: e.message });
  }
}
