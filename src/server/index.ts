import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { TurnServer } from './turn/server.ts';
import { validAccessToken } from './turn/auth.ts';
import { SignalingServer } from './signaling.ts';
import { IpLimiter } from './limits.ts';

const production = process.argv.includes('--production');
const env = process.env;
function integer(name: string, fallback: number, min = 1, max = 65535): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

if (production && (!env['TURN_SECRET'] || env['TURN_SECRET'].length < 32)) throw new Error('Production requires a TURN_SECRET of at least 32 characters');
if (production && (!env['TURN_PUBLIC_IP'] || env['TURN_PUBLIC_IP'] === '127.0.0.1')) throw new Error('Production requires your routable TURN_PUBLIC_IP');
if (production && !env['APP_ACCESS_TOKEN'] && env['ALLOW_ANONYMOUS'] !== 'true') throw new Error('Set APP_ACCESS_TOKEN or explicitly opt into ALLOW_ANONYMOUS=true');
if (env['APP_ACCESS_TOKEN'] && env['APP_ACCESS_TOKEN'].length < 24) throw new Error('APP_ACCESS_TOKEN must have at least 24 characters');
if (Boolean(env['TURN_TLS_CERT']) !== Boolean(env['TURN_TLS_KEY'])) throw new Error('Set both TURN_TLS_CERT and TURN_TLS_KEY');

const turnBindIp = env['TURN_BIND_IP'] ?? ((!env['TURN_PUBLIC_IP'] || env['TURN_PUBLIC_IP'] === '127.0.0.1') ? '127.0.0.1' : '0.0.0.0');
const allowPrivatePeers = env['TURN_ALLOW_PRIVATE_PEERS'] === 'true' || (!production && env['TURN_ALLOW_PRIVATE_PEERS'] !== 'false');
const accessToken = env['APP_ACCESS_TOKEN'] || undefined;
const turn = new TurnServer({
  secret: env['TURN_SECRET'] || randomBytes(32).toString('hex'),
  publicAddress: env['TURN_PUBLIC_IP'] ?? '127.0.0.1',
  realm: env['TURN_REALM'] ?? 'mediacall',
  port: integer('TURN_PORT', production ? 3478 : 3490),
  bindAddress: turnBindIp,
  relayBindAddress: env['TURN_RELAY_BIND_IP'] ?? turnBindIp,
  relayMinPort: integer('TURN_MIN_PORT', 49160, 1024),
  relayMaxPort: integer('TURN_MAX_PORT', 49259, 1024),
  maxAllocations: integer('TURN_MAX_ALLOCATIONS', 128, 1, 10000),
  maxAllocationsPerIp: integer('TURN_MAX_ALLOCATIONS_PER_IP', 8, 1, 1000),
  bytesPerSecond: integer('TURN_BYTES_PER_SECOND', 2_000_000, 64_000, 1_000_000_000),
  allowPrivatePeers,
  ...(env['TURN_TLS_CERT'] && env['TURN_TLS_KEY'] ? { tls: {
    port: integer('TURN_TLS_PORT', 5349), cert: readFileSync(env['TURN_TLS_CERT']), key: readFileSync(env['TURN_TLS_KEY']),
  } } : {}),
});

await turn.start();
const turnHost = env['TURN_HOST'] ?? env['TURN_PUBLIC_IP'] ?? '127.0.0.1';
if (!/^[a-zA-Z0-9.-]+$/.test(turnHost)) throw new Error('TURN_HOST must be an IPv4 address or hostname without a port');
const turnUrls = [`turn:${turnHost}:${turn.port}?transport=udp`, `turn:${turnHost}:${turn.port}?transport=tcp`];
if (env['TURN_TLS_CERT']) turnUrls.push(`turns:${turnHost}:${integer('TURN_TLS_PORT', 5349)}?transport=tcp`);
const stunUrl = `stun:${turnHost}:${turn.port}`;
const credentialsLimit = new IpLimiter(20, 0.25);
const apiLimit = new IpLimiter(120, 4);
const assetRoot = resolve('dist/client');
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function authorized(request: IncomingMessage): boolean {
  const authorization = request.headers.authorization;
  return validAccessToken(authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined, accessToken);
}

async function serveAsset(pathname: string, response: ServerResponse): Promise<void> {
  let path = resolve(assetRoot, `.${decodeURIComponent(pathname)}`);
  if (path !== assetRoot && !path.startsWith(assetRoot + sep)) { response.writeHead(403); response.end(); return; }
  let info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) {
    if (extname(pathname)) { response.writeHead(404); response.end('Not found'); return; }
    path = resolve(assetRoot, 'index.html');
    info = await stat(path).catch(() => undefined);
  }
  if (!info?.isFile()) { response.writeHead(503); response.end('Run npm run build first.'); return; }
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream',
    'Cache-Control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(path).on('error', () => response.destroy()).pipe(response);
}

const http = createServer((request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'${production ? '' : " 'unsafe-inline'"}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
  let pathname: string;
  try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; } catch { response.writeHead(400); response.end(); return; }
  if (pathname.startsWith('/api/')) {
    const address = request.socket.remoteAddress ?? '';
    if (!apiLimit.take(address)) { json(response, 429, { error: 'Too many requests. Try again shortly.' }); return; }
    if (request.method !== 'GET') { json(response, 405, { error: 'Method not allowed' }); return; }
    if (pathname === '/api/config') { json(response, 200, { requiresAccessToken: Boolean(env['APP_ACCESS_TOKEN']), turnUrls, stunUrl }); return; }
    if (pathname === '/api/health') { json(response, 200, { status: 'ok', relay: turn.stats().status }); return; }
    if (!authorized(request)) { json(response, 401, { error: 'Enter the server access token in settings.' }); return; }
    if (pathname === '/api/ice') {
      if (!credentialsLimit.take(address)) { json(response, 429, { error: 'Credential limit reached. Try again shortly.' }); return; }
      const credentials = turn.auth.credentials(integer('TURN_CREDENTIAL_TTL', 3600, 60, 86400));
      json(response, 200, {
        iceServers: [{ urls: stunUrl }, { urls: turnUrls, username: credentials.username, credential: credentials.credential }],
        expiresAt: credentials.expiresAt,
      });
      return;
    }
    if (pathname === '/api/relay') { json(response, 200, turn.stats()); return; }
    json(response, 404, { error: 'Not found' });
    return;
  }
  if (production) serveAsset(pathname, response).catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
  else vite!.middlewares(request, response);
});
http.headersTimeout = 10_000;
http.requestTimeout = 15_000;
const signaling = new SignalingServer(http, {
  production,
  ...(accessToken ? { accessToken } : {}),
  ...(env['APP_ORIGIN'] ? { origin: env['APP_ORIGIN'] } : {}),
});
const vite = production ? undefined : await (await import('vite')).createServer({
  server: { middlewareMode: true, hmr: { server: http } }, appType: 'spa',
});

await new Promise<void>((resolveListen, reject) => {
  http.once('error', reject);
  http.listen(integer('PORT', 5180, 0), env['HOST'] ?? '0.0.0.0', () => { http.off('error', reject); resolveListen(); });
});
const appPort = (http.address() as AddressInfo).port;
console.log(JSON.stringify({ event: 'ready', app: `http://localhost:${appPort}`, turn: turnUrls, privatePeers: allowPrivatePeers }));
if (production && env['ALLOW_ANONYMOUS'] === 'true') console.warn('Anonymous TURN credential issuance is enabled. Use authentication for an Internet-facing deployment.');

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await signaling.close();
  await vite?.close();
  await turn.stop();
  http.closeAllConnections();
  await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
}
process.on('SIGINT', () => { shutdown().then(() => process.exit(0)); });
process.on('SIGTERM', () => { shutdown().then(() => process.exit(0)); });