import assert from 'node:assert/strict';
import test from 'node:test';
import { hostedIce, hostedTurnOptions } from '../../../../src/server/hosted/turn.ts';

const options = { domain: 'demo.metered.live', apiKey: 'server-only-key' };

test('hosted TURN only accepts a configured Metered domain, not arbitrary credential destinations', () => {
  assert.equal(hostedTurnOptions({}), undefined);
  assert.equal(hostedTurnOptions({ METERED_DOMAIN: options.domain }), undefined);
  for (const domain of ['https://demo.metered.live', 'example.com', 'demo.metered.live.attacker.com', 'user:password@demo.metered.live', 'localhost']) {
    assert.equal(hostedTurnOptions({ METERED_DOMAIN: domain, METERED_API_KEY: options.apiKey }), undefined);
  }
  assert.deepEqual(hostedTurnOptions({ METERED_DOMAIN: options.domain, METERED_API_KEY: options.apiKey }), options);
});

test('hosted TURN fetches credentials server-side without caching or exposing the provider API key', async () => {
  const configuration = await hostedIce(options, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://demo.metered.live');
    assert.equal(url.searchParams.get('apiKey'), options.apiKey);
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.redirect, 'error');
    return Response.json([
      { urls: 'stun:stun.example.com:3478' },
      { urls: ['turn:relay.example.com:80?transport=udp', 'turns:relay.example.com:443?transport=tcp'], username: 'temporary-user', credential: 'temporary-password' },
    ]);
  });
  assert.equal(configuration.iceServers.length, 2);
  assert.ok(configuration.expiresAt > Date.now() / 1000);
  assert.doesNotMatch(JSON.stringify(configuration), /server-only-key/);
});

test('hosted TURN rejects STUN-only, malformed, and unauthenticated relay configurations', async () => {
  for (const body of [[], {}, [{ urls: 'stun:stun.example.com' }], [{ urls: 'turn:relay.example.com' }], [{ urls: 'https://example.com' }], [{ urls: ['turn:relay.example.com', 42], username: 'user', credential: 'password' }]]) {
    await assert.rejects(hostedIce(options, async () => Response.json(body)), /Hosted TURN is unavailable/);
  }
});

test('hosted TURN errors do not leak the provider API key', async () => {
  await assert.rejects(hostedIce(options, async (input) => { throw new Error(`Failed to request ${input}`); }), (error: Error) => {
    assert.doesNotMatch(error.message, /server-only-key|apiKey/);
    assert.match(error.message, /quota/);
    return true;
  });
  await assert.rejects(hostedIce(options, async () => Response.json({ error: 'Quota reached' }, { status: 429 })), /Hosted TURN is unavailable/);
});