import { readFileSync } from 'node:fs';
import { TurnServer } from '../custom-turn/server.ts';
import { hostedIce } from '../hosted/turn.ts';
import type { StartupConfig } from '../config/startup.ts';
import type { AppConfig, IceConfig, RelayStats } from '../../shared/types.ts';

export interface LocalRelayProvider {
  profile: NonNullable<AppConfig['relay']>;
  turnUrls: string[];
  stunUrl: string;
  ice(): Promise<IceConfig>;
  stats(): RelayStats;
  stop(): Promise<void>;
}

export async function createLocalRelay(config: StartupConfig): Promise<LocalRelayProvider> {
  if (config.provider === 'metered') {
    if (!config.metered) throw new Error('The local Metered REST provider requires METERED_DOMAIN and METERED_API_KEY.');
    return {
      profile: { name: 'Metered Open Relay', host: config.metered.domain, managed: true, version: 'Hosted' },
      turnUrls: [], stunUrl: '', ice: () => hostedIce(config.metered!),
      stats: () => ({ status: 'configured', activeAllocations: null, maxAllocations: null, uptimeSeconds: null, transports: ['udp', 'tcp', 'tls'], created: null, bytesToPeer: null, bytesToClient: null, dropped: null, authFailures: null }),
      async stop() {},
    };
  }
  const { tls, host, ...options } = config.turn;
  const server = new TurnServer({ ...options, ...(tls ? { tls: { port: tls.port, cert: readFileSync(tls.certPath), key: readFileSync(tls.keyPath) } } : {}) });
  await server.start();
  const turnUrls = [`turn:${host}:${server.port}?transport=udp`, `turn:${host}:${server.port}?transport=tcp`];
  if (tls) turnUrls.push(`turns:${host}:${tls.port}?transport=tcp`);
  const stunUrl = `stun:${host}:${server.port}`;
  return {
    profile: { name: 'custom-turn', host: `${host}:${server.port}`, managed: false, version: '0.1' }, turnUrls, stunUrl,
    async ice() {
      const credentials = server.auth.credentials(config.credentialsTtl);
      return { iceServers: [{ urls: stunUrl }, { urls: turnUrls, username: credentials.username, credential: credentials.credential }], expiresAt: credentials.expiresAt };
    },
    stats: () => server.stats(), stop: () => server.stop(),
  };
}