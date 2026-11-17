import type { IncomingMessage, ServerResponse } from 'node:http';
import { validAccessToken } from '../custom-turn/auth.ts';
import { hostedIce, hostedTurnOptions } from './turn.ts';
import type { HostedTurnOptions } from './turn.ts';
import { exchangeSignals, parseSignalRequest, SignalError } from './signaling.ts';
import type { RoomStore } from './signaling.ts';
import { neonRoomStore } from './roomStore.ts';
import { IpLimiter } from '../http/limits.ts';
import type { AppConfig, IceConfig, RelayStats } from '../../shared/types.ts';
import { meteredSigningOptions, mintMeteredToken } from './metered.ts';
import type { MeteredConnectToken, MeteredSigningOptions } from './metered.ts';

interface HostedApiOptions {
  store: RoomStore | undefined;
  turn: HostedTurnOptions | undefined;
  accessToken?: string;
  origin?: string;
  provideIce?: () => Promise<IceConfig>;
  realtime?: MeteredSigningOptions;
  realtimeOrigin?: string;
  provideToken?: (peer: { roomId: string; name: string; mode: 'auto' | 'relay' }) => Promise<MeteredConnectToken>;
  defaultMode?: 'auto' | 'relay';
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if ('body' in request && request.body !== undefined) {
    const body: unknown = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    if (Buffer.byteLength(JSON.stringify(body)) > 65_536) throw new SignalError('payload-limit', 'Signaling payload is too large.', 413);
    return body;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += bytes.length;
    if (length > 65_536) throw new SignalError('payload-limit', 'Signaling payload is too large.', 413);
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new SignalError('invalid-json', 'Invalid JSON payload.'); }
}

export function createHostedApi(options: HostedApiOptions) {
  const limit = new IpLimiter(150, 15);
  const credentialsLimit = new IpLimiter(12, 0.1);
  let cachedIce: { configuration: IceConfig; until: number } | undefined;
  let pendingIce: Promise<IceConfig> | undefined;
  async function ice() {
    if (cachedIce && cachedIce.until > Date.now()) return cachedIce.configuration;
    pendingIce ??= (options.provideIce ? options.provideIce() : hostedIce(options.turn!)).then((configuration) => {
      cachedIce = { configuration, until: Date.now() + 60_000 };
      return configuration;
    }).finally(() => { pendingIce = undefined; });
    return pendingIce;
  }
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? '/', 'https://frontend.invalid');
      if (!['/api/config', '/api/health', '/api/ice', '/api/relay', '/api/signal', '/api/realtime'].includes(url.pathname)) { json(response, 404, { error: 'Not found.' }); return; }
      const signaling = url.pathname === '/api/signal';
      const realtime = url.pathname === '/api/realtime';
      if (realtime && request.method !== 'POST' || !realtime && request.method !== 'GET' && !(signaling && request.method === 'POST')) {
        response.setHeader('Allow', realtime ? 'POST' : signaling ? 'GET, POST' : 'GET');
        json(response, 405, { error: 'Method not allowed.' }); return;
      }
      const address = String(request.headers['x-vercel-forwarded-for'] ?? request.socket.remoteAddress ?? '').split(',')[0]!;
      if (!limit.take(address)) throw new SignalError('rate-limit', 'Too many requests. Try again shortly.', 429);
      if (!options.realtime && (!options.store || !options.turn)) {
        const missing = !options.store && !options.turn ? ['METERED_REALTIME_KEY_ID and METERED_REALTIME_SECRET (a rotated Metered signing key)'] :
          [...(!options.store ? ['DATABASE_URL (free Neon integration)'] : []), ...(!options.turn ? ['METERED_DOMAIN and METERED_API_KEY'] : [])];
        json(response, 503, { status: 'unconfigured', relay: 'offline', error: `Complete the free-service setup: ${missing.join('; ')}.` }); return;
      }
      if (url.pathname === '/api/config') {
        json(response, 200, {
          requiresAccessToken: Boolean(options.accessToken), turnUrls: [], stunUrl: '', defaultMode: options.defaultMode ?? 'auto',
          relay: { name: 'Metered Open Relay', host: options.realtime ? 'rms.metered.ca' : options.turn!.domain, managed: true, version: 'Hosted' },
        } satisfies AppConfig);
        return;
      }
      if (url.pathname === '/api/health') {
        if (!options.realtime) await options.store!.read('__health__', Date.now());
        json(response, 200, { status: 'ok', relay: 'configured', signaling: options.realtime ? 'metered-websocket' : 'postgres-http' }); return;
      }
      if (realtime) {
        if (!options.realtime) throw new SignalError('unconfigured', 'Configure the Metered signing key.', 503);
        let sameOrigin = false;
        try { sameOrigin = Boolean(request.headers.origin && (options.origin ? request.headers.origin === options.origin : new URL(request.headers.origin).host === request.headers.host)); } catch {}
        if (!sameOrigin || !request.headers['content-type']?.startsWith('application/json')) throw new SignalError('forbidden', 'Invalid signaling origin.', 403);
        const body = await readBody(request);
        if (!body || typeof body !== 'object' || !('roomId' in body) || typeof body.roomId !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(body.roomId) ||
          !('name' in body) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 48 || !('mode' in body) || !['auto', 'relay'].includes(String(body.mode))) throw new SignalError('invalid-room', 'Enter a valid room, name, and call mode.');
        const accessToken = 'accessToken' in body && typeof body.accessToken === 'string' ? body.accessToken : undefined;
        if (!validAccessToken(accessToken, options.accessToken)) throw new SignalError('unauthorized', 'An access token is required.', 401);
        if (!credentialsLimit.take(address)) throw new SignalError('credential-limit', 'Credential limit reached. Try again shortly.', 429);
        const peer = { roomId: body.roomId, name: body.name, mode: body.mode as 'auto' | 'relay' };
        json(response, 200, await (options.provideToken ? options.provideToken(peer) : mintMeteredToken(options.realtime, peer)));
        return;
      }
      if (signaling) {
        if (!options.store) throw new SignalError('unconfigured', 'This deployment uses managed signaling.', 404);
        let body: unknown;
        if (request.method === 'POST') {
          let sameOrigin = false;
          try { sameOrigin = Boolean(request.headers.origin && (options.origin ? request.headers.origin === options.origin : new URL(request.headers.origin).host === request.headers.host)); } catch {}
          if (!sameOrigin || !request.headers['content-type']?.startsWith('application/json')) throw new SignalError('forbidden', 'Invalid signaling origin.', 403);
          body = await readBody(request);
        } else {
          body = { roomId: url.searchParams.get('roomId'), peerId: url.searchParams.get('peerId'), after: Number(url.searchParams.get('after') ?? 0), sessionToken: request.headers['x-call-session'] };
        }
        const command = parseSignalRequest(body);
        if (command.join) {
          const accessToken = body && typeof body === 'object' && 'accessToken' in body && typeof body.accessToken === 'string' ? body.accessToken : undefined;
          if (!validAccessToken(accessToken, options.accessToken)) throw new SignalError('unauthorized', 'An access token is required.', 401);
        }
        json(response, 200, await exchangeSignals(options.store, command)); return;
      }
      const authorization = request.headers.authorization;
      if (!validAccessToken(authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined, options.accessToken)) throw new SignalError('unauthorized', 'Enter the server access token in settings.', 401);
      if (url.pathname === '/api/ice') {
        if (!credentialsLimit.take(address)) throw new SignalError('credential-limit', 'Credential limit reached. Try again shortly.', 429);
        if (options.realtime) {
          json(response, 200, { iceServers: [], expiresAt: Math.floor(Date.now() / 1000) + 3600, signalingTransport: 'metered', signalingUrl: options.realtimeOrigin ?? 'wss://rms.metered.ca' } satisfies IceConfig);
        } else json(response, 200, { ...await ice(), signalingTransport: 'http' } satisfies IceConfig);
        return;
      }
      json(response, 200, {
        status: 'hosted', activeAllocations: null, maxAllocations: null, uptimeSeconds: null,
        transports: ['udp', 'tcp', 'tls'], created: null, bytesToPeer: null, bytesToClient: null, dropped: null, authFailures: null,
      } satisfies RelayStats);
    } catch (cause) {
      if (cause instanceof SignalError) json(response, cause.status, { error: cause.message, code: cause.code });
      else json(response, 503, { error: 'The hosted call service is unavailable. Check the database, TURN credentials, and free-plan quota.' });
    }
  };
}

let deployedHandler: ReturnType<typeof createHostedApi> | undefined;
export async function hostedCallApi(request: IncomingMessage, response: ServerResponse) {
  const env = process.env;
  const database = env['DATABASE_URL'] ?? env['POSTGRES_URL'];
  const realtime = meteredSigningOptions(env);
  try {
    deployedHandler ??= createHostedApi({
      store: !realtime && database ? neonRoomStore(database) : undefined, turn: hostedTurnOptions(env),
      ...(realtime ? { realtime } : {}),
      ...(env['APP_ACCESS_TOKEN'] ? { accessToken: env['APP_ACCESS_TOKEN'] } : {}),
      ...(env['APP_ORIGIN'] ? { origin: env['APP_ORIGIN'] } : {}),
    });
    await deployedHandler(request, response);
  } catch {
    json(response, 503, { error: 'The hosted call service configuration is invalid. Check the server-side environment variables.' });
  }
}