import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { hostedTurnOptions } from '../hosted/turn.ts';
import { meteredSigningOptions } from '../hosted/metered.ts';
import type { HostedTurnOptions } from '../hosted/turn.ts';
import type { MeteredSigningOptions } from '../hosted/metered.ts';
import type { CallMode } from '../../shared/types.ts';

export interface StartupConfig {
  production: boolean;
  provider: 'custom-turn' | 'metered';
  port: number;
  host: string;
  defaultMode: CallMode;
  accessToken: string | undefined;
  origin: string | undefined;
  anonymous: boolean;
  credentialsTtl: number;
  turn: {
    secret: string; publicAddress: string; host: string; realm: string; port: number; bindAddress: string; relayBindAddress: string;
    relayMinPort: number; relayMaxPort: number; maxAllocations: number; maxAllocationsPerIp: number;
    bytesPerSecond: number; allowPrivatePeers: boolean;
    tls: { port: number; certPath: string; keyPath: string } | undefined;
  };
  metered: HostedTurnOptions | undefined;
  realtime: MeteredSigningOptions | undefined;
}

export const STARTUP_HELP = `MediaCall

Usage: npm run dev -- [options]
       npm start -- [options]

  --turn custom-turn|metered   Local relay provider (default: custom-turn)
  --configure                 Choose non-secret startup settings interactively
  --ice auto|relay            Initial ICE selection (default: auto)
  --port NUMBER               HTTP port (default: 5180)
  --host ADDRESS              HTTP bind address (default: 0.0.0.0)
  --turn-public-ip IPV4       Advertised custom-turn relay IPv4 address
  --turn-bind-ip IPV4         Local custom-turn listener interface
  --turn-port NUMBER          STUN/TURN listener (default: 3490 in development)
  --relay-min-port NUMBER     First custom-turn UDP allocation port
  --relay-max-port NUMBER     Last custom-turn UDP allocation port
  --production                Serve built assets and enforce production gates
  --help                      Show this help

Metered credentials belong in the ignored .env file, never command-line flags.
Vercel uses CALL_BACKEND=hosted and Metered Open Relay, not a local UDP server.`;

function integer(name: string, value: string | undefined, fallback: number, min = 1, max = 65535) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return parsed;
}

export async function startupConfig(
  args = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  prompt?: (question: string) => Promise<string>,
): Promise<StartupConfig | undefined> {
  const { values } = parseArgs({ args, options: {
    production: { type: 'boolean', default: false }, configure: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    turn: { type: 'string' }, ice: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' },
    'turn-public-ip': { type: 'string' }, 'turn-bind-ip': { type: 'string' }, 'turn-port': { type: 'string' },
    'relay-min-port': { type: 'string' }, 'relay-max-port': { type: 'string' },
  }, strict: true });
  if (values.help) return;
  let readline: ReturnType<typeof createInterface> | undefined;
  if (values.configure) {
    if (!prompt && !process.stdin.isTTY) throw new Error('--configure requires an interactive terminal; use explicit flags in scripts.');
    if (!prompt) { readline = createInterface({ input: process.stdin, output: process.stdout }); prompt = (question) => readline!.question(question); }
    try {
      values.turn = (await prompt(`Relay provider [custom-turn/metered] (${values.turn ?? env['TURN_PROVIDER'] ?? 'custom-turn'}): `)).trim() || values.turn || env['TURN_PROVIDER'] || 'custom-turn';
      values.port = (await prompt(`HTTP port (${values.port ?? env['PORT'] ?? '5180'}): `)).trim() || values.port || env['PORT'] || '5180';
      values.ice = (await prompt(`Initial ICE policy [auto/relay] (${values.ice ?? env['ICE_MODE'] ?? 'auto'}): `)).trim() || values.ice || env['ICE_MODE'] || 'auto';
      if (values.turn === 'custom-turn') {
        values['turn-public-ip'] = (await prompt(`Advertised relay IPv4 (${values['turn-public-ip'] ?? env['TURN_PUBLIC_IP'] ?? '127.0.0.1'}): `)).trim() || values['turn-public-ip'] || env['TURN_PUBLIC_IP'] || '127.0.0.1';
        values['turn-port'] = (await prompt(`TURN listener port (${values['turn-port'] ?? env['TURN_PORT'] ?? (values.production ? '3478' : '3490')}): `)).trim() || values['turn-port'] || env['TURN_PORT'] || (values.production ? '3478' : '3490');
      }
    } finally { readline?.close(); }
  }
  const provider = values.turn ?? env['TURN_PROVIDER'] ?? 'custom-turn';
  const defaultMode = values.ice ?? env['ICE_MODE'] ?? 'auto';
  if (!['custom-turn', 'metered'].includes(provider)) throw new Error('--turn must be custom-turn or metered');
  if (!['auto', 'relay'].includes(defaultMode)) throw new Error('--ice must be auto or relay');
  const production = values.production;
  const accessToken = env['APP_ACCESS_TOKEN'] || undefined;
  const publicAddress = values['turn-public-ip'] ?? env['TURN_PUBLIC_IP'] ?? '127.0.0.1';
  const bindAddress = values['turn-bind-ip'] ?? env['TURN_BIND_IP'] ?? (publicAddress === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0');
  const turnHost = env['TURN_HOST'] ?? publicAddress;
  const relayMinPort = integer('TURN_MIN_PORT', values['relay-min-port'] ?? env['TURN_MIN_PORT'], 49160, 1024);
  const relayMaxPort = integer('TURN_MAX_PORT', values['relay-max-port'] ?? env['TURN_MAX_PORT'], 49259, 1024);
  const realtime = meteredSigningOptions(env);
  const metered = hostedTurnOptions(env);
  if (accessToken && accessToken.length < 24) throw new Error('APP_ACCESS_TOKEN must have at least 24 characters');
  if (provider === 'metered' && !realtime && !metered) throw new Error('Metered mode requires METERED_REALTIME_KEY_ID and METERED_REALTIME_SECRET, or METERED_DOMAIN and METERED_API_KEY, in the ignored .env file.');
  if (provider === 'custom-turn') {
    if (!isIPv4(publicAddress) || !isIPv4(bindAddress)) throw new Error('Custom-turn public and bind addresses must be IPv4 addresses');
    if (!/^[a-zA-Z0-9.-]+$/.test(turnHost)) throw new Error('TURN_HOST must be an IPv4 address or hostname without a port');
    if (relayMinPort > relayMaxPort) throw new Error('TURN_MIN_PORT must not exceed TURN_MAX_PORT');
    if (production && (!env['TURN_SECRET'] || env['TURN_SECRET'].length < 32)) throw new Error('Production requires a TURN_SECRET of at least 32 characters');
    if (production && publicAddress === '127.0.0.1') throw new Error('Production custom-turn requires your routable TURN_PUBLIC_IP');
    if (production && !accessToken && env['ALLOW_ANONYMOUS'] !== 'true') throw new Error('Set APP_ACCESS_TOKEN or explicitly opt into ALLOW_ANONYMOUS=true');
    if (Boolean(env['TURN_TLS_CERT']) !== Boolean(env['TURN_TLS_KEY'])) throw new Error('Set both TURN_TLS_CERT and TURN_TLS_KEY');
  }
  return {
    production, provider: provider as StartupConfig['provider'], defaultMode: defaultMode as CallMode,
    port: integer('PORT', values.port ?? env['PORT'], 5180, 0), host: values.host ?? env['HOST'] ?? '0.0.0.0',
    accessToken, origin: env['APP_ORIGIN'] || undefined, anonymous: env['ALLOW_ANONYMOUS'] === 'true',
    credentialsTtl: integer('TURN_CREDENTIAL_TTL', env['TURN_CREDENTIAL_TTL'], 3600, 60, 86400), realtime, metered,
    turn: {
      secret: env['TURN_SECRET'] || randomBytes(32).toString('hex'), publicAddress, host: turnHost, realm: env['TURN_REALM'] ?? 'mediacall',
      port: integer('TURN_PORT', values['turn-port'] ?? env['TURN_PORT'], production ? 3478 : 3490, 0), bindAddress,
      relayBindAddress: env['TURN_RELAY_BIND_IP'] ?? bindAddress, relayMinPort, relayMaxPort,
      maxAllocations: integer('TURN_MAX_ALLOCATIONS', env['TURN_MAX_ALLOCATIONS'], 128, 1, 10000),
      maxAllocationsPerIp: integer('TURN_MAX_ALLOCATIONS_PER_IP', env['TURN_MAX_ALLOCATIONS_PER_IP'], 8, 1, 1000),
      bytesPerSecond: integer('TURN_BYTES_PER_SECOND', env['TURN_BYTES_PER_SECOND'], 2_000_000, 64_000, 1_000_000_000),
      allowPrivatePeers: env['TURN_ALLOW_PRIVATE_PEERS'] === 'true' || (!production && env['TURN_ALLOW_PRIVATE_PEERS'] !== 'false'),
      tls: env['TURN_TLS_CERT'] && env['TURN_TLS_KEY'] ? { port: integer('TURN_TLS_PORT', env['TURN_TLS_PORT'], 5349), certPath: env['TURN_TLS_CERT'], keyPath: env['TURN_TLS_KEY'] } : undefined,
    },
  };
}