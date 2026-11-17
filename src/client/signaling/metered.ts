import { SignallingClient } from '@metered-ca/realtime';
import type { PresenceEvent } from '@metered-ca/realtime';
import type { CallMode, ClientSignal, IceConfig, PeerInfo, ServerSignal } from '../../shared/types.ts';
import type { SignalingConnection } from './connection.ts';
import type { MeteredConnectToken } from '../../server/hosted/metered.ts';

interface RoomPeer extends PeerInfo { mode: CallMode }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function roomPeer(value: unknown): RoomPeer | undefined {
  if (!object(value) || typeof value['peerId'] !== 'string' || !object(value['metadata'])) return;
  const metadata = value['metadata'];
  if (typeof metadata['name'] !== 'string' || !metadata['name'] || metadata['name'].length > 48 || !['auto', 'relay'].includes(String(metadata['mode']))) return;
  return { id: value['peerId'], name: metadata['name'], mode: metadata['mode'] as CallMode, media: { audio: true, video: true, sharing: false } };
}

function hasAuthenticatedRelay(servers: RTCIceServer[]): boolean {
  return servers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return Boolean(server.username && server.credential && urls.some((url) => /^turns?:/.test(url)));
  });
}

export class MeteredSignalingConnection implements SignalingConnection {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly configuration: IceConfig;
  private readonly controller = new AbortController();
  private client: SignallingClient | undefined;
  private peerId = '';
  private channel = '';
  private roomId = '';
  private mode: CallMode = 'relay';
  private joined = false;
  private other: RoomPeer | undefined;
  private outbound = Promise.resolve();

  constructor(configuration: IceConfig) {
    this.configuration = configuration;
    queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } });
  }

  private emit(signal: ServerSignal) {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(signal) });
  }

  private failure(cause: unknown) {
    this.emit({ type: 'error', code: 'managed-signaling', message: cause instanceof Error ? cause.message : 'Managed signaling is unavailable.' });
  }

  private presence(event: PresenceEvent) {
    if (this.readyState !== 1 || event.channel !== this.channel) return;
    const peers = event.joined.map(roomPeer).filter((peer): peer is RoomPeer => Boolean(peer && peer.id !== this.peerId));
    if (!this.joined) {
      if (peers.length > 1) { this.emit({ type: 'error', code: 'room-full', message: 'This call already has two people.' }); this.close(); return; }
      this.other = peers[0];
      if (this.other?.mode === 'relay') this.mode = 'relay';
      this.joined = true;
      this.emit({ type: 'joined', peerId: this.peerId, roomId: this.roomId, mode: this.mode, peers: this.other ? [this.other] : [] });
      return;
    }
    if (this.other && event.left.some((peer) => peer.peerId === this.other?.id)) {
      this.other = undefined;
      this.emit({ type: 'peer-left' });
    }
    for (const peer of peers) {
      if (this.other || peer.id === this.peerId) continue;
      this.other = peer;
      if (peer.mode === 'relay') this.mode = 'relay';
      this.emit({ type: 'peer-joined', peer, mode: this.mode });
    }
  }

  private receive(from: string, value: unknown) {
    if (from !== this.other?.id || !object(value) || value['type'] !== 'mediacall-signal' || value['to'] !== this.peerId || !object(value['signal'])) return;
    const signal = value['signal'];
    if (signal['type'] === 'media') {
      const media = signal['media'];
      if (object(media) && typeof media['audio'] === 'boolean' && typeof media['video'] === 'boolean' && typeof media['sharing'] === 'boolean') {
        this.emit({ type: 'media', media: { audio: media['audio'], video: media['video'], sharing: media['sharing'] } });
      }
    } else if (signal['type'] === 'description') {
      const description = signal['description'];
      if (object(description) && ['offer', 'answer'].includes(String(description['type'])) && typeof description['sdp'] === 'string' && description['sdp'].length <= 60_000) {
        this.emit({ type: 'description', description: { type: description['type'] as 'offer' | 'answer', sdp: description['sdp'] } });
      }
    } else if (signal['type'] === 'ice') {
      const candidate = signal['candidate'];
      if (object(candidate) && typeof candidate['candidate'] === 'string' && candidate['candidate'].length <= 2048) this.emit({ type: 'ice', candidate: candidate as RTCIceCandidateInit });
    }
  }

  private async join(message: Extract<ClientSignal, { type: 'join' }>) {
    this.roomId = message.roomId;
    this.mode = message.mode;
    const client = new SignallingClient({
      ...(this.configuration.signalingUrl ? { url: this.configuration.signalingUrl } : {}),
      reconnect: false,
      tokenProvider: async () => {
        const response = await fetch('/api/realtime', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
          body: JSON.stringify(message), signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]),
        });
        const body = await response.json() as MeteredConnectToken & { error?: string };
        if (!response.ok) throw new Error(body.error ?? 'Unable to authorize the call.');
        this.peerId = body.peerId;
        this.channel = body.channel;
        return body.token;
      },
    });
    this.client = client;
    client.on('connected', (event) => {
      if (event.iceServers?.length) this.configuration.iceServers = event.iceServers.map((server) => ({
        urls: server.urls, ...(server.username ? { username: server.username } : {}), ...(server.credential ? { credential: server.credential } : {}),
      }));
      if (!hasAuthenticatedRelay(this.configuration.iceServers)) {
        this.failure(new Error('No TURN servers were supplied. Enable automatic TURN injection for the Metered signing key.'));
        this.close();
      }
    });
    client.on('presence', (event) => this.presence(event));
    client.on('message', (event) => { if (event.channel === this.channel) this.receive(event.from, event.data); });
    client.on('disconnected', () => { if (this.readyState === 1) this.onclose?.(); });
    client.on('server-error', () => this.failure(new Error('Metered rejected a signaling request. Check the key permissions and free-plan quota.')));
    client.on('token-provider-error', () => this.failure(new Error('Call authorization failed. Check the rotated signing key.')));
    await client.connect();
    if (this.readyState === 1) await client.subscribe(this.channel);
    else await client.close();
  }

  send(data: string) {
    if (this.readyState !== 1) return;
    const message = JSON.parse(data) as ClientSignal;
    if (message.type === 'join') { this.join(message).catch((cause: unknown) => this.failure(cause)); return; }
    if (message.type === 'leave') { this.close(); return; }
    const target = this.other?.id;
    if (!target || !this.client) return;
    this.outbound = this.outbound.then(async () => {
      if (this.readyState === 1) await this.client!.publish(this.channel, { type: 'mediacall-signal', to: target, signal: message });
    }).catch((cause: unknown) => this.failure(cause));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.controller.abort();
    this.client?.close().catch(() => {});
  }
}