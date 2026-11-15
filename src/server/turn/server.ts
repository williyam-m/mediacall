import dgram from 'node:dgram';
import type { Socket as DatagramSocket } from 'node:dgram';
import net from 'node:net';
import type { Server as TcpServer, Socket as TcpSocket } from 'node:net';
import tls from 'node:tls';
import { TurnAuth } from './auth.ts';
import { IpLimiter, TokenBucket } from '../limits.ts';
import { Attr, attribute, decodeMessage, decodeXorAddress, encodeMessage, encodeXorAddress, errorValue, uint32, verifyFingerprint, verifyIntegrity } from './protocol.ts';
import type { Address, Attribute, StunMessage } from './protocol.ts';

export interface TurnOptions {
  secret: string;
  publicAddress: string;
  realm?: string;
  port?: number;
  bindAddress?: string;
  relayBindAddress?: string;
  relayMinPort?: number;
  relayMaxPort?: number;
  maxAllocations?: number;
  maxAllocationsPerIp?: number;
  bytesPerSecond?: number;
  allowPrivatePeers?: boolean;
  tls?: { port: number; key: Buffer; cert: Buffer };
}

interface Transport {
  id: string;
  kind: 'udp' | 'tcp' | 'tls';
  peer: Address;
  send: (packet: Buffer) => boolean;
  open: () => boolean;
  close: () => void;
}

interface Channel {
  peer: Address;
  expiresAt: number;
}

interface Allocation {
  transport: Transport;
  username: string;
  socket: DatagramSocket;
  port: number;
  expiresAt: number;
  permissions: Map<string, number>;
  channels: Map<number, Channel>;
  bandwidth: TokenBucket;
}

const SOFTWARE: Attribute = { type: Attr.SOFTWARE, value: Buffer.from('MediaCall Relay/0.1') };
const REQUIRED_ATTRIBUTES = new Set<number>([
  Attr.USERNAME, Attr.MESSAGE_INTEGRITY, Attr.REALM, Attr.NONCE, Attr.REQUESTED_TRANSPORT,
  Attr.LIFETIME, Attr.XOR_PEER_ADDRESS, Attr.CHANNEL_NUMBER, Attr.DATA,
  Attr.REQUESTED_ADDRESS_FAMILY, Attr.EVEN_PORT, Attr.RESERVATION_TOKEN,
]);

export function allowedPeer(address: string, allowPrivate: boolean): boolean {
  if (!net.isIPv4(address)) return false;
  const [first = 0, second = 0] = address.split('.').map(Number);
  if (first === 0 || first >= 224 || (first === 169 && second === 254)) return false;
  if (allowPrivate) return true;
  return !(first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 168 || second === 0)) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 198 && (second === 18 || second === 19)));
}

export class TurnServer {
  readonly auth: TurnAuth;
  private readonly options: Required<Omit<TurnOptions, 'tls'>> & { tls: TurnOptions['tls'] };
  private udp: DatagramSocket | undefined;
  private tcp: TcpServer | undefined;
  private tlsServer: TcpServer | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly allocations = new Map<string, Allocation>();
  private readonly pendingAllocations = new Map<string, string>();
  private readonly clients = new Map<string, Transport>();
  private readonly responses = new Map<string, { packet: Buffer; expiresAt: number }>();
  private readonly requests = new IpLimiter(160, 80);
  private readonly connections = new IpLimiter(24, 2);
  private nextPort: number;
  private serial = 0;
  private closed = false;
  private startedAt = Date.now();
  port = 0;
  private counters = { created: 0, bytesToPeer: 0, bytesToClient: 0, dropped: 0, authFailures: 0 };

  constructor(options: TurnOptions) {
    this.options = {
      realm: 'mediacall', port: 3478, bindAddress: '0.0.0.0', relayBindAddress: options.bindAddress ?? '0.0.0.0',
      relayMinPort: 49160, relayMaxPort: 49259, maxAllocations: 128, maxAllocationsPerIp: 8,
      bytesPerSecond: 2_000_000, allowPrivatePeers: false, ...options, tls: options.tls,
    };
    if (!net.isIPv4(options.publicAddress)) throw new Error('TURN_PUBLIC_IP must be an IPv4 address');
    if (this.options.relayMinPort < 1024 || this.options.relayMaxPort > 65535 || this.options.relayMinPort > this.options.relayMaxPort) {
      throw new Error('Invalid TURN relay port range');
    }
    this.options.maxAllocations = Math.min(this.options.maxAllocations, this.options.relayMaxPort - this.options.relayMinPort + 1);
    this.nextPort = this.options.relayMinPort;
    this.auth = new TurnAuth(options.secret, this.options.realm);
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    const udp = dgram.createSocket('udp4');
    this.udp = udp;
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(this.options.port, this.options.bindAddress, () => {
        udp.off('error', reject);
        resolve();
      });
    });
    this.port = udp.address().port;
    udp.on('error', () => { this.counters.dropped++; });
    udp.on('message', (packet, remote) => {
      const transport: Transport = {
        id: `udp:${remote.address}:${remote.port}`, kind: 'udp', peer: { address: remote.address, port: remote.port },
        send: (data) => {
          if (this.closed) return false;
          udp.send(data, remote.port, remote.address, (error) => { if (error) this.counters.dropped++; });
          return true;
        },
        open: () => !this.closed, close: () => {},
      };
      this.receive(packet, transport);
    });
    try {
      this.tcp = net.createServer((socket) => this.acceptStream(socket, 'tcp'));
      await this.listen(this.tcp, this.port);
      if (this.options.tls) {
        this.tlsServer = tls.createServer({ ...this.options.tls, minVersion: 'TLSv1.2' }, (socket) => this.acceptStream(socket, 'tls'));
        this.tlsServer.on('tlsClientError', () => { this.counters.dropped++; });
        await this.listen(this.tlsServer, this.options.tls.port);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.timer = setInterval(() => this.expire(), 1000);
    this.timer.unref();
  }

  private listen(server: TcpServer, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, this.options.bindAddress, () => {
        server.off('error', reject);
        server.on('error', () => { this.counters.dropped++; });
        resolve();
      });
    });
  }

  private acceptStream(socket: TcpSocket, kind: 'tcp' | 'tls'): void {
    const address = socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
    if (!net.isIPv4(address) || !this.connections.take(address) || this.clients.size >= this.options.maxAllocations * 2) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    socket.setTimeout(120_000, () => socket.destroy());
    const transport: Transport = {
      id: `${kind}:${++this.serial}`, kind, peer: { address, port: socket.remotePort! },
      send: (packet) => {
        if (socket.destroyed || socket.writableLength > 262_144) {
          socket.destroy();
          return false;
        }
        socket.write(packet);
        return true;
      },
      open: () => !socket.destroyed, close: () => socket.destroy(),
    };
    this.clients.set(transport.id, transport);
    let buffered = Buffer.alloc(0);
    socket.on('error', () => { this.counters.dropped++; });
    socket.on('close', () => {
      this.clients.delete(transport.id);
      this.removeAllocation(transport.id);
    });
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 262_144) { socket.destroy(); return; }
      while (buffered.length >= 4) {
        const prefix = buffered[0]! & 0xc0;
        if (prefix !== 0 && prefix !== 0x40) { socket.destroy(); return; }
        if (prefix === 0 && buffered.length < 20) break;
        const length = prefix === 0 ? 20 + buffered.readUInt16BE(2) : (4 + buffered.readUInt16BE(2) + 3) & ~3;
        if (buffered.length < length) break;
        const packet = buffered.subarray(0, length);
        buffered = buffered.subarray(length);
        this.receive(packet, transport);
      }
    });
  }

  private receive(packet: Buffer, transport: Transport): void {
    if (packet.length >= 4 && (packet[0]! & 0xc0) === 0x40) {
      this.channelData(packet, transport);
      return;
    }
    const message = decodeMessage(packet);
    if (!message || !verifyFingerprint(message)) { this.counters.dropped++; return; }
    if (message.type === 0x0016) { this.sendIndication(message, transport); return; }
    if (![0x0001, 0x0003, 0x0004, 0x0008, 0x0009].includes(message.type)) return;
    const cached = this.responses.get(this.cacheKey(message, transport));
    if (cached && cached.expiresAt > Date.now()) { transport.send(cached.packet); return; }
    if (!this.requests.take(transport.peer.address)) { this.counters.dropped++; return; }
    this.handle(message, transport).catch(() => {
      this.counters.dropped++;
      if (transport.open()) this.error(message, transport, 500, 'Server Error');
    });
  }

  private async handle(message: StunMessage, transport: Transport): Promise<void> {
    if (message.type === 0x0001) {
      this.reply(message, transport, [{ type: Attr.XOR_MAPPED_ADDRESS, value: encodeXorAddress(transport.peer) }]);
      return;
    }
    const authentication = this.authenticate(message, transport);
    if (!authentication) return;
    const { key, username } = authentication;
    const integrityIndex = message.attributes.findIndex((entry) => entry.type === Attr.MESSAGE_INTEGRITY);
    if (message.attributes.slice(integrityIndex + 1).some((entry) => entry.type !== Attr.FINGERPRINT)) {
      this.error(message, transport, 400, 'Unsigned attributes', key);
      return;
    }
    const unknown = message.attributes.filter((entry) => entry.type < 0x8000 && !REQUIRED_ATTRIBUTES.has(entry.type));
    if (unknown.length) {
      const value = Buffer.alloc(unknown.length * 2);
      unknown.forEach((entry, index) => value.writeUInt16BE(entry.type, index * 2));
      this.error(message, transport, 420, 'Unknown Attribute', key, [{ type: 0x000a, value }]);
      return;
    }
    if (message.type === 0x0003) { await this.allocate(message, transport, key, username); return; }
    const allocation = this.allocations.get(transport.id);
    if (!allocation || allocation.expiresAt <= Date.now()) {
      this.removeAllocation(transport.id);
      this.error(message, transport, 437, 'Allocation Mismatch', key);
      return;
    }
    if (allocation.username !== username) { this.error(message, transport, 441, 'Wrong Credentials', key); return; }
    if (message.type === 0x0004) this.refresh(message, allocation, key);
    if (message.type === 0x0008) this.permission(message, allocation, key);
    if (message.type === 0x0009) this.bindChannel(message, allocation, key);
  }

  private authenticate(message: StunMessage, transport: Transport): { key: Buffer; username: string } | undefined {
    const username = attribute(message, Attr.USERNAME)?.toString('utf8');
    const realm = attribute(message, Attr.REALM)?.toString('utf8');
    const nonce = attribute(message, Attr.NONCE)?.toString('utf8');
    const existing = this.allocations.get(transport.id);
    const key = username ? this.auth.key(username, message.type !== 0x0003 && existing?.username === username) : undefined;
    const duplicates = [Attr.USERNAME, Attr.REALM, Attr.NONCE].some((type) => message.attributes.filter((entry) => entry.type === type).length > 1);
    if (!username || !nonce || realm !== this.auth.realm || !key || duplicates || !verifyIntegrity(message, key)) {
      this.counters.authFailures++;
      this.challenge(message, transport, 401);
      return;
    }
    const validity = this.auth.verifyNonce(nonce, transport.peer.address);
    if (validity !== 'valid') {
      this.counters.authFailures++;
      this.challenge(message, transport, validity === 'stale' ? 438 : 401, validity === 'stale' ? key : undefined);
      return;
    }
    return { key, username };
  }

  private challenge(message: StunMessage, transport: Transport, code: number, key?: Buffer): void {
    this.error(message, transport, code, code === 438 ? 'Stale Nonce' : 'Unauthorized', key, [
      { type: Attr.REALM, value: Buffer.from(this.auth.realm) },
      { type: Attr.NONCE, value: Buffer.from(this.auth.nonce(transport.peer.address)) },
    ]);
  }

  private async allocate(message: StunMessage, transport: Transport, key: Buffer, username: string): Promise<void> {
    if (this.allocations.has(transport.id) || this.pendingAllocations.has(transport.id)) {
      if (!this.pendingAllocations.has(transport.id)) this.error(message, transport, 437, 'Allocation Mismatch', key);
      return;
    }
    const requested = attribute(message, Attr.REQUESTED_TRANSPORT);
    if (!requested || requested.length !== 4 || requested.subarray(1).some((byte) => byte !== 0)) {
      this.error(message, transport, 400, 'Bad Request', key); return;
    }
    if (requested[0] !== 17) { this.error(message, transport, 442, 'Unsupported Transport Protocol', key); return; }
    const family = attribute(message, Attr.REQUESTED_ADDRESS_FAMILY);
    if (family && (family.length !== 4 || family[0] !== 1 || family.subarray(1).some((byte) => byte !== 0))) {
      this.error(message, transport, 440, 'Address Family Not Supported', key); return;
    }
    if (attribute(message, Attr.EVEN_PORT) || attribute(message, Attr.RESERVATION_TOKEN)) {
      this.error(message, transport, 508, 'Port reservations not supported', key); return;
    }
    const lifetimeAttribute = attribute(message, Attr.LIFETIME);
    if (lifetimeAttribute && lifetimeAttribute.length !== 4) { this.error(message, transport, 400, 'Bad Lifetime', key); return; }
    const sameIp = [...this.allocations.values()].filter((entry) => entry.transport.peer.address === transport.peer.address).length +
      [...this.pendingAllocations.values()].filter((address) => address === transport.peer.address).length;
    if (this.allocations.size + this.pendingAllocations.size >= this.options.maxAllocations || sameIp >= this.options.maxAllocationsPerIp) {
      this.error(message, transport, 486, 'Allocation Quota Reached', key); return;
    }
    this.pendingAllocations.set(transport.id, transport.peer.address);
    try {
      const socket = await this.openRelay();
      if (!socket) { this.error(message, transport, 508, 'Insufficient Capacity', key); return; }
      if (this.closed || !transport.open()) { socket.close(); return; }
      const lifetime = Math.min(lifetimeAttribute?.readUInt32BE(0) || 600, 600);
      const allocation: Allocation = {
        transport, username, socket, port: socket.address().port, expiresAt: Date.now() + lifetime * 1000,
        permissions: new Map(), channels: new Map(), bandwidth: new TokenBucket(this.options.bytesPerSecond, this.options.bytesPerSecond),
      };
      this.allocations.set(transport.id, allocation);
      this.counters.created++;
      socket.on('message', (data, remote) => this.fromPeer(allocation, data, { address: remote.address, port: remote.port }));
      this.reply(message, transport, [
        { type: Attr.XOR_RELAYED_ADDRESS, value: encodeXorAddress({ address: this.options.publicAddress, port: allocation.port }) },
        { type: Attr.XOR_MAPPED_ADDRESS, value: encodeXorAddress(transport.peer) },
        { type: Attr.LIFETIME, value: uint32(lifetime) },
      ], key);
    } finally {
      this.pendingAllocations.delete(transport.id);
    }
  }

  private async openRelay(): Promise<DatagramSocket | undefined> {
    for (let attempt = 0; attempt <= this.options.relayMaxPort - this.options.relayMinPort; attempt++) {
      const port = this.nextPort;
      this.nextPort = port >= this.options.relayMaxPort ? this.options.relayMinPort : port + 1;
      const socket = await new Promise<DatagramSocket | undefined>((resolve) => {
        const candidate = dgram.createSocket('udp4');
        const failure = () => { try { candidate.close(); } catch {} resolve(undefined); };
        candidate.once('error', failure);
        candidate.bind(port, this.options.relayBindAddress, () => {
          candidate.off('error', failure);
          candidate.on('error', () => { this.counters.dropped++; });
          resolve(candidate);
        });
      });
      if (socket) return socket;
    }
  }

  private refresh(message: StunMessage, allocation: Allocation, key: Buffer): void {
    const requested = attribute(message, Attr.LIFETIME);
    if (requested && requested.length !== 4) { this.error(message, allocation.transport, 400, 'Bad Lifetime', key); return; }
    const lifetime = Math.min(requested ? requested.readUInt32BE(0) : 600, 600);
    allocation.expiresAt = Date.now() + lifetime * 1000;
    this.reply(message, allocation.transport, [{ type: Attr.LIFETIME, value: uint32(lifetime) }], key);
    if (lifetime === 0) this.removeAllocation(allocation.transport.id);
  }

  private permission(message: StunMessage, allocation: Allocation, key: Buffer): void {
    const entries = message.attributes.filter((entry) => entry.type === Attr.XOR_PEER_ADDRESS);
    if (!entries.length || entries.length > 16) { this.error(message, allocation.transport, 400, 'Bad Peer Address', key); return; }
    const peers = entries.map((entry) => decodeXorAddress(entry.value));
    if (peers.some((peer) => !peer)) { this.error(message, allocation.transport, 440, 'Address Family Not Supported', key); return; }
    if (peers.some((peer) => !allowedPeer(peer!.address, this.options.allowPrivatePeers))) {
      this.error(message, allocation.transport, 403, 'Forbidden Peer', key); return;
    }
    const newAddresses = new Set(peers.map((peer) => peer!.address).filter((address) => !allocation.permissions.has(address)));
    if (allocation.permissions.size + newAddresses.size > 64) { this.error(message, allocation.transport, 508, 'Permission Capacity', key); return; }
    for (const peer of peers) allocation.permissions.set(peer!.address, Date.now() + 300_000);
    this.reply(message, allocation.transport, [], key);
  }

  private bindChannel(message: StunMessage, allocation: Allocation, key: Buffer): void {
    const value = attribute(message, Attr.CHANNEL_NUMBER);
    const peer = decodeXorAddress(attribute(message, Attr.XOR_PEER_ADDRESS));
    if (!value || value.length !== 4 || value.readUInt16BE(2) !== 0 || !peer ||
      value.readUInt16BE(0) < 0x4000 || value.readUInt16BE(0) > 0x7fff) {
      this.error(message, allocation.transport, 400, 'Bad Channel', key); return;
    }
    if (!allowedPeer(peer.address, this.options.allowPrivatePeers)) { this.error(message, allocation.transport, 403, 'Forbidden Peer', key); return; }
    const channel = value.readUInt16BE(0);
    const previous = allocation.channels.get(channel);
    if ((previous && (previous.peer.address !== peer.address || previous.peer.port !== peer.port)) ||
      [...allocation.channels.entries()].some(([number, entry]) => number !== channel && entry.peer.address === peer.address && entry.peer.port === peer.port)) {
      this.error(message, allocation.transport, 400, 'Channel Already Bound', key); return;
    }
    if ((!previous && allocation.channels.size >= 64) || (!allocation.permissions.has(peer.address) && allocation.permissions.size >= 64)) {
      this.error(message, allocation.transport, 508, 'Channel Capacity', key); return;
    }
    allocation.channels.set(channel, { peer, expiresAt: Date.now() + 600_000 });
    allocation.permissions.set(peer.address, Date.now() + 300_000);
    this.reply(message, allocation.transport, [], key);
  }

  private channelData(packet: Buffer, transport: Transport): void {
    const allocation = this.allocations.get(transport.id);
    const length = packet.readUInt16BE(2);
    const channel = allocation?.channels.get(packet.readUInt16BE(0));
    if (!allocation || !channel || channel.expiresAt <= Date.now() || packet.length < length + 4) { this.counters.dropped++; return; }
    this.toPeer(allocation, channel.peer, packet.subarray(4, 4 + length));
  }

  private sendIndication(message: StunMessage, transport: Transport): void {
    const allocation = this.allocations.get(transport.id);
    const peer = decodeXorAddress(attribute(message, Attr.XOR_PEER_ADDRESS));
    const data = attribute(message, Attr.DATA);
    if (!allocation || !peer || !data) { this.counters.dropped++; return; }
    this.toPeer(allocation, peer, data);
  }

  private toPeer(allocation: Allocation, peer: Address, data: Buffer): void {
    if (allocation.expiresAt <= Date.now() || (allocation.permissions.get(peer.address) ?? 0) <= Date.now() ||
      data.length > 65000 || !allowedPeer(peer.address, this.options.allowPrivatePeers) || !allocation.bandwidth.take(data.length)) {
      this.counters.dropped++; return;
    }
    allocation.socket.send(data, peer.port, peer.address, (error) => {
      if (error) this.counters.dropped++;
      else this.counters.bytesToPeer += data.length;
    });
  }

  private fromPeer(allocation: Allocation, data: Buffer, peer: Address): void {
    if (allocation.expiresAt <= Date.now() || (allocation.permissions.get(peer.address) ?? 0) <= Date.now() ||
      data.length > 65000 || !allocation.bandwidth.take(data.length)) { this.counters.dropped++; return; }
    const bound = [...allocation.channels.entries()].find(([, entry]) =>
      entry.expiresAt > Date.now() && entry.peer.address === peer.address && entry.peer.port === peer.port);
    let packet: Buffer;
    if (bound) {
      const length = 4 + data.length;
      packet = Buffer.alloc(allocation.transport.kind === 'udp' ? length : (length + 3) & ~3);
      packet.writeUInt16BE(bound[0], 0);
      packet.writeUInt16BE(data.length, 2);
      data.copy(packet, 4);
    } else {
      packet = encodeMessage(0x0017, undefined, [
        { type: Attr.XOR_PEER_ADDRESS, value: encodeXorAddress(peer) }, { type: Attr.DATA, value: data },
      ]);
    }
    if (allocation.transport.send(packet)) this.counters.bytesToClient += data.length;
    else this.counters.dropped++;
  }

  private cacheKey(message: StunMessage, transport: Transport): string {
    return `${transport.id}:${message.transactionId.toString('hex')}`;
  }

  private reply(message: StunMessage, transport: Transport, attributes: Attribute[], key?: Buffer): void {
    this.sendResponse(message, transport, encodeMessage(message.type | 0x0100, message.transactionId, [...attributes, SOFTWARE], key));
  }

  private error(message: StunMessage, transport: Transport, code: number, reason: string, key?: Buffer, extra: Attribute[] = []): void {
    this.sendResponse(message, transport, encodeMessage(message.type | 0x0110, message.transactionId, [
      { type: Attr.ERROR_CODE, value: errorValue(code, reason) }, ...extra, SOFTWARE,
    ], key));
  }

  private sendResponse(message: StunMessage, transport: Transport, packet: Buffer): void {
    if (this.responses.size >= 4096) this.responses.delete(this.responses.keys().next().value!);
    this.responses.set(this.cacheKey(message, transport), { packet, expiresAt: Date.now() + 40_000 });
    transport.send(packet);
  }

  private removeAllocation(id: string): void {
    const allocation = this.allocations.get(id);
    if (!allocation) return;
    this.allocations.delete(id);
    allocation.socket.close();
  }

  private expire(): void {
    const now = Date.now();
    for (const [id, allocation] of this.allocations) {
      if (allocation.expiresAt <= now) { this.removeAllocation(id); continue; }
      for (const [address, expiry] of allocation.permissions) if (expiry <= now) allocation.permissions.delete(address);
      for (const [number, channel] of allocation.channels) if (channel.expiresAt <= now) allocation.channels.delete(number);
    }
    for (const [id, response] of this.responses) if (response.expiresAt <= now) this.responses.delete(id);
  }

  stats() {
    return {
      status: this.closed ? 'offline' : 'online', activeAllocations: this.allocations.size,
      maxAllocations: this.options.maxAllocations, uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      transports: this.options.tls ? ['udp', 'tcp', 'tls'] : ['udp', 'tcp'], ...this.counters,
    };
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const id of this.allocations.keys()) this.removeAllocation(id);
    for (const client of this.clients.values()) client.close();
    await Promise.all([this.tcp, this.tlsServer].filter((server) => server?.listening).map((server) =>
      new Promise<void>((resolve) => server!.close(() => resolve()))));
    if (this.udp) await new Promise<void>((resolve) => { try { this.udp!.close(() => resolve()); } catch { resolve(); } });
    this.responses.clear();
  }
}