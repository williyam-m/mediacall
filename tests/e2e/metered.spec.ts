import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';
import { createHostedApi } from '../../src/server/hosted/api.ts';
import { TurnServer } from '../../src/server/custom-turn/server.ts';

interface FixturePeer { peerId: string; name: string; mode: 'auto' | 'relay'; channel: string; socket?: WebSocket; subscribed?: boolean }

test('managed SDK signaling injects TURN, enforces relay mode, handles room capacity, and leaves cleanly', async ({ browser }, info) => {
  const turn = new TurnServer({ secret: 'test-only-managed-relay-fixture', publicAddress: '127.0.0.1', bindAddress: '127.0.0.1', port: 0, relayMinPort: 51140, relayMaxPort: 51180, allowPrivatePeers: true });
  await turn.start();
  const vite = await createViteServer({ server: { middlewareMode: true, hmr: false }, appType: 'spa' });
  const tickets = new Map<string, FixturePeer>();
  let base = '';
  const api = createHostedApi({
    store: undefined, turn: undefined,
    realtime: { keyId: 'sk_id_test_fixture', secret: 'sk_secret_test_fixture', channelPrefix: 'mediacall/' },
    get realtimeOrigin() { return base.replace('http:', 'ws:'); },
    provideToken: async (peer) => {
      const token = randomBytes(24).toString('hex');
      const member: FixturePeer = { peerId: randomBytes(16).toString('hex'), name: peer.name, mode: peer.mode, channel: `mediacall/${peer.roomId}` };
      tickets.set(token, member);
      return { token, peerId: member.peerId, channel: member.channel, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    },
  });
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/api/')) api(request, response);
    else vite.middlewares(request, response);
  });
  const sockets = new WebSocketServer({ noServer: true });
  const send = (peer: FixturePeer, message: object) => { if (peer.socket?.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(message)); };
  const presence = (peer: FixturePeer) => ({ peerId: peer.peerId, metadata: { name: peer.name, mode: peer.mode } });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const peer = tickets.get(url.searchParams.get('token') ?? '');
    if (url.pathname !== '/v1' || !peer) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, (connection) => {
      peer.socket = connection;
      const credentials = turn.auth.credentials();
      send(peer, { type: 'welcome', peerId: peer.peerId, expiresAt: credentials.expiresAt, serverTime: Math.floor(Date.now() / 1000), maxMessageSize: 65536,
        metadata: { iceServers: [{ urls: [`turn:127.0.0.1:${turn.port}?transport=udp`], username: credentials.username, credential: credentials.credential }] } });
      connection.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; requestId: string; channel: string; data: unknown };
        const others = [...tickets.values()].filter((entry) => entry !== peer && entry.subscribed && entry.channel === peer.channel);
        if (message.type === 'subscribe' && message.channel === peer.channel) {
          peer.subscribed = true;
          send(peer, { type: 'ack', requestId: message.requestId, ok: true });
          send(peer, { type: 'presence', channel: peer.channel, joined: others.map(presence), left: [] });
          for (const other of others) send(other, { type: 'presence', channel: peer.channel, joined: [presence(peer)], left: [] });
        } else if (message.type === 'publish' && message.channel === peer.channel) {
          send(peer, { type: 'ack', requestId: message.requestId, ok: true });
          for (const other of others) send(other, { type: 'message', channel: peer.channel, from: peer.peerId, data: message.data });
        }
      });
      connection.on('close', () => {
        peer.subscribed = false;
        for (const other of tickets.values()) if (other !== peer && other.subscribed && other.channel === peer.channel) send(other, { type: 'presence', channel: peer.channel, joined: [], left: [presence(peer)] });
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const contexts = [];
  try {
    const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 900 } });
    contexts.push(hostContext);
    const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 390, height: 844 } });
    contexts.push(guestContext);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    await host.goto(base);
    await expect(host.getByRole('button', { name: 'Create call', exact: true })).toBeEnabled();
    await host.getByRole('button', { name: 'Test relay', exact: true }).click();
    await expect(host.getByText('Relay allocated', { exact: true })).toBeVisible();
    await host.getByRole('button', { name: 'Automatic', exact: true }).click();
    await host.getByLabel('Your name', { exact: true }).fill('Alex Morgan');
    await host.getByRole('button', { name: 'Create call', exact: true }).click();
    await expect(host.getByTestId('call-status')).toHaveText('Waiting for guest');
    const invite = await host.getByRole('textbox', { name: 'Invite link', exact: true }).inputValue();
    await guest.goto(invite);
    await guest.getByLabel('Your name', { exact: true }).fill('Sam Rivera');
    await guest.getByRole('button', { name: 'Force TURN', exact: true }).click();
    await guest.getByRole('button', { name: 'Join call', exact: true }).click();
    for (const page of [host, guest]) {
      await expect(page.getByTestId('call-status')).toHaveText('Connected');
      await expect(page.getByTestId('connection-route')).toHaveText('TURN relay');
      await expect.poll(() => page.getByTestId('remote-video').evaluate((element) => (element as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    }
    await host.getByRole('button', { name: 'Open relay console', exact: true }).click();
    await expect(host.getByTestId('ice-candidate-pair')).toHaveText('relay / relay');
    await host.screenshot({ path: info.outputPath('managed-force-turn-desktop.png') });
    await host.getByRole('button', { name: 'Close relay console', exact: true }).click();
    await guest.screenshot({ path: info.outputPath('managed-force-turn-mobile.png') });
    const thirdContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
    contexts.push(thirdContext);
    const third = await thirdContext.newPage();
    await third.goto(invite);
    await third.getByLabel('Your name', { exact: true }).fill('Third participant');
    await third.getByRole('button', { name: 'Join call', exact: true }).click();
    await expect(third.getByRole('alert')).toContainText('already has two people');
    await expect(host.getByTestId('call-status')).toHaveText('Connected');
    await host.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    await expect(guest.locator('.participant .lucide-mic-off')).toHaveCount(1);
    await host.getByRole('button', { name: 'Leave call', exact: true }).click();
    await expect(guest.getByTestId('call-status')).toHaveText('Waiting for guest');
    expect(turn.stats().bytesToPeer).toBeGreaterThan(0);
    expect(turn.stats().bytesToClient).toBeGreaterThan(0);
  } finally {
    for (const context of contexts) await context.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await vite.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await turn.stop();
  }
});