import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PostgresRoomStore } from '../../../../src/server/hosted/roomStore.ts';
import { exchangeSignals, parseSignalRequest, SignalError } from '../../../../src/server/hosted/signaling.ts';
import type { RoomStore, SignalRequest, SignalResponse } from '../../../../src/server/hosted/signaling.ts';

const first: SignalRequest = { roomId: 'hosted-test-room-123456', peerId: 'a'.repeat(16), sessionToken: '1'.repeat(64), after: 0, join: { name: 'Alex', mode: 'auto' } };
const second: SignalRequest = { ...first, peerId: 'b'.repeat(16), sessionToken: '2'.repeat(64), join: { name: 'Sam', mode: 'relay' } };
function poll(request: SignalRequest, response?: SignalResponse): SignalRequest {
  return { roomId: request.roomId, peerId: request.peerId, sessionToken: request.sessionToken, after: response?.cursor ?? 0 };
}

test('hosted signaling persists two-person rooms, relay policy, forwarding, authentication, and departure in PostgreSQL', async (context) => {
  const database = new PGlite();
  context.after(() => database.close());
  const store = new PostgresRoomStore(async (text, parameters) => (await database.query<Record<string, unknown>>(text, parameters)).rows);
  const now = 1_800_000_000_000;
  const host = await exchangeSignals(store, first, now);
  assert.equal(host.events[0]?.signal.type, 'joined');
  const guest = await exchangeSignals(store, second, now + 1);
  const joined = guest.events[0]!.signal;
  assert.equal(joined.type === 'joined' && joined.mode, 'relay');
  assert.equal(joined.type === 'joined' && joined.peers[0]?.name, 'Alex');
  assert.doesNotMatch(JSON.stringify(guest), /secretHash|sessionToken/);
  const hostUpdated = await exchangeSignals(store, poll(first, host), now + 2);
  const peer = hostUpdated.events.find((entry) => entry.signal.type === 'peer-joined')!.signal;
  assert.equal(peer.type === 'peer-joined' && peer.mode, 'relay');
  const third = { ...first, peerId: 'c'.repeat(16), sessionToken: '3'.repeat(64) };
  await assert.rejects(exchangeSignals(store, third, now + 3), (error: SignalError) => error.code === 'room-full');
  await assert.rejects(exchangeSignals(store, { ...poll(first), sessionToken: 'f'.repeat(64) }, now + 4), (error: SignalError) => error.status === 401);
  await exchangeSignals(store, { ...poll(first, hostUpdated), messages: [{ type: 'description', description: { type: 'offer', sdp: 'v=0\r\n' } }, { type: 'ice', candidate: { candidate: 'candidate:relay', sdpMid: '0' } }, { type: 'media', media: { audio: false, video: true, sharing: false } }] }, now + 5);
  const forwarded = await exchangeSignals(store, poll(second, guest), now + 6);
  assert.deepEqual(forwarded.events.map((entry) => entry.signal.type), ['description', 'ice', 'media']);
  const replay = await exchangeSignals(store, poll(second, forwarded), now + 7);
  assert.equal(replay.events.length, 0);
  await exchangeSignals(store, { ...poll(first, hostUpdated), messages: [{ type: 'leave' }] }, now + 8);
  const departed = await exchangeSignals(store, poll(second, replay), now + 9);
  assert.equal(departed.events[0]?.signal.type, 'peer-left');
  assert.equal((await store.read(first.roomId, now + 10))?.body.members.length, 1);
});

test('hosted signaling expires abandoned peers, retains active peers, and clears stale rooms', async (context) => {
  const database = new PGlite();
  context.after(() => database.close());
  const store = new PostgresRoomStore(async (text, parameters) => (await database.query<Record<string, unknown>>(text, parameters)).rows);
  const now = 1_800_000_000_000;
  await exchangeSignals(store, first, now);
  const guest = await exchangeSignals(store, second, now + 1);
  const heartbeat = await exchangeSignals(store, poll(second, guest), now + 20_000);
  const expired = await exchangeSignals(store, poll(second, heartbeat), now + 31_000);
  assert.equal(expired.events[0]?.signal.type, 'peer-left');
  await assert.rejects(exchangeSignals(store, poll(first), now + 31_001), (error: SignalError) => error.status === 410);
  assert.equal(await store.read(first.roomId, now + 100_000), undefined);
  const rejoined = await exchangeSignals(store, first, now + 100_001);
  assert.equal(rejoined.events[0]?.signal.type, 'joined');
});

test('concurrent joins use compare-and-swap so only two participants can enter', async (context) => {
  const database = new PGlite();
  context.after(() => database.close());
  const store = new PostgresRoomStore(async (text, parameters) => (await database.query<Record<string, unknown>>(text, parameters)).rows);
  const now = 1_800_000_000_000;
  await exchangeSignals(store, first, now);
  const results = await Promise.allSettled([
    exchangeSignals(store, second, now + 1),
    exchangeSignals(store, { ...second, peerId: 'c'.repeat(16), sessionToken: '3'.repeat(64) }, now + 1),
  ]);
  assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal((await store.read(first.roomId, now + 2))?.body.members.length, 2);
});

test('signaling validates untrusted input and bounds compare-and-swap retries', async () => {
  assert.deepEqual(parseSignalRequest(first), first);
  for (const value of [{}, { ...first, roomId: '../private' }, { ...first, sessionToken: 'short' }, { ...first, after: -1 }, { ...first, join: { name: '\u0000', mode: 'auto' } }, { ...poll(first), messages: [{ type: 'ice', candidate: { candidate: 42 } }] }, { ...poll(first), messages: [{ type: 'description', description: { type: 'offer', sdp: 'x'.repeat(60_001) } }] }]) {
    assert.throws(() => parseSignalRequest(value), SignalError);
  }
  let retries = 0;
  const unavailable: RoomStore = {
    async create() {},
    async read() { return { version: 0, body: { mode: 'auto', members: [], sequence: 0, events: [] } }; },
    async replace() { retries++; return false; },
  };
  await assert.rejects(exchangeSignals(unavailable, first), (error: SignalError) => error.code === 'busy');
  assert.equal(retries, 8);
});