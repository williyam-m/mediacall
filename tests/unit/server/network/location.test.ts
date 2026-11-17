import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocationLookup } from '../../../../src/server/network/location.ts';

test('relay location rejects hostnames and skips private, loopback, reserved, mapped, and IPv6 local addresses', async () => {
  let requests = 0;
  const lookup = createLocationLookup(async () => { requests++; throw new Error('Must not contact provider'); });
  for (const address of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.20.10.2', '169.254.1.1', '100.64.1.1', '224.0.0.1', '203.0.113.1', '::1', 'fe80::1', 'fd12::1', '2001:db8::1', '::ffff:127.0.0.1']) {
    assert.equal((await lookup(address)).status, 'private', address);
  }
  for (const address of ['localhost', 'relay.example.com', 'https://8.8.8.8', '8.8.8.8/path', '8.8.8.8?url=private', '']) await assert.rejects(lookup(address), /valid IPv4 or IPv6/);
  assert.equal(requests, 0);
});

test('relay location uses a fixed HTTPS provider and caches public IP lookups', async () => {
  let requests = 0;
  const lookup = createLocationLookup(async (url, init) => {
    requests++;
    assert.equal(url, 'https://ipwho.is/8.8.8.8');
    assert.equal(init?.redirect, 'error');
    return Response.json({ success: true, ip: '8.8.8.8', country: 'United States', country_code: 'US', region: 'California', city: 'Mountain View', connection: { asn: 15169, org: 'Google LLC' }, timezone: { id: 'America/Los_Angeles' } });
  });
  const [first, second] = await Promise.all([lookup('8.8.8.8'), lookup('8.8.8.8')]);
  assert.equal(first.status, 'located');
  assert.equal(first.city, 'Mountain View');
  assert.equal(first.asn, 15169);
  assert.equal(first.source, 'ipwho.is');
  assert.equal(first.approximate, true);
  assert.deepEqual(first, second);
  assert.deepEqual(await lookup('8.8.8.8'), first);
  assert.equal(requests, 1);
});

test('location failures are explicit and cannot substitute metadata for a different relay IP', async () => {
  for (const provider of [async () => { throw new Error('Unavailable'); }, async () => Response.json({ success: true, ip: '1.1.1.1', city: 'Wrong place' }), async () => Response.json({ success: false })]) {
    const result = await createLocationLookup(provider)('8.8.8.8');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.city, null);
    assert.equal(result.source, null);
  }
});