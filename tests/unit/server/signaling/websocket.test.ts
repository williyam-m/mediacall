import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import test from 'node:test';
import { SignalingServer } from '../../../../src/server/signaling/websocket.ts';
import type { ServerSignal } from '../../../../src/shared/types.ts';

test('signaling enforces access, two peers, room policy, forwarding, and cleanup', { timeout: 10_000 }, async (context) => {
  const http = createServer();
  const signaling = new SignalingServer(http, { accessToken: 'test-token' });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  context.after(async () => { await signaling.close(); await new Promise<void>((resolve) => http.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const connections: WebSocket[] = [];
  context.after(() => { for (const socket of connections) socket.terminate(); });
  async function connect() {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/signal', { origin });
    connections.push(socket);
    const messages: ServerSignal[] = [];
    const pending: { type: string; resolve: (message: ServerSignal) => void }[] = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as ServerSignal;
      const index = pending.findIndex((entry) => entry.type === message.type);
      if (index >= 0) pending.splice(index, 1)[0]!.resolve(message);
      else messages.push(message);
    });
    await once(socket, 'open');
    return {
      send: (message: object) => socket.send(JSON.stringify(message)),
      next(type: string): Promise<ServerSignal> {
        const index = messages.findIndex((message) => message.type === type);
        if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]!);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Missing ${type}`)), 2000);
          pending.push({ type, resolve: (message) => { clearTimeout(timer); resolve(message); } });
        });
      },
    };
  }
  const join = { type: 'join', roomId: 'a-high-entropy-test-room', name: 'Alex', mode: 'relay', accessToken: 'test-token' };
  const unauthorized = await connect();
  unauthorized.send({ ...join, accessToken: 'wrong' });
  const failure = await unauthorized.next('error');
  assert.equal(failure.type === 'error' && failure.code, 'unauthorized');
  const first = await connect();
  first.send(join);
  const firstJoined = await first.next('joined');
  assert.equal(firstJoined.type === 'joined' && firstJoined.peers.length, 0);
  const second = await connect();
  second.send({ ...join, name: 'Sam', mode: 'auto' });
  const secondJoined = await second.next('joined');
  assert.equal(secondJoined.type === 'joined' && secondJoined.mode, 'relay');
  assert.equal(secondJoined.type === 'joined' && secondJoined.peers[0]?.name, 'Alex');
  assert.equal((await first.next('peer-joined')).type, 'peer-joined');
  const third = await connect();
  third.send(join);
  const full = await third.next('error');
  assert.equal(full.type === 'error' && full.code, 'room-full');
  first.send({ type: 'description', description: { type: 'offer', sdp: 'v=0\r\n' } });
  assert.equal((await second.next('description')).type, 'description');
  second.send({ type: 'ice', candidate: { candidate: 'candidate:1 1 UDP 1 127.0.0.1 12345 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.equal((await first.next('ice')).type, 'ice');
  first.send({ type: 'media', media: { audio: false, video: true, sharing: false } });
  const media = await second.next('media');
  assert.equal(media.type === 'media' && media.media.audio, false);
  first.send({ type: 'leave' });
  assert.equal((await second.next('peer-left')).type, 'peer-left');
  second.send({ type: 'leave' });
  await once(connections[2]!, 'close');
  assert.equal(signaling.stats().rooms, 0);
  const automaticHost = await connect();
  automaticHost.send({ ...join, roomId: 'another-high-entropy-room', mode: 'auto' });
  await automaticHost.next('joined');
  const relayGuest = await connect();
  relayGuest.send({ ...join, roomId: 'another-high-entropy-room' });
  const guestJoined = await relayGuest.next('joined');
  const hostNotified = await automaticHost.next('peer-joined');
  assert.equal(guestJoined.type === 'joined' && guestJoined.mode, 'relay');
  assert.equal(hostNotified.type === 'peer-joined' && hostNotified.mode, 'relay');
});

test('production protects credentials and metrics and serves a strict script policy', { timeout: 20_000 }, async (context) => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const turnPort = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const token = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, ['src/server/index.ts', '--production'], {
    env: {
      ...process.env, PORT: '0', HOST: '127.0.0.1', TURN_PORT: String(turnPort), TURN_PUBLIC_IP: '203.0.113.7',
      TURN_BIND_IP: '127.0.0.1', TURN_RELAY_BIND_IP: '127.0.0.1', TURN_SECRET: randomBytes(32).toString('hex'),
      APP_ACCESS_TOKEN: token, APP_ORIGIN: '', ALLOW_ANONYMOUS: 'false', TURN_ALLOW_PRIVATE_PEERS: 'false', TURN_TLS_CERT: '', TURN_TLS_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill('SIGTERM');
      await ended;
    }
  });
  const app = await new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Production startup timed out')), 12_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (exitCode) => { clearTimeout(timer); reject(new Error(`Production exited with ${exitCode}: ${stderr}`)); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      for (const line of stdout.split('\n')) {
        try {
          const event = JSON.parse(line) as { event: string; app: string };
          if (event.event === 'ready') { clearTimeout(timer); resolve(event.app.replace('localhost', '127.0.0.1')); }
        } catch {}
      }
    });
  });
  const health = await fetch(`${app}/api/health`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-security-policy') ?? '', /script-src 'self';/);
  const config = await (await fetch(`${app}/api/config`)).json() as { requiresAccessToken: boolean };
  assert.equal(config.requiresAccessToken, true);
  assert.equal((await fetch(`${app}/api/ice`)).status, 401);
  assert.equal((await fetch(`${app}/api/ice`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${app}/api/relay`)).status, 401);
  const credentials = await fetch(`${app}/api/ice`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(credentials.status, 200);
  assert.equal(credentials.headers.get('cache-control'), 'no-store');
  const body = await credentials.json() as { iceServers: RTCIceServer[]; expiresAt: number };
  assert.equal(body.iceServers.length, 2);
  assert.ok(body.iceServers[1]?.username);
  assert.ok(body.iceServers[1]?.credential);
  assert.ok(body.expiresAt > Date.now() / 1000);
  assert.equal((await fetch(`${app}/api/relay`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(`${app}/api/ice`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 405);
});