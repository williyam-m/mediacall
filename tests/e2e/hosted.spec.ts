import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { createServer as createViteServer } from 'vite';
import { createHostedApi } from '../../src/server/hosted/api.ts';
import { PostgresRoomStore } from '../../src/server/hosted/roomStore.ts';
import { TurnServer } from '../../src/server/custom-turn/server.ts';

test('hosted HTTP signaling carries two-way Force TURN video and shows actual relay candidate proof', async ({ browser }, info) => {
  const database = new PGlite();
  const store = new PostgresRoomStore(async (text, parameters) => (await database.query<Record<string, unknown>>(text, parameters)).rows);
  const turn = new TurnServer({ secret: 'test-only-local-relay-secret', publicAddress: '127.0.0.1', bindAddress: '127.0.0.1', port: 0, relayMinPort: 51100, relayMaxPort: 51130, allowPrivatePeers: true });
  await turn.start();
  const api = createHostedApi({
    store, turn: { domain: 'test-fixture.metered.live', apiKey: 'not-used-by-local-fixture' },
    provideIce: async () => {
      const credentials = turn.auth.credentials();
      return { iceServers: [{ urls: `turn:127.0.0.1:${turn.port}?transport=udp`, username: credentials.username, credential: credentials.credential }], expiresAt: credentials.expiresAt };
    },
  });
  const vite = await createViteServer({ server: { middlewareMode: true, hmr: false }, appType: 'spa' });
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/api/')) api(request, response);
    else vite.middlewares(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const contexts = [];
  try {
    const firstContext = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 900 } });
    contexts.push(firstContext);
    const secondContext = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 390, height: 844 } });
    contexts.push(secondContext);
    const host = await firstContext.newPage();
    const guest = await secondContext.newPage();
    await host.goto(base);
    await expect(host.getByRole('button', { name: 'Create call', exact: true })).toBeEnabled();
    await expect(host.getByRole('button', { name: 'Automatic', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await host.getByRole('button', { name: 'Force TURN', exact: true }).click();
    await host.getByLabel('Your name', { exact: true }).fill('Alex Morgan');
    await host.getByRole('button', { name: 'Create call', exact: true }).click();
    await expect(host.getByTestId('call-status')).toHaveText('Waiting for guest');
    const invite = await host.getByRole('textbox', { name: 'Invite link', exact: true }).inputValue();
    await guest.goto(invite);
    await guest.getByLabel('Your name', { exact: true }).fill('Sam Rivera');
    await guest.getByRole('button', { name: 'Join call', exact: true }).click();
    for (const page of [host, guest]) {
      await expect(page.getByTestId('call-status')).toHaveText('Connected');
      await expect(page.getByTestId('connection-route')).toHaveText('TURN relay');
      await expect.poll(() => page.getByTestId('remote-video').evaluate((element) => {
        const video = element as HTMLVideoElement;
        return video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 5;
      })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    }
    await host.getByRole('button', { name: 'Open relay console', exact: true }).click();
    await expect(host.getByTestId('ice-candidate-pair')).toHaveText('relay / relay');
    await expect(host.getByRole('dialog')).toContainText('SESSION SENT');
    await host.screenshot({ path: info.outputPath('hosted-relay-proof-desktop.png') });
    await host.getByRole('button', { name: 'Close relay console', exact: true }).click();
    await guest.screenshot({ path: info.outputPath('hosted-relay-call-mobile.png') });
    await host.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    await expect(guest.locator('.participant .lucide-mic-off')).toHaveCount(1);
    await host.getByRole('button', { name: 'Turn camera off', exact: true }).click();
    await expect(guest.getByTestId('remote-video')).toHaveClass(/video-hidden/);
    await host.getByRole('button', { name: 'Turn camera on', exact: true }).click();
    await expect(guest.getByTestId('remote-video')).not.toHaveClass(/video-hidden/);
    const before = turn.stats().bytesToPeer;
    await expect.poll(() => turn.stats().bytesToPeer).toBeGreaterThan(before);
    await host.getByRole('button', { name: 'Leave call', exact: true }).click();
    await expect(guest.getByTestId('call-status')).toHaveText('Waiting for guest');
  } finally {
    for (const context of contexts) await context.close();
    await vite.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await turn.stop();
    await database.close();
  }
});