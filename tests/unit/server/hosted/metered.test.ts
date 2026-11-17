import assert from 'node:assert/strict';
import test from 'node:test';
import { meteredSigningOptions, mintMeteredToken } from '../../../../src/server/hosted/metered.ts';

const options = { keyId: 'sk_id_test_fixture', secret: 'sk_secret_test_fixture', channelPrefix: 'mediacall/' };

test('Metered signing configuration requires server-side signing variables and a bounded channel prefix', () => {
  assert.equal(meteredSigningOptions({}), undefined);
  assert.equal(meteredSigningOptions({ METERED_REALTIME_KEY_ID: options.keyId }), undefined);
  assert.deepEqual(meteredSigningOptions({ METERED_REALTIME_KEY_ID: options.keyId, METERED_REALTIME_SECRET: options.secret }), options);
  assert.equal(meteredSigningOptions({ METERED_REALTIME_KEY_ID: options.keyId, METERED_REALTIME_SECRET: options.secret, METERED_CHANNEL_PREFIX: '*' }), undefined);
});

test('Metered mints room-scoped connection tokens without returning signing material or unrestricted direct-send permission', async () => {
  const issued = await mintMeteredToken(options, { roomId: 'a-valid-demo-room-id', name: 'Alex', mode: 'relay' }, async (input, init) => {
    assert.equal(input, 'https://rms.metered.ca/v1/tokens');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${options.keyId}:${options.secret}`);
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body)) as { peerId: string; channels: string[]; permissions: string[]; peerMetadata: { name: string; mode: string } };
    assert.match(body.peerId, /^[a-f0-9]{32}$/);
    assert.deepEqual(body.channels, ['mediacall/a-valid-demo-room-id']);
    assert.deepEqual(body.permissions, ['publish', 'subscribe', 'presence']);
    assert.deepEqual(body.peerMetadata, { name: 'Alex', mode: 'relay' });
    return Response.json({ token: 'test.header.signature', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  });
  assert.equal(issued.channel, 'mediacall/a-valid-demo-room-id');
  assert.doesNotMatch(JSON.stringify(issued), /sk_id_|sk_secret_/);
});

test('Metered errors and invalid token responses never expose signing secrets', async () => {
  for (const body of [{ token: 'invalid', expiresAt: Date.now() / 1000 + 100 }, { token: 'test.header.signature', expiresAt: 1 }, {}]) {
    await assert.rejects(mintMeteredToken(options, { roomId: 'a-valid-demo-room-id', name: 'Alex', mode: 'relay' }, async () => Response.json(body)), /Metered signaling is unavailable/);
  }
  await assert.rejects(mintMeteredToken(options, { roomId: 'a-valid-demo-room-id', name: 'Alex', mode: 'relay' }, async () => { throw new Error(options.secret); }), (error: Error) => {
    assert.doesNotMatch(error.message, /sk_secret_|test_fixture/);
    return true;
  });
});