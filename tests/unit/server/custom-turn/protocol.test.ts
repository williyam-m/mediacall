import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Attr, attribute, decodeMessage, decodeXorAddress, encodeMessage, encodeXorAddress, verifyFingerprint, verifyIntegrity } from '../../../../src/server/custom-turn/protocol.ts';

test('verifies the RFC 5769 STUN request, including nonzero attribute padding', () => {
  const packet = Buffer.from(
    '000100582112a442b7e7a701bc34d686fa87dfae' +
    '802200105354554e207465737420636c69656e74' +
    '002400046e0001ff' +
    '80290008932ff9b151263b36' +
    '000600096576746a3a68367659202020' +
    '000800149aeaa70cbfd8cb56781ef2b5b2d3f249c1b571a2' +
    '80280004e57a3bcf', 'hex',
  );
  const message = decodeMessage(packet)!;
  assert.ok(message);
  assert.equal(attribute(message, Attr.USERNAME)?.toString(), 'evtj:h6vY');
  assert.equal(verifyIntegrity(message, Buffer.from('VOkJxbRl1RmTxUk/WvJxBt')), true);
  assert.equal(verifyFingerprint(message), true);
});

test('encodes authenticated packets and detects tampering', () => {
  const key = createHash('md5').update('alice:mediacall:secret').digest();
  const raw = encodeMessage(0x0003, undefined, [{ type: Attr.USERNAME, value: Buffer.from('alice') }], key);
  assert.equal(verifyIntegrity(decodeMessage(raw)!, key), true);
  assert.equal(verifyFingerprint(decodeMessage(raw)!), true);
  raw[24] = raw[24]! ^ 1;
  assert.equal(verifyIntegrity(decodeMessage(raw)!, key), false);
  assert.equal(verifyFingerprint(decodeMessage(raw)!), false);
});

test('round trips XOR IPv4 addresses and matches the RFC 5769 response address', () => {
  assert.deepEqual(decodeXorAddress(Buffer.from('0001a147e112a643', 'hex')), { address: '192.0.2.1', port: 32853 });
  const peer = { address: '203.0.113.42', port: 54321 };
  assert.deepEqual(decodeXorAddress(encodeXorAddress(peer)), peer);
  assert.equal(decodeXorAddress(Buffer.alloc(8)), undefined);
});

test('rejects malformed lengths and truncated attribute padding', () => {
  const raw = encodeMessage(0x0001, undefined, [{ type: Attr.USERNAME, value: Buffer.from('x') }]);
  assert.equal(decodeMessage(raw.subarray(0, raw.length - 1)), undefined);
  const malformed = Buffer.from(raw);
  malformed.writeUInt16BE(65535, 22);
  assert.equal(decodeMessage(malformed), undefined);
  assert.equal(decodeMessage(Buffer.alloc(19)), undefined);
});