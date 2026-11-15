import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function equalText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export class TurnAuth {
  readonly realm: string;
  private readonly secret: string;
  private readonly nonceLifetime: number;

  constructor(secret: string, realm: string, nonceLifetime = 600) {
    this.secret = secret;
    this.realm = realm;
    this.nonceLifetime = nonceLifetime;
  }

  credentials(lifetime = 3600, now = Date.now()) {
    const username = `${Math.floor(now / 1000) + lifetime}:${randomBytes(12).toString('hex')}`;
    return { username, credential: this.password(username), expiresAt: Math.floor(now / 1000) + lifetime };
  }

  private password(username: string): string {
    return createHmac('sha1', this.secret).update(username).digest('base64');
  }

  key(username: string, allowExpired = false, now = Date.now()): Buffer | undefined {
    const match = /^(\d{10,12}):([a-f0-9]{24})$/.exec(username);
    if (!match || (!allowExpired && Number(match[1]) <= Math.floor(now / 1000))) return;
    return createHash('md5').update(`${username}:${this.realm}:${this.password(username)}`).digest();
  }

  nonce(address: string, now = Date.now()): string {
    const payload = `${Math.floor(now / 1000)}.${randomBytes(8).toString('hex')}`;
    const signature = createHmac('sha256', this.secret).update(`${address}:${payload}`).digest('base64url');
    return `${payload}.${signature}`;
  }

  verifyNonce(nonce: string, address: string, now = Date.now()): 'valid' | 'invalid' | 'stale' {
    const match = /^(\d{10,12})\.([a-f0-9]{16})\.([a-zA-Z0-9_-]{43})$/.exec(nonce);
    if (!match) return 'invalid';
    const payload = `${match[1]}.${match[2]}`;
    const expected = createHmac('sha256', this.secret).update(`${address}:${payload}`).digest('base64url');
    if (!equalText(expected, match[3]!)) return 'invalid';
    const age = Math.floor(now / 1000) - Number(match[1]);
    if (age < -30) return 'invalid';
    return age > this.nonceLifetime ? 'stale' : 'valid';
  }
}

export function validAccessToken(actual: string | undefined, expected: string | undefined): boolean {
  return expected === undefined || (actual !== undefined && equalText(actual, expected));
}