export const config = {
  // Wszystkie ścieżki oprócz static assets builda Angulara.
  matcher: '/((?!_next/|favicon.ico|.well-known/).*)',
};

const REALM = 'Sprint Board';

export default function middleware(request: Request): Response | undefined {
  const user = process.env['DEMO_USER'] ?? '';
  const pass = process.env['DEMO_PASS'] ?? '';

  if (!user || !pass) {
    return new Response('Auth not configured', { status: 500 });
  }

  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) {
    return unauthorized();
  }

  let decoded: string;
  try {
    decoded = atob(header.slice('Basic '.length));
  } catch {
    return unauthorized();
  }

  const idx = decoded.indexOf(':');
  if (idx < 0) return unauthorized();

  const u = decoded.slice(0, idx);
  const p = decoded.slice(idx + 1);
  if (u !== user || p !== pass) return unauthorized();

  return undefined;
}

function unauthorized(): Response {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
    },
  });
}
