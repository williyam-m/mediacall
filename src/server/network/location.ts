import { BlockList, isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, authorized } from '../http/respond.ts';
import { IpLimiter } from '../http/limits.ts';
import type { RelayLocation } from '../../shared/types.ts';

const reserved = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) reserved.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]] as const) reserved.addSubnet(network, prefix, 'ipv6');

function normalizedIp(input: string): string | undefined {
  const mapped = input.toLowerCase().startsWith('::ffff:') ? input.slice(7) : input;
  if (isIP(mapped)) return mapped;
}

function emptyLocation(ip: string, status: RelayLocation['status']): RelayLocation {
  return { ip, status, country: null, countryCode: null, region: null, city: null, asn: null, organization: null, timezone: null, approximate: true, source: null };
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): string | null { return typeof value === 'string' && value.length > 0 && value.length <= 160 ? value : null; }

export function createLocationLookup(request: typeof fetch = fetch) {
  const cache = new Map<string, { location: RelayLocation; until: number }>();
  const pending = new Map<string, Promise<RelayLocation>>();
  return async (input: string): Promise<RelayLocation> => {
    const ip = normalizedIp(input);
    if (!ip) throw new Error('A valid IPv4 or IPv6 address is required.');
    const family = isIP(ip) === 4 ? 'ipv4' : 'ipv6';
    if (reserved.check(ip, family)) return emptyLocation(ip, 'private');
    const existing = cache.get(ip);
    if (existing && existing.until > Date.now()) return existing.location;
    const inflight = pending.get(ip);
    if (inflight) return inflight;
    const lookup = (async () => {
      let location = emptyLocation(ip, 'unavailable');
      try {
        const response = await request(`https://ipwho.is/${encodeURIComponent(ip)}`, { redirect: 'error', signal: AbortSignal.timeout(3500) });
        if (!response.ok) throw new Error('Location provider unavailable');
        const body: unknown = await response.json();
        if (!object(body) || body['success'] !== true || normalizedIp(String(body['ip'])) !== ip) throw new Error('Invalid location provider response');
        const connection = object(body['connection']) ? body['connection'] : {};
        const timezone = object(body['timezone']) ? body['timezone'] : {};
        location = {
          ip, status: 'located', country: text(body['country']), countryCode: text(body['country_code']), region: text(body['region']), city: text(body['city']),
          asn: typeof connection['asn'] === 'number' && Number.isSafeInteger(connection['asn']) ? connection['asn'] : null,
          organization: text(connection['org']) ?? text(connection['isp']), timezone: text(timezone['id']), approximate: true, source: 'ipwho.is',
        };
      } catch {}
      if (cache.size >= 512) cache.delete(cache.keys().next().value!);
      cache.set(ip, { location, until: Date.now() + (location.status === 'located' ? 6 * 60 * 60_000 : 30_000) });
      return location;
    })();
    pending.set(ip, lookup);
    try { return await lookup; } finally { pending.delete(ip); }
  };
}

const lookupLocation = createLocationLookup();

export function createNetworkApi(accessToken?: string, lookup = lookupLocation) {
  const limit = new IpLimiter(20, 1);
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); json(response, 405, { error: 'Method not allowed.' }); return; }
    if (!authorized(request, accessToken)) { json(response, 401, { error: 'An access token is required.' }); return; }
    const address = String(request.headers['x-vercel-forwarded-for'] ?? request.socket.remoteAddress ?? '').split(',')[0]!;
    if (!limit.take(address)) { json(response, 429, { error: 'Location lookup limit reached.' }); return; }
    const ip = new URL(request.url ?? '/', 'http://localhost').searchParams.get('ip') ?? '';
    if (!normalizedIp(ip)) { json(response, 400, { error: 'A valid IPv4 or IPv6 address is required.' }); return; }
    json(response, 200, await lookup(ip));
  };
}