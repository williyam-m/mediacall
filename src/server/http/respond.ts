import type { IncomingMessage, ServerResponse } from 'node:http';
import { validAccessToken } from '../custom-turn/auth.ts';

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

export function authorized(request: IncomingMessage, token: string | undefined): boolean {
  const authorization = request.headers.authorization;
  return validAccessToken(authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined, token);
}