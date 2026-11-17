import { randomBytes } from 'node:crypto';
import type { CallMode } from '../../shared/types.ts';

export interface MeteredSigningOptions {
  keyId: string;
  secret: string;
  channelPrefix: string;
}

export interface MeteredConnectToken {
  token: string;
  expiresAt: number;
  peerId: string;
  channel: string;
}

export function meteredSigningOptions(env: NodeJS.ProcessEnv = process.env): MeteredSigningOptions | undefined {
  const keyId = env['METERED_REALTIME_KEY_ID']?.trim();
  const secret = env['METERED_REALTIME_SECRET']?.trim();
  const channelPrefix = env['METERED_CHANNEL_PREFIX']?.trim() || 'mediacall/';
  if (!keyId || !/^sk_id_[a-zA-Z0-9_-]+$/.test(keyId) || !secret || !/^sk_secret_[a-zA-Z0-9_-]+$/.test(secret) ||
    channelPrefix.length > 64 || !/^[a-zA-Z0-9_/-]+\/$/.test(channelPrefix)) return;
  return { keyId, secret, channelPrefix };
}

export async function mintMeteredToken(
  options: MeteredSigningOptions,
  peer: { roomId: string; name: string; mode: CallMode },
  request: typeof fetch = fetch,
): Promise<MeteredConnectToken> {
  if (!/^[a-zA-Z0-9_-]{16,64}$/.test(peer.roomId) || !peer.name.trim() || peer.name.length > 48 || !['auto', 'relay'].includes(peer.mode)) {
    throw new Error('Enter a valid room, name, and call mode.');
  }
  const peerId = randomBytes(16).toString('hex');
  const channel = `${options.channelPrefix}${peer.roomId}`;
  try {
    const response = await request('https://rms.metered.ca/v1/tokens', {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.keyId}:${options.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        peerId, channels: [channel], permissions: ['publish', 'subscribe', 'presence'], expiresInSec: 3600,
        peerMetadata: { name: peer.name.replace(/[\u0000-\u001f\u007f]/g, '').trim(), mode: peer.mode },
      }),
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Provider token request failed');
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string' || body.token.length > 32_000 ||
      !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(body.token) ||
      !('expiresAt' in body) || typeof body.expiresAt !== 'number' || body.expiresAt <= Date.now() / 1000) throw new Error('Invalid provider token response');
    return { token: body.token, expiresAt: body.expiresAt, peerId, channel };
  } catch {
    throw new Error('Metered signaling is unavailable. Check the rotated signing key, channel permissions, and free-plan quota.');
  }
}