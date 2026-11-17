import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { TurnAuth, validAccessToken } from '../../../../src/server/custom-turn/auth.ts';
import { TokenBucket } from '../../../../src/server/http/limits.ts';

test('issues temporary REST credentials compatible with TURN long-term authentication', () => {
  const auth = new TurnAuth('test-secret', 'mediacall');
  const now = 1_800_000_000_000;
  const credentials = auth.credentials(60, now);
  const expected = createHash('md5').update(`${credentials.username}:mediacall:${credentials.credential}`).digest();
  assert.deepEqual(auth.key(credentials.username, false, now), expected);
  assert.equal(auth.key(credentials.username, false, now + 61_000), undefined);
  assert.deepEqual(auth.key(credentials.username, true, now + 61_000), expected);
  assert.equal(auth.key('invalid'), undefined);
});

test('nonce signatures are address-bound and distinguish stale from forged nonces', () => {
  const auth = new TurnAuth('test-secret', 'mediacall', 30);
  const now = 1_800_000_000_000;
  const nonce = auth.nonce('127.0.0.1', now);
  assert.equal(auth.verifyNonce(nonce, '127.0.0.1', now), 'valid');
  assert.equal(auth.verifyNonce(nonce, '127.0.0.2', now), 'invalid');
  assert.equal(auth.verifyNonce(nonce, '127.0.0.1', now + 31_000), 'stale');
  assert.equal(auth.verifyNonce(`${nonce}x`, '127.0.0.1', now), 'invalid');
});

test('access tokens fail closed and byte quotas reject an oversized burst', () => {
  assert.equal(validAccessToken(undefined, 'private'), false);
  assert.equal(validAccessToken('private', 'private'), true);
  assert.equal(validAccessToken('privatE', 'private'), false);
  assert.equal(validAccessToken(undefined, undefined), true);
  const bucket = new TokenBucket(10, 0);
  assert.equal(bucket.take(6), true);
  assert.equal(bucket.take(5), false);
  assert.equal(bucket.take(4), true);
});