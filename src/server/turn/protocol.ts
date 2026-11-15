import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIPv4 } from 'node:net';

export const COOKIE = 0x2112a442;
export const Attr = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  CHANNEL_NUMBER: 0x000c,
  LIFETIME: 0x000d,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_ADDRESS_FAMILY: 0x0017,
  EVEN_PORT: 0x0018,
  REQUESTED_TRANSPORT: 0x0019,
  DONT_FRAGMENT: 0x001a,
  XOR_MAPPED_ADDRESS: 0x0020,
  RESERVATION_TOKEN: 0x0022,
  SOFTWARE: 0x8022,
  ALTERNATE_SERVER: 0x8023,
  FINGERPRINT: 0x8028,
} as const;

export interface Attribute {
  type: number;
  value: Buffer;
  offset?: number;
}

export interface StunMessage {
  type: number;
  transactionId: Buffer;
  attributes: Attribute[];
  raw: Buffer;
}

export interface Address {
  address: string;
  port: number;
}

export function crc32(data: Buffer): number {
  let checksum = 0xffffffff;
  for (const octet of data) {
    checksum ^= octet;
    for (let bit = 0; bit < 8; bit++) {
      checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

export function decodeMessage(raw: Buffer): StunMessage | undefined {
  if (raw.length < 20 || (raw[0]! & 0xc0) !== 0 || raw.readUInt32BE(4) !== COOKIE) return;
  const length = raw.readUInt16BE(2);
  if (length % 4 !== 0 || length + 20 !== raw.length) return;
  const attributes: Attribute[] = [];
  for (let offset = 20; offset < raw.length;) {
    if (offset + 4 > raw.length) return;
    const attributeLength = raw.readUInt16BE(offset + 2);
    const end = offset + 4 + attributeLength;
    const next = offset + 4 + ((attributeLength + 3) & ~3);
    if (end > raw.length || next > raw.length) return;
    attributes.push({ type: raw.readUInt16BE(offset), value: raw.subarray(offset + 4, end), offset });
    offset = next;
  }
  return { type: raw.readUInt16BE(0), transactionId: raw.subarray(8, 20), attributes, raw };
}

export function attribute(message: StunMessage, type: number): Buffer | undefined {
  return message.attributes.find((entry) => entry.type === type)?.value;
}

export function uint32(value: number): Buffer {
  const output = Buffer.alloc(4);
  output.writeUInt32BE(value);
  return output;
}

function packAttribute(entry: Attribute): Buffer {
  const output = Buffer.alloc(4 + ((entry.value.length + 3) & ~3));
  output.writeUInt16BE(entry.type, 0);
  output.writeUInt16BE(entry.value.length, 2);
  entry.value.copy(output, 4);
  return output;
}

export function encodeMessage(
  type: number,
  transactionId: Buffer = randomBytes(12),
  attributes: Attribute[] = [],
  integrityKey?: Buffer,
  fingerprint = true,
): Buffer {
  if (transactionId.length !== 12) throw new Error('A STUN transaction ID must have 12 bytes');
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type);
  header.writeUInt32BE(COOKIE, 4);
  transactionId.copy(header, 8);
  let body = Buffer.concat(attributes.map(packAttribute));
  if (integrityKey) {
    header.writeUInt16BE(body.length + 24, 2);
    const digest = createHmac('sha1', integrityKey).update(Buffer.concat([header, body])).digest();
    body = Buffer.concat([body, packAttribute({ type: Attr.MESSAGE_INTEGRITY, value: digest })]);
  }
  header.writeUInt16BE(body.length + (fingerprint ? 8 : 0), 2);
  if (fingerprint) {
    const checksum = (crc32(Buffer.concat([header, body])) ^ 0x5354554e) >>> 0;
    body = Buffer.concat([body, packAttribute({ type: Attr.FINGERPRINT, value: uint32(checksum) })]);
  }
  return Buffer.concat([header, body]);
}

export function verifyIntegrity(message: StunMessage, key: Buffer): boolean {
  const entries = message.attributes.filter((entry) => entry.type === Attr.MESSAGE_INTEGRITY);
  if (entries.length !== 1) return false;
  const entry = entries[0]!;
  if (entry.value.length !== 20 || entry.offset === undefined) return false;
  const prefix = Buffer.from(message.raw.subarray(0, entry.offset));
  prefix.writeUInt16BE(entry.offset + 4, 2);
  const expected = createHmac('sha1', key).update(prefix).digest();
  return timingSafeEqual(expected, entry.value);
}

export function verifyFingerprint(message: StunMessage): boolean {
  const entries = message.attributes.filter((entry) => entry.type === Attr.FINGERPRINT);
  if (entries.length === 0) return true;
  if (entries.length !== 1) return false;
  const entry = entries[0]!;
  if (entry.value.length !== 4 || entry.offset !== message.raw.length - 8) return false;
  return entry.value.readUInt32BE(0) === ((crc32(message.raw.subarray(0, entry.offset)) ^ 0x5354554e) >>> 0);
}

export function encodeXorAddress(address: Address): Buffer {
  if (!isIPv4(address.address) || address.port < 1 || address.port > 65535) {
    throw new Error('This relay supports IPv4 addresses with nonzero ports');
  }
  const value = Buffer.alloc(8);
  value[1] = 1;
  value.writeUInt16BE(address.port ^ (COOKIE >>> 16), 2);
  const octets = address.address.split('.').map(Number);
  const integer = (((octets[0]! << 24) >>> 0) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  value.writeUInt32BE((integer ^ COOKIE) >>> 0, 4);
  return value;
}

export function decodeXorAddress(value: Buffer | undefined): Address | undefined {
  if (!value || value.length !== 8 || value[0] !== 0 || value[1] !== 1) return;
  const port = value.readUInt16BE(2) ^ (COOKIE >>> 16);
  if (!port) return;
  const integer = (value.readUInt32BE(4) ^ COOKIE) >>> 0;
  return {
    address: [integer >>> 24, (integer >>> 16) & 255, (integer >>> 8) & 255, integer & 255].join('.'),
    port,
  };
}

export function errorValue(code: number, reason: string): Buffer {
  return Buffer.concat([Buffer.from([0, 0, Math.floor(code / 100), code % 100]), Buffer.from(reason)]);
}