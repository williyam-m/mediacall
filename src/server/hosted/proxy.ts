import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IceConfig } from '../../shared/types.ts';

const ROUTES = new Set(['/api/config', '/api/health', '/api/ice', '/api/relay']);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

function backendUrl(value: string | undefined): URL | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return;
    return url;
  } catch { return; }
}

function isIceConfig(value: unknown): value is IceConfig {
  return Boolean(value && typeof value === 'object' && 'iceServers' in value && Array.isArray(value.iceServers) &&
    'expiresAt' in value && typeof value.expiresAt === 'number');
}

export function createCallApiProxy(origin: string | undefined, fetchBackend: typeof fetch = fetch) {
  const backend = backendUrl(origin);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', 'https://frontend.invalid').pathname; }
    catch { json(response, 400, { error: 'Invalid request.' }); return; }
    if (!ROUTES.has(pathname)) { json(response, 404, { error: 'Not found.' }); return; }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      json(response, 405, { error: 'Method not allowed.' });
      return;
    }
    if (!backend) {
      json(response, 503, { error: 'The call backend is not configured for this deployment.', status: 'unconfigured', relay: 'offline' });
      return;
    }
    const headers = new Headers({ Accept: 'application/json' });
    if (request.headers.authorization) headers.set('Authorization', request.headers.authorization);
    try {
      const upstream = await fetchBackend(new URL(pathname, backend), {
        method: 'GET', headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
      });
      if (upstream.status >= 300 && upstream.status < 400) throw new Error('Backend redirects are not allowed');
      const body: unknown = await upstream.json();
      if (pathname === '/api/ice' && upstream.ok) {
        if (!isIceConfig(body)) throw new Error('Invalid ICE configuration');
        const signaling = new URL('/signal', backend);
        signaling.protocol = 'wss:';
        json(response, upstream.status, { ...body, signalingUrl: signaling.href } satisfies IceConfig);
      } else {
        json(response, upstream.status, body);
      }
    } catch {
      json(response, 502, { error: 'The call backend is unreachable. Try again shortly.', status: 'unavailable', relay: 'offline' });
    }
  };
}

export async function proxyCallApi(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (process.env['CALL_BACKEND'] === 'hosted') {
    const { hostedCallApi } = await import('./api.ts');
    await hostedCallApi(request, response);
    return;
  }
  await createCallApiProxy(process.env['BACKEND_URL'])(request, response);
}