import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, authorized } from './respond.ts';
import { IpLimiter } from './limits.ts';
import type { StartupConfig } from '../config/startup.ts';
import type { LocalRelayProvider } from '../providers/local.ts';
import type { AppConfig } from '../../shared/types.ts';

export function createLocalApi(config: StartupConfig, relay: LocalRelayProvider) {
  const requests = new IpLimiter(120, 4);
  const credentials = new IpLimiter(20, 0.25);
  return async (request: IncomingMessage, response: ServerResponse) => {
    const address = request.socket.remoteAddress ?? '';
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (!requests.take(address)) { json(response, 429, { error: 'Too many requests. Try again shortly.' }); return; }
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); json(response, 405, { error: 'Method not allowed' }); return; }
    if (pathname === '/api/config') {
      json(response, 200, { requiresAccessToken: Boolean(config.accessToken), turnUrls: relay.turnUrls, stunUrl: relay.stunUrl, relay: relay.profile, defaultMode: config.defaultMode } satisfies AppConfig); return;
    }
    if (pathname === '/api/health') { json(response, 200, { status: 'ok', relay: relay.stats().status, provider: config.provider }); return; }
    if (!authorized(request, config.accessToken)) { json(response, 401, { error: 'Enter the server access token in settings.' }); return; }
    if (pathname === '/api/ice') {
      if (!credentials.take(address)) { json(response, 429, { error: 'Credential limit reached. Try again shortly.' }); return; }
      json(response, 200, await relay.ice()); return;
    }
    if (pathname === '/api/relay') { json(response, 200, relay.stats()); return; }
    json(response, 404, { error: 'Not found' });
  };
}