import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { TurnServer, allowedPeer } from './server.ts';
import { Attr, attribute, decodeMessage, decodeXorAddress, encodeMessage, encodeXorAddress, uint32, verifyIntegrity } from './protocol.ts';
import type { Attribute, StunMessage } from './protocol.ts';

class Packets {
  private stored: Buffer[] = [];
  private waiting: { match: (packet: Buffer) => boolean; accept: (packet: Buffer) => void }[] = [];

  push(packet: Buffer) {
    const index = this.waiting.findIndex((entry) => entry.match(packet));
    if (index >= 0) this.waiting.splice(index, 1)[0]!.accept(packet);
    else this.stored.push(packet);
  }

  next(match: (packet: Buffer) => boolean = () => true, timeout = 2000): Promise<Buffer> {
    const index = this.stored.findIndex(match);
    if (index >= 0) return Promise.resolve(this.stored.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const entry = { match, accept: (packet: Buffer) => { clearTimeout(timer); resolve(packet); } };
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((candidate) => candidate !== entry);
        reject(new Error('Packet timed out'));
      }, timeout);
      this.waiting.push(entry);
    });
  }
}

async function client(kind: 'udp' | 'tcp' | 'tls', port: number) {
  const packets = new Packets();
  let send: (packet: Buffer) => void;
  let close: () => void;
  if (kind === 'udp') {
    const socket = dgram.createSocket('udp4');
    socket.bind(0, '127.0.0.1');
    await once(socket, 'listening');
    socket.on('message', (packet) => packets.push(packet));
    send = (packet) => { socket.send(packet, port, '127.0.0.1'); };
    close = () => socket.close();
  } else {
    const socket = kind === 'tls' ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }) : net.connect(port, '127.0.0.1');
    await once(socket, kind === 'tls' ? 'secureConnect' : 'connect');
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const channel = (buffered[0]! & 0xc0) === 0x40;
        if (!channel && buffered.length < 20) break;
        const length = channel ? (4 + buffered.readUInt16BE(2) + 3) & ~3 : 20 + buffered.readUInt16BE(2);
        if (buffered.length < length) break;
        packets.push(buffered.subarray(0, length));
        buffered = buffered.subarray(length);
      }
    });
    send = (packet) => { socket.write(packet); };
    close = () => socket.destroy();
  }
  return {
    send, close, packets,
    async request(packet: Buffer): Promise<StunMessage> {
      const transaction = packet.subarray(8, 20);
      const response = packets.next((candidate) => decodeMessage(candidate)?.transactionId.equals(transaction) === true);
      send(packet);
      return decodeMessage(await response)!;
    },
  };
}

function code(message: StunMessage) {
  const value = attribute(message, Attr.ERROR_CODE)!;
  return value[2]! * 100 + value[3]!;
}

for (const kind of ['udp', 'tcp', 'tls'] as const) {
  test(`TURN ${kind}: authentication, allocation, permissions, indications, channels, refresh`, { timeout: 10_000 }, async (context) => {
    let tlsOptions: { port: number; key: Buffer; cert: Buffer } | undefined;
    if (kind === 'tls') {
      const directory = mkdtempSync(join(tmpdir(), 'mediacall-tls-'));
      context.after(() => rmSync(directory, { recursive: true, force: true }));
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
      const reservation = net.createServer();
      reservation.listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const port = (reservation.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      tlsOptions = { port, key: readFileSync(join(directory, 'key.pem')), cert: readFileSync(join(directory, 'cert.pem')) };
    }
    const server = new TurnServer({ secret: 'test-secret', publicAddress: '127.0.0.1', bindAddress: '127.0.0.1', port: 0, relayMinPort: 51000, relayMaxPort: 51030, allowPrivatePeers: true,
      ...(tlsOptions ? { tls: tlsOptions } : {}) });
    await server.start();
    context.after(() => server.stop());
    const connection = await client(kind, tlsOptions?.port ?? server.port);
    context.after(() => connection.close());
    const transport: Attribute = { type: Attr.REQUESTED_TRANSPORT, value: Buffer.from([17, 0, 0, 0]) };
    const challenge = await connection.request(encodeMessage(0x0003, undefined, [transport]));
    assert.equal(code(challenge), 401);
    const credentials = server.auth.credentials();
    const key = server.auth.key(credentials.username)!;
    const auth: Attribute[] = [
      { type: Attr.USERNAME, value: Buffer.from(credentials.username) },
      { type: Attr.REALM, value: attribute(challenge, Attr.REALM)! },
      { type: Attr.NONCE, value: attribute(challenge, Attr.NONCE)! },
    ];
    const allocatePacket = encodeMessage(0x0003, randomBytes(12), [...auth, transport], key);
    const allocated = await connection.request(allocatePacket);
    assert.equal(allocated.type, 0x0103);
    assert.equal(verifyIntegrity(allocated, key), true);
    const relay = decodeXorAddress(attribute(allocated, Attr.XOR_RELAYED_ADDRESS))!;
    assert.equal(relay.address, '127.0.0.1');
    assert.equal(server.stats().activeAllocations, 1);
    assert.deepEqual((await connection.request(allocatePacket)).raw, allocated.raw);
    assert.equal(server.stats().activeAllocations, 1);
    assert.equal(code(await connection.request(encodeMessage(0x0003, undefined, [...auth, transport], key))), 437);

    const peerSocket = dgram.createSocket('udp4');
    peerSocket.bind(0, '127.0.0.1');
    await once(peerSocket, 'listening');
    context.after(() => peerSocket.close());
    const peerPackets = new Packets();
    peerSocket.on('message', (packet) => peerPackets.push(packet));
    const peer = { address: '127.0.0.1', port: peerSocket.address().port };
    peerSocket.send(Buffer.from('uninvited'), relay.port, relay.address);
    await assert.rejects(connection.packets.next(() => true, 80), /timed out/);

    const permission = await connection.request(encodeMessage(0x0008, undefined, [...auth, { type: Attr.XOR_PEER_ADDRESS, value: encodeXorAddress(peer) }], key));
    assert.equal(permission.type, 0x0108);
    connection.send(encodeMessage(0x0016, undefined, [
      { type: Attr.XOR_PEER_ADDRESS, value: encodeXorAddress(peer) }, { type: Attr.DATA, value: Buffer.from('hello peer') },
    ]));
    assert.equal((await peerPackets.next()).toString(), 'hello peer');
    peerSocket.send(Buffer.from('hello client'), relay.port, relay.address);
    const indication = decodeMessage(await connection.packets.next())!;
    assert.equal(indication.type, 0x0017);
    assert.equal(attribute(indication, Attr.DATA)?.toString(), 'hello client');

    const channelNumber = Buffer.from([0x40, 0x01, 0, 0]);
    const bound = await connection.request(encodeMessage(0x0009, undefined, [...auth,
      { type: Attr.CHANNEL_NUMBER, value: channelNumber }, { type: Attr.XOR_PEER_ADDRESS, value: encodeXorAddress(peer) },
    ], key));
    assert.equal(bound.type, 0x0109);
    const data = Buffer.from('odd');
    const channelPacket = Buffer.alloc(kind === 'udp' ? 7 : 8);
    channelPacket.writeUInt16BE(0x4001);
    channelPacket.writeUInt16BE(data.length, 2);
    data.copy(channelPacket, 4);
    connection.send(channelPacket);
    assert.equal((await peerPackets.next()).toString(), 'odd');
    peerSocket.send(data, relay.port, relay.address);
    const received = await connection.packets.next();
    assert.equal(received.readUInt16BE(0), 0x4001);
    assert.equal(received.subarray(4, 7).toString(), 'odd');
    assert.equal(received.length, kind === 'udp' ? 7 : 8);

    const refreshed = await connection.request(encodeMessage(0x0004, undefined, [...auth, { type: Attr.LIFETIME, value: uint32(30) }], key));
    assert.equal(attribute(refreshed, Attr.LIFETIME)?.readUInt32BE(0), 30);
    const deleted = await connection.request(encodeMessage(0x0004, undefined, [...auth, { type: Attr.LIFETIME, value: uint32(0) }], key));
    assert.equal(deleted.type, 0x0104);
    assert.equal(server.stats().activeAllocations, 0);
    assert.ok(server.stats().bytesToPeer >= 13);
    assert.ok(server.stats().bytesToClient >= 15);
  });
}

test('rejects forged authentication, unsigned attributes, forbidden peers, unsupported transports, and allocation overflow', { timeout: 10_000 }, async (context) => {
  const server = new TurnServer({ secret: 'test-secret', publicAddress: '127.0.0.1', bindAddress: '127.0.0.1', port: 0, relayMinPort: 51040, relayMaxPort: 51050, maxAllocations: 1 });
  await server.start();
  context.after(() => server.stop());
  const connection = await client('udp', server.port);
  context.after(() => connection.close());
  const credentials = server.auth.credentials();
  const key = server.auth.key(credentials.username)!;
  const auth: Attribute[] = [
    { type: Attr.USERNAME, value: Buffer.from(credentials.username) },
    { type: Attr.REALM, value: Buffer.from(server.auth.realm) },
    { type: Attr.NONCE, value: Buffer.from(server.auth.nonce('127.0.0.1')) },
  ];
  const transport: Attribute = { type: Attr.REQUESTED_TRANSPORT, value: Buffer.from([17, 0, 0, 0]) };
  assert.equal(code(await connection.request(encodeMessage(0x0003, undefined, [...auth, transport], Buffer.from('wrong')))), 401);
  const stale = [...auth.slice(0, 2), { type: Attr.NONCE, value: Buffer.from(server.auth.nonce('127.0.0.1', Date.now() - 700_000)) }];
  assert.equal(code(await connection.request(encodeMessage(0x0003, undefined, [...stale, transport], key))), 438);
  const signed = decodeMessage(encodeMessage(0x0003, undefined, [...auth, transport], key, false))!;
  const unsigned = encodeMessage(0x0003, signed.transactionId, [...signed.attributes, { type: Attr.LIFETIME, value: uint32(999) }]);
  assert.equal(verifyIntegrity(decodeMessage(unsigned)!, key), true);
  assert.equal(code(await connection.request(unsigned)), 400);
  assert.equal(code(await connection.request(encodeMessage(0x0003, undefined, [...auth, { type: Attr.REQUESTED_TRANSPORT, value: Buffer.from([6, 0, 0, 0]) }], key))), 442);
  assert.equal(code(await connection.request(encodeMessage(0x0003, undefined, [...auth, transport, { type: 0x0030, value: Buffer.alloc(4) }], key))), 420);
  assert.equal((await connection.request(encodeMessage(0x0003, undefined, [...auth, transport], key))).type, 0x0103);
  assert.equal(code(await connection.request(encodeMessage(0x0008, undefined, [...auth, { type: Attr.XOR_PEER_ADDRESS, value: encodeXorAddress({ address: '127.0.0.1', port: 12345 }) }], key))), 403);
  const second = await client('udp', server.port);
  context.after(() => second.close());
  assert.equal(code(await second.request(encodeMessage(0x0003, undefined, [...auth, transport], key))), 486);
  assert.equal(server.stats().activeAllocations, 1);
});

test('production peer policy blocks loopback, RFC1918, link-local, and multicast', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.2.1', '192.168.1.1', '169.254.1.1', '224.0.0.1', '100.64.0.1']) {
    assert.equal(allowedPeer(address, false), false, address);
  }
  assert.equal(allowedPeer('8.8.8.8', false), true);
  assert.equal(allowedPeer('127.0.0.1', true), true);
  assert.equal(allowedPeer('224.0.0.1', true), false);
});