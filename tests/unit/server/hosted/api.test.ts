import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createHostedApi } from '../../../../src/server/hosted/api.ts';
import { PostgresRoomStore } from '../../../../src/server/hosted/roomStore.ts';
import type { RoomStore } from '../../../../src/server/hosted/signaling.ts';

const turn = { domain: 'demo.metered.live', apiKey: 'secret-provider-key' };

test('hosted Vercel API serves configuration, gated TURN credentials, and authenticated cross-request signaling', async (context) => {
  const database = new PGlite();
  const store = new PostgresRoomStore(async (text, parameters) => (await database.query<Record<string, unknown>>(text, parameters)).rows);
  let providerCalls = 0;
  const server = createServer(createHostedApi({
    store, turn, accessToken: 'test-access-token',
    provideIce: async () => { providerCalls++; return { iceServers: [{ urls: 'turn:relay.example.com:3478', username: 'temporary-user', credential: 'temporary-password' }], expiresAt: 1_900_000_000 }; },
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await database.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = await (await fetch(`${base}/api/config`)).json() as { defaultMode: string; relay: { managed: boolean } };
  assert.equal(config.defaultMode, 'auto');
  assert.equal(config.relay.managed, true);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/ice`)).status, 401);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${base}/api/ice`, { headers: { Authorization: 'Bearer test-access-token' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.text();
    assert.match(body, /"signalingTransport":"http"/);
    assert.doesNotMatch(body, /secret-provider-key/);
  }
  assert.equal(providerCalls, 1);
  const member = { roomId: 'hosted-api-room-123456', peerId: 'a'.repeat(16), sessionToken: 'b'.repeat(64), after: 0, join: { name: 'Alex', mode: 'relay' }, accessToken: 'test-access-token' };
  const post = (body: object, origin = base) => fetch(`${base}/api/signal`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await post(member, 'https://attacker.invalid')).status, 403);
  assert.equal((await post({ ...member, accessToken: 'wrong' })).status, 401);
  const joined = await post(member);
  assert.equal(joined.status, 200);
  assert.match(await joined.text(), /"type":"joined"/);
  const poll = new URL(`${base}/api/signal`);
  poll.searchParams.set('roomId', member.roomId);
  poll.searchParams.set('peerId', member.peerId);
  poll.searchParams.set('after', '0');
  assert.equal((await fetch(poll)).status, 400);
  assert.equal((await fetch(poll, { headers: { 'X-Call-Session': member.sessionToken } })).status, 200);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/api/ice`, { method: 'POST' })).status, 405);
  const metrics = await (await fetch(`${base}/api/relay`, { headers: { Authorization: 'Bearer test-access-token' } })).json() as { bytesToPeer: unknown; activeAllocations: unknown };
  assert.equal(metrics.bytesToPeer, null);
  assert.equal(metrics.activeAllocations, null);
});

test('hosted Vercel API explains missing free-service setup and does not expose database failures', async (context) => {
  const brokenStore: RoomStore = {
    async read() { throw new Error('postgres://private-user:private-password@private-host'); },
    async create() {}, async replace() { return false; },
  };
  for (const options of [{ store: undefined, turn: undefined }, { store: brokenStore, turn }]) {
    const server = createServer(createHostedApi(options));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    context.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.doesNotMatch(body, /private-password|postgres:\/\//);
    if (!options.store) { assert.match(body, /METERED_REALTIME_KEY_ID/); assert.match(body, /METERED_REALTIME_SECRET/); }
  }
});

test('Metered signing-key mode works without a database or TURN REST API key and protects token minting', async (context) => {
  const server = createServer(createHostedApi({
    store: undefined, turn: undefined,
    realtime: { keyId: 'sk_id_test_fixture', secret: 'sk_secret_test_fixture', channelPrefix: 'mediacall/' },
    provideToken: async (peer) => ({ token: 'test.header.signature', expiresAt: Math.floor(Date.now() / 1000) + 3600, peerId: 'a'.repeat(32), channel: `mediacall/${peer.roomId}` }),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/api/config`)).status, 200);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  const ice = await (await fetch(`${base}/api/ice`)).json() as { signalingTransport: string };
  assert.equal(ice.signalingTransport, 'metered');
  const request = { roomId: 'a-valid-test-room-1234', name: 'Alex', mode: 'relay' };
  const invalid = await fetch(`${base}/api/realtime`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' }, body: JSON.stringify(request) });
  assert.equal(invalid.status, 403);
  const issued = await fetch(`${base}/api/realtime`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(request) });
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get('cache-control'), 'no-store');
  const body = await issued.text();
  assert.match(body, /test.header.signature/);
  assert.doesNotMatch(body, /sk_secret_|sk_id_/);
});