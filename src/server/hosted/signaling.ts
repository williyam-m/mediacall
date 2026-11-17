import { createHash, timingSafeEqual } from 'node:crypto';
import type { CallMode, ClientSignal, MediaState, PeerInfo, ServerSignal } from '../../shared/types.ts';

export interface QueuedSignal {
  sequence: number;
  target: string;
  time: number;
  signal: ServerSignal;
}

interface HostedMember extends PeerInfo {
  secretHash: string;
  lastSeen: number;
}

export interface HostedRoom {
  mode: CallMode;
  members: HostedMember[];
  sequence: number;
  events: QueuedSignal[];
}

export interface StoredRoom {
  version: number;
  body: HostedRoom;
}

export interface RoomStore {
  read(roomId: string, now: number): Promise<StoredRoom | undefined>;
  create(roomId: string, now: number): Promise<void>;
  replace(roomId: string, version: number, body: HostedRoom, now: number): Promise<boolean>;
}

export interface SignalRequest {
  roomId: string;
  peerId: string;
  sessionToken: string;
  after: number;
  join?: { name: string; mode: CallMode };
  messages?: ClientSignal[];
}

export interface SignalResponse {
  cursor: number;
  events: { sequence: number; signal: ServerSignal }[];
}

export class SignalError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validMedia(value: unknown): value is MediaState {
  return object(value) && typeof value['audio'] === 'boolean' && typeof value['video'] === 'boolean' && typeof value['sharing'] === 'boolean';
}

function validMessage(value: unknown): value is ClientSignal {
  if (!object(value)) return false;
  if (value['type'] === 'leave') return true;
  if (value['type'] === 'media') return validMedia(value['media']);
  if (value['type'] === 'description') {
    const description = value['description'];
    return object(description) && ['offer', 'answer'].includes(String(description['type'])) && typeof description['sdp'] === 'string' && description['sdp'].length <= 60_000;
  }
  if (value['type'] === 'ice') {
    const candidate = value['candidate'];
    return object(candidate) && typeof candidate['candidate'] === 'string' && candidate['candidate'].length <= 2048 &&
      (candidate['sdpMid'] == null || typeof candidate['sdpMid'] === 'string' && candidate['sdpMid'].length <= 64) &&
      (candidate['sdpMLineIndex'] == null || Number.isInteger(candidate['sdpMLineIndex']) && Number(candidate['sdpMLineIndex']) >= 0 && Number(candidate['sdpMLineIndex']) <= 32) &&
      (candidate['usernameFragment'] == null || typeof candidate['usernameFragment'] === 'string' && candidate['usernameFragment'].length <= 256);
  }
  return false;
}

export function parseSignalRequest(value: unknown): SignalRequest {
  if (!object(value) || typeof value['roomId'] !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(value['roomId']) ||
    typeof value['peerId'] !== 'string' || !/^[a-f0-9]{16,32}$/.test(value['peerId']) ||
    typeof value['sessionToken'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['sessionToken']) ||
    !Number.isSafeInteger(value['after']) || Number(value['after']) < 0) throw new SignalError('invalid-request', 'Invalid signaling request.');
  const request: SignalRequest = { roomId: value['roomId'], peerId: value['peerId'], sessionToken: value['sessionToken'], after: Number(value['after']) };
  if (value['join'] !== undefined) {
    const join = value['join'];
    if (!object(join) || typeof join['name'] !== 'string' || join['name'].length > 48 || !['auto', 'relay'].includes(String(join['mode']))) throw new SignalError('invalid-room', 'Enter a valid name and call mode.');
    const name = join['name'].replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!name) throw new SignalError('invalid-room', 'Enter a valid name.');
    request.join = { name, mode: join['mode'] as CallMode };
  }
  if (value['messages'] !== undefined) {
    if (!Array.isArray(value['messages']) || value['messages'].length > 32 || !value['messages'].every(validMessage) || request.join) throw new SignalError('invalid-message', 'Invalid signaling message.');
    request.messages = value['messages'];
  }
  return request;
}

function secretHash(secret: string): string { return createHash('sha256').update(secret).digest('hex'); }

function sameSecret(secret: string, hash: string): boolean {
  const expected = Buffer.from(hash, 'hex');
  const actual = Buffer.from(secretHash(secret), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function publicPeer(member: HostedMember): PeerInfo { return { id: member.id, name: member.name, media: { ...member.media } }; }

export function emptyRoom(): HostedRoom { return { mode: 'auto', members: [], sequence: 0, events: [] }; }

function apply(room: HostedRoom, request: SignalRequest, now: number): { room: HostedRoom; response: SignalResponse; changed: boolean } {
  const next = structuredClone(room);
  let changed = false;
  function emit(target: string, signal: ServerSignal) {
    next.events.push({ sequence: ++next.sequence, target, time: now, signal });
    changed = true;
  }
  function broadcast(sender: string, signal: ServerSignal) {
    for (const member of next.members) if (member.id !== sender) emit(member.id, signal);
  }
  const stale = next.members.filter((member) => now - member.lastSeen > 30_000);
  if (stale.length) {
    next.members = next.members.filter((member) => now - member.lastSeen <= 30_000);
    for (const member of stale) broadcast(member.id, { type: 'peer-left' });
    changed = true;
  }
  const retained = next.events.filter((entry) => now - entry.time < 60_000 && next.members.some((member) => member.id === entry.target));
  if (retained.length !== next.events.length) { next.events = retained; changed = true; }
  let member = next.members.find((entry) => entry.id === request.peerId);
  if (member && !sameSecret(request.sessionToken, member.secretHash)) throw new SignalError('unauthorized', 'Invalid call session.', 401);
  if (request.join && !member) {
    if (next.members.length >= 2) throw new SignalError('room-full', 'This call already has two people.', 409);
    if (request.join.mode === 'relay') next.mode = 'relay';
    const peers = next.members.map(publicPeer);
    member = { id: request.peerId, name: request.join.name, secretHash: secretHash(request.sessionToken), lastSeen: now, media: { audio: true, video: true, sharing: false } };
    next.members.push(member);
    emit(member.id, { type: 'joined', peerId: member.id, roomId: request.roomId, mode: next.mode, peers });
    broadcast(member.id, { type: 'peer-joined', peer: publicPeer(member), mode: next.mode });
  }
  if (!member) throw new SignalError('session-expired', 'The call session expired. Rejoin to reconnect.', 410);
  if (now - member.lastSeen >= 5000) { member.lastSeen = now; changed = true; }
  for (const message of request.messages ?? []) {
    if (message.type === 'leave') {
      next.members = next.members.filter((entry) => entry.id !== member!.id);
      broadcast(member.id, { type: 'peer-left' });
      changed = true;
      break;
    }
    if (message.type === 'media') {
      member.media = { ...message.media };
      broadcast(member.id, { type: 'media', media: member.media });
      changed = true;
    } else if (message.type === 'description') {
      broadcast(member.id, { type: 'description', description: { type: message.description.type, sdp: message.description.sdp! } });
    } else if (message.type === 'ice') {
      broadcast(member.id, { type: 'ice', candidate: message.candidate });
    }
  }
  if (next.events.length > 512) throw new SignalError('message-limit', 'The signaling queue is full. Rejoin the call.', 429);
  return {
    room: next, changed,
    response: { cursor: next.sequence, events: next.events.filter((entry) => entry.target === request.peerId && entry.sequence > request.after).map(({ sequence, signal }) => ({ sequence, signal })) },
  };
}

export async function exchangeSignals(store: RoomStore, request: SignalRequest, now = Date.now()): Promise<SignalResponse> {
  if (request.join) await store.create(request.roomId, now);
  for (let attempt = 0; attempt < 8; attempt++) {
    const stored = await store.read(request.roomId, now);
    if (!stored) throw new SignalError('session-expired', 'The call session expired. Rejoin to reconnect.', 410);
    const result = apply(stored.body, request, now);
    if (!result.changed || await store.replace(request.roomId, stored.version, result.room, now)) return result.response;
  }
  throw new SignalError('busy', 'The room is busy. Try again shortly.', 503);
}