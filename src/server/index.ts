import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignalingServer } from './signaling/websocket.ts';
import { startupConfig, STARTUP_HELP } from './config/startup.ts';
import { createLocalRelay } from './providers/local.ts';
import { createLocalApi } from './http/localApi.ts';
import { createHostedApi } from './hosted/api.ts';
import { json } from './http/respond.ts';
import { serveAsset } from './http/static.ts';
import { applySecurityHeaders } from './http/security.ts';

async function main() {
  const config = await startupConfig();
  if (!config) { console.log(STARTUP_HELP); return; }
  const managed = config.provider === 'metered' && config.realtime;
  const relay = managed ? undefined : await createLocalRelay(config);
  const api = managed ? createHostedApi({
    store: undefined, turn: config.metered, realtime: managed, defaultMode: config.defaultMode,
    ...(config.accessToken ? { accessToken: config.accessToken } : {}), ...(config.origin ? { origin: config.origin } : {}),
  }) : createLocalApi(config, relay!);
  const http = createServer((request, response) => {
    applySecurityHeaders(response, config.production);
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; } catch { json(response, 400, { error: 'Invalid URL' }); return; }
    if (pathname.startsWith('/api/')) {
      api(request, response).catch(() => { if (!response.headersSent) json(response, 503, { error: 'The call service is unavailable. Check provider configuration.' }); else response.end(); });
    } else if (config.production) serveAsset(pathname, response).catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
    else vite!.middlewares(request, response);
  });
  http.headersTimeout = 10_000;
  http.requestTimeout = 15_000;
  const signaling = managed ? undefined : new SignalingServer(http, {
    production: config.production,
    ...(config.accessToken ? { accessToken: config.accessToken } : {}), ...(config.origin ? { origin: config.origin } : {}),
  });
  const vite = config.production ? undefined : await (await import('vite')).createServer({
    server: { middlewareMode: true, hmr: { server: http } }, appType: 'spa',
  });
  await new Promise<void>((resolveListen, reject) => {
    http.once('error', reject);
    http.listen(config.port, config.host, () => { http.off('error', reject); resolveListen(); });
  });
  const appPort = (http.address() as AddressInfo).port;
  console.log(JSON.stringify({ event: 'ready', app: `http://localhost:${appPort}`, provider: config.provider, ice: config.defaultMode, turn: relay?.turnUrls ?? 'Metered Open Relay', privatePeers: config.provider === 'custom-turn' && config.turn.allowPrivatePeers }));
  if (config.production && config.anonymous) console.warn('Anonymous credential issuance is enabled. Use authentication for an Internet-facing deployment.');
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    await signaling?.close();
    await vite?.close();
    await relay?.stop();
    http.closeAllConnections();
    await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
  }
  process.on('SIGINT', () => { shutdown().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { shutdown().then(() => process.exit(0)); });
}

await main();