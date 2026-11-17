import { randomBytes } from 'node:crypto';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { IpLimiter, TokenBucket } from '../http/limits.ts';
import { validAccessToken } from '../custom-turn/auth.ts';
import type { CallMode, MediaState, PeerInfo, ServerSignal } from '../../shared/types.ts';

interface Member {
  socket: WebSocket;
  info: PeerInfo;
  roomId: string | undefined;
  alive: boolean;
  limit: TokenBucket;
}

interface Room {
  mode: CallMode;
  members: Set<Member>;
}

export interface SignalingOptions {
  accessToken?: string;
  origin?: string;
  production?: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mediaState(value: unknown): value is MediaState {
  return record(value) && typeof value['audio'] === 'boolean' && typeof value['video'] === 'boolean' && typeof value['sharing'] === 'boolean';
}

export class SignalingServer {
  private readonly websocket = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
  private readonly rooms = new Map<string, Room>();
  private readonly members = new Set<Member>();
  private readonly connections = new IpLimiter(30, 0.5);
  private readonly options: SignalingOptions;
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(server: Server, options: SignalingOptions = {}) {
    this.options = options;
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (request.url !== '/signal') {
        if (options.production) socket.destroy();
        return;
      }
      const address = request.socket.remoteAddress ?? '';
      let originAllowed = !options.production;
      try {
        originAllowed = Boolean(request.headers.origin && (options.origin ? request.headers.origin === options.origin :
          new URL(request.headers.origin).host === request.headers.host));
      } catch {}
      if (!originAllowed || !this.connections.take(address) || this.members.size >= 512) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.websocket.handleUpgrade(request, socket, head, (connection) => this.websocket.emit('connection', connection));
    });
    this.websocket.on('connection', (socket) => this.connect(socket));
    this.heartbeat = setInterval(() => {
      for (const member of this.members) {
        if (!member.alive) { member.socket.terminate(); continue; }
        member.alive = false;
        member.socket.ping();
      }
    }, 30_000);
    this.heartbeat.unref();
  }

  private connect(socket: WebSocket): void {
    const member: Member = {
      socket, roomId: undefined, alive: true, limit: new TokenBucket(150, 30),
      info: { id: randomBytes(8).toString('hex'), name: 'Guest', media: { audio: true, video: true, sharing: false } },
    };
    this.members.add(member);
    socket.on('pong', () => { member.alive = true; });
    socket.on('error', () => {});
    socket.on('close', () => { this.leave(member); this.members.delete(member); });
    socket.on('message', (raw, binary) => {
      if (binary || !member.limit.take()) { socket.close(1008, 'Message limit'); return; }
      let message: unknown;
      try { message = JSON.parse(raw.toString()); } catch { socket.close(1008, 'Invalid JSON'); return; }
      if (!record(message)) { socket.close(1008, 'Invalid message'); return; }
      if (message['type'] === 'join') { this.join(member, message); return; }
      if (!member.roomId) { this.error(member, 'not-joined', 'Join a room first.'); return; }
      if (message['type'] === 'leave') { this.leave(member); socket.close(1000, 'Left call'); return; }
      if (message['type'] === 'description') {
        const description = message['description'];
        if (!record(description) || !['offer', 'answer'].includes(String(description['type'])) ||
          typeof description['sdp'] !== 'string' || description['sdp'].length > 60_000) {
          socket.close(1008, 'Invalid description'); return;
        }
        this.forward(member, { type: 'description', description: { type: description['type'] as 'offer' | 'answer', sdp: description['sdp'] } });
      } else if (message['type'] === 'ice') {
        const candidate = message['candidate'];
        if (!record(candidate) || typeof candidate['candidate'] !== 'string' || candidate['candidate'].length > 2048 ||
          (candidate['sdpMid'] != null && (typeof candidate['sdpMid'] !== 'string' || candidate['sdpMid'].length > 64)) ||
          (candidate['sdpMLineIndex'] != null && (!Number.isInteger(candidate['sdpMLineIndex']) || Number(candidate['sdpMLineIndex']) < 0 || Number(candidate['sdpMLineIndex']) > 32))) {
          socket.close(1008, 'Invalid candidate'); return;
        }
        this.forward(member, { type: 'ice', candidate: candidate as RTCIceCandidateInit });
      } else if (message['type'] === 'media' && mediaState(message['media'])) {
        member.info.media = message['media'];
        this.forward(member, { type: 'media', media: member.info.media });
      } else {
        socket.close(1008, 'Unknown message');
      }
    });
  }

  private join(member: Member, message: Record<string, unknown>): void {
    if (member.roomId) { this.error(member, 'already-joined', 'Already in a call.'); return; }
    const token = typeof message['accessToken'] === 'string' ? message['accessToken'] : undefined;
    if (!validAccessToken(token, this.options.accessToken)) {
      this.error(member, 'unauthorized', 'An access token is required.');
      member.socket.close(1008, 'Unauthorized');
      return;
    }
    const roomId = message['roomId'];
    const name = message['name'];
    const mode = message['mode'];
    if (typeof roomId !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(roomId) ||
      typeof name !== 'string' || name.trim().length < 1 || name.length > 48 || !['auto', 'relay'].includes(String(mode))) {
      this.error(member, 'invalid-room', 'Enter a valid invite link and name.'); return;
    }
    let room = this.rooms.get(roomId);
    if (room && room.members.size >= 2) { this.error(member, 'room-full', 'This call already has two people.'); return; }
    if (!room) {
      if (this.rooms.size >= 256) { this.error(member, 'capacity', 'The server is at capacity. Try again later.'); return; }
      room = { mode: mode as CallMode, members: new Set() };
      this.rooms.set(roomId, room);
    }
    if (mode === 'relay') room.mode = 'relay';
    member.info.name = name.trim().replace(/[\u0000-\u001f\u007f]/g, '');
    member.roomId = roomId;
    const peers = [...room.members].map((peer) => peer.info);
    room.members.add(member);
    this.send(member, { type: 'joined', peerId: member.info.id, roomId, mode: room.mode, peers });
    this.forward(member, { type: 'peer-joined', peer: member.info, mode: room.mode });
  }

  private forward(member: Member, message: ServerSignal): void {
    const room = member.roomId ? this.rooms.get(member.roomId) : undefined;
    if (!room) return;
    for (const peer of room.members) if (peer !== member) this.send(peer, message);
  }

  private send(member: Member, message: ServerSignal): void {
    if (member.socket.readyState !== WebSocket.OPEN) return;
    if (member.socket.bufferedAmount > 262_144) { member.socket.terminate(); return; }
    member.socket.send(JSON.stringify(message));
  }

  private error(member: Member, code: string, message: string): void {
    this.send(member, { type: 'error', code, message });
  }

  private leave(member: Member): void {
    const room = member.roomId ? this.rooms.get(member.roomId) : undefined;
    if (!room) return;
    room.members.delete(member);
    this.forward(member, { type: 'peer-left' });
    if (room.members.size === 0) this.rooms.delete(member.roomId!);
    member.roomId = undefined;
  }

  stats() { return { rooms: this.rooms.size, members: this.members.size }; }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const member of this.members) member.socket.terminate();
    await new Promise<void>((resolve) => this.websocket.close(() => resolve()));
  }
}