import type { IceConfig } from '../../shared/types.ts';

export async function fetchIce(accessToken: string): Promise<IceConfig> {
  const response = await fetch('/api/ice', { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? 'The relay configuration is unavailable.');
  }
  return response.json() as Promise<IceConfig>;
}