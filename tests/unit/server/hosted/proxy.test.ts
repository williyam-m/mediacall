import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { createCallApiProxy } from '../../../../src/server/hosted/proxy.ts';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('Vercel deployment fails closed until an HTTPS backend origin is configured', async (context) => {
  for (const origin of [undefined, 'not-a-url', 'http://backend.example.com', 'https://user:password@backend.example.com', 'https://backend.example.com/path', 'https://backend.example.com/?token=value']) {
    const server = createServer(createCallApiProxy(origin, async () => { throw new Error('Must not fetch'); }));
    context.after(() => close(server));
    const base = await listen(server);
    const response = await fetch(`${base}/api/config`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as { status: string; error: string };
    assert.equal(body.status, 'unconfigured');
    assert.match(body.error, /not configured/);
  }
});

test('Vercel API bridge forwards only allowed GET requests and preserves access-token authorization', async (context) => {
  const calls: { url: string; authorization: string | null }[] = [];
  const proxy = createCallApiProxy('https://backend.example.com', async (input, options) => {
    calls.push({ url: String(input), authorization: new Headers(options?.headers).get('Authorization') });
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.cache, 'no-store');
    assert.ok(options?.signal);
    return Response.json({ error: 'Access token required.' }, { status: 401 });
  });
  const server = createServer(proxy);
  context.after(() => close(server));
  const base = await listen(server);
  const response = await fetch(`${base}/api/relay?destination=https://untrusted.invalid`, { headers: { Authorization: 'Bearer test-access' } });
  assert.equal(response.status, 401);
  assert.deepEqual(calls, [{ url: 'https://backend.example.com/api/relay', authorization: 'Bearer test-access' }]);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  const rejected = await fetch(`${base}/api/ice`, { method: 'POST' });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('allow'), 'GET');
  assert.equal(calls.length, 1);
});

test('Vercel ICE configuration uses the external secure WebSocket origin', async (context) => {
  const original = { iceServers: [{ urls: 'turn:turn.example.com:3478', username: 'test-user', credential: 'test-password' }], expiresAt: 1_900_000_000 };
  const server = createServer(createCallApiProxy('https://backend.example.com:8443', async () => Response.json(original)));
  context.after(() => close(server));
  const base = await listen(server);
  const response = await fetch(`${base}/api/ice`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...original, signalingUrl: 'wss://backend.example.com:8443/signal' });
});

test('Vercel API bridge hides upstream transport errors, redirects, and malformed ICE data', async (context) => {
  const responses: (() => Response)[] = [
    () => { throw new Error('Internal network details'); },
    () => Response.redirect('https://untrusted.invalid'),
    () => new Response('<html>Unexpected error</html>'),
    () => Response.json({ unexpected: true }),
  ];
  for (const upstream of responses) {
    const server = createServer(createCallApiProxy('https://backend.example.com', async () => upstream()));
    context.after(() => close(server));
    const base = await listen(server);
    const response = await fetch(`${base}/api/ice`);
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.match(text, /unreachable/);
    assert.doesNotMatch(text, /Internal network|Unexpected error|untrusted/);
  }
});