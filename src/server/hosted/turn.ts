import type { IceConfig } from '../../shared/types.ts';

export interface HostedTurnOptions {
  domain: string;
  apiKey: string;
}

export function hostedTurnOptions(env: NodeJS.ProcessEnv = process.env): HostedTurnOptions | undefined {
  const domain = env['METERED_DOMAIN']?.trim();
  const apiKey = env['METERED_API_KEY']?.trim();
  if (!domain || !apiKey || !/^[a-z0-9-]+\.metered\.(live|ca)$/.test(domain)) return;
  return { domain, apiKey };
}

function parseIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error('Invalid TURN provider response');
  let hasTurn = false;
  const servers = value.map((entry: unknown): RTCIceServer => {
    if (!entry || typeof entry !== 'object' || !('urls' in entry)) throw new Error('Invalid TURN provider response');
    const urls: unknown[] = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    if (urls.length === 0 || urls.length > 16 || urls.some((url) => typeof url !== 'string' || url.length > 512 || !/^(stun|stuns|turn|turns):[a-zA-Z0-9.-]+(?::\d+)?(?:\?transport=(?:udp|tcp))?$/.test(url))) {
      throw new Error('Invalid TURN provider response');
    }
    const username = 'username' in entry && typeof entry.username === 'string' ? entry.username : undefined;
    const credential = 'credential' in entry && typeof entry.credential === 'string' ? entry.credential : undefined;
    if (urls.some((url) => /^turns?:/.test(String(url)))) {
      if (!username || !credential) throw new Error('Missing TURN provider credentials');
      hasTurn = true;
    }
    return { urls: urls as string[], ...(username ? { username } : {}), ...(credential ? { credential } : {}) };
  });
  if (!hasTurn) throw new Error('TURN provider returned no relay servers');
  return servers;
}

export async function hostedIce(options: HostedTurnOptions, request: typeof fetch = fetch): Promise<IceConfig> {
  if (!hostedTurnOptions({ METERED_DOMAIN: options.domain, METERED_API_KEY: options.apiKey })) throw new Error('Configure METERED_DOMAIN and METERED_API_KEY');
  const url = new URL(`https://${options.domain}/api/v1/turn/credentials`);
  url.searchParams.set('apiKey', options.apiKey);
  try {
    const response = await request(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('TURN provider request failed');
    return { iceServers: parseIceServers(await response.json()), expiresAt: Math.floor(Date.now() / 1000) + 300 };
  } catch {
    throw new Error('Hosted TURN is unavailable. Check the provider credentials and free-plan quota.');
  }
}