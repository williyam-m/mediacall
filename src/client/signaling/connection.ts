import type { ClientSignal, IceConfig, ServerSignal } from '../../shared/types.ts';
import type { SignalResponse } from '../../server/hosted/signaling.ts';
import { MeteredSignalingConnection } from './metered.ts';

export interface SignalingConnection {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

class HttpSignalingConnection implements SignalingConnection {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly controller = new AbortController();
  private readonly peerId = crypto.randomUUID().replaceAll('-', '');
  private readonly sessionToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  private roomId = '';
  private after = 0;
  private joined = false;
  private leaving = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private messages: ClientSignal[] = [];
  private sending = false;

  constructor() {
    queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } });
  }

  private identity() { return { roomId: this.roomId, peerId: this.peerId, sessionToken: this.sessionToken, after: this.after }; }

  private async request(url: string | URL, init: RequestInit = {}): Promise<SignalResponse> {
    const response = await fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]) });
    const body = await response.json() as SignalResponse & { error?: string };
    if (!response.ok) throw new Error(body.error ?? 'Signaling request failed.');
    return body;
  }

  private deliver(response: SignalResponse) {
    if (this.readyState !== 1) return;
    for (const event of response.events) {
      if (event.sequence > this.after) this.onmessage?.({ data: JSON.stringify(event.signal) });
    }
    this.after = Math.max(this.after, response.cursor);
  }

  private failure(cause: unknown) {
    if (this.readyState !== 1) return;
    const message = cause instanceof Error ? cause.message : 'The signaling connection failed.';
    this.onmessage?.({ data: JSON.stringify({ type: 'error', code: 'signaling-failed', message } satisfies ServerSignal) });
  }

  send(data: string) {
    if (this.readyState !== 1) return;
    const message = JSON.parse(data) as ClientSignal;
    if (message.type === 'join') {
      this.roomId = message.roomId;
      this.request('/api/signal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...this.identity(), join: { name: message.name, mode: message.mode }, accessToken: message.accessToken }),
      }).then((response) => {
        this.joined = true;
        this.deliver(response);
        if (this.readyState === 1) this.poll();
        else this.leave();
      }).catch((cause: unknown) => this.failure(cause));
    } else if (message.type === 'leave') this.leave();
    else {
      this.messages.push(message);
      if (!this.flushTimer && !this.sending) this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flush(); }, 25);
    }
  }

  private async flush() {
    if (this.readyState !== 1 || !this.joined || this.sending || !this.messages.length) return;
    this.sending = true;
    const batch = this.messages.splice(0, 16);
    try {
      this.deliver(await this.request('/api/signal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...this.identity(), messages: batch }),
      }));
    } catch (cause) { this.failure(cause); }
    finally {
      this.sending = false;
      if (this.readyState === 1 && this.messages.length) this.flush();
    }
  }

  private async poll(failures = 0) {
    if (this.readyState !== 1 || !this.joined) return;
    const url = new URL('/api/signal', location.origin);
    url.searchParams.set('roomId', this.roomId);
    url.searchParams.set('peerId', this.peerId);
    url.searchParams.set('after', String(this.after));
    try {
      this.deliver(await this.request(url, { headers: { 'X-Call-Session': this.sessionToken } }));
      this.pollTimer = setTimeout(() => this.poll(), 750);
    } catch (cause) {
      if (this.readyState !== 1) return;
      if (failures >= 3) { this.failure(cause); return; }
      this.pollTimer = setTimeout(() => this.poll(failures + 1), 1000 * (failures + 1));
    }
  }

  private leave() {
    if (!this.joined || this.leaving) return;
    this.leaving = true;
    fetch('/api/signal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', keepalive: true,
      body: JSON.stringify({ ...this.identity(), messages: [{ type: 'leave' }] }),
    }).catch(() => {});
  }

  close() {
    if (this.readyState === 3) return;
    this.leave();
    this.readyState = 3;
    this.controller.abort();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.messages = [];
  }
}

export function createSignalingConnection(configuration: IceConfig): SignalingConnection {
  if (configuration.signalingTransport === 'metered') return new MeteredSignalingConnection(configuration);
  if (configuration.signalingTransport === 'http') return new HttpSignalingConnection();
  const websocket = new WebSocket(configuration.signalingUrl ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`);
  const connection: SignalingConnection = {
    get readyState() { return websocket.readyState; }, onopen: null, onmessage: null, onclose: null, onerror: null,
    send: (data) => websocket.send(data), close: () => websocket.close(),
  };
  websocket.onopen = () => connection.onopen?.();
  websocket.onmessage = (event: MessageEvent<string>) => connection.onmessage?.({ data: event.data });
  websocket.onclose = () => connection.onclose?.();
  websocket.onerror = () => connection.onerror?.();
  return connection;
}