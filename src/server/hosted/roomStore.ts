import { neon } from '@neondatabase/serverless';
import { emptyRoom } from './signaling.ts';
import type { HostedRoom, RoomStore, StoredRoom } from './signaling.ts';

export type RoomQuery = (text: string, parameters: unknown[]) => Promise<Record<string, unknown>[]>;

export class PostgresRoomStore implements RoomStore {
  private readonly query: RoomQuery;
  private ready: Promise<unknown> | undefined;

  constructor(query: RoomQuery) { this.query = query; }

  private async initialize() {
    this.ready ??= this.query('CREATE TABLE IF NOT EXISTS mediacall_rooms (id text PRIMARY KEY, version integer NOT NULL DEFAULT 0, body jsonb NOT NULL, expires_at bigint NOT NULL)', [])
      .catch((cause: unknown) => { this.ready = undefined; throw cause; });
    await this.ready;
  }

  async read(roomId: string, now: number): Promise<StoredRoom | undefined> {
    await this.initialize();
    const rows = await this.query('SELECT version, body FROM mediacall_rooms WHERE id = $1 AND expires_at > $2', [roomId, now]);
    const row = rows[0];
    if (row) return { version: Number(row['version']), body: row['body'] as HostedRoom };
  }

  async create(roomId: string, now: number): Promise<void> {
    await this.initialize();
    await this.query('DELETE FROM mediacall_rooms WHERE expires_at <= $1', [now]);
    await this.query('INSERT INTO mediacall_rooms (id, body, expires_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (id) DO NOTHING', [roomId, JSON.stringify(emptyRoom()), now + 60_000]);
  }

  async replace(roomId: string, version: number, body: HostedRoom, now: number): Promise<boolean> {
    await this.initialize();
    const rows = await this.query('UPDATE mediacall_rooms SET body = $1::jsonb, version = version + 1, expires_at = $2 WHERE id = $3 AND version = $4 AND expires_at > $5 RETURNING version',
      [JSON.stringify(body), now + 60_000, roomId, version, now]);
    return rows.length === 1;
  }
}

export function neonRoomStore(databaseUrl: string): RoomStore {
  const sql = neon(databaseUrl);
  return new PostgresRoomStore(async (text, parameters) => await sql.query(text, parameters) as Record<string, unknown>[]);
}