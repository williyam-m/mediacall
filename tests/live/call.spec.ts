import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

type ObservedWindow = Window & { demoConnections: RTCPeerConnection[] };

async function mediaProof(page: Page) {
  return page.evaluate(async () => {
    const connection = (window as ObservedWindow).demoConnections.find((entry) => entry.connectionState === 'connected');
    if (!connection) return null;
    const report = await connection.getStats();
    let pair: Record<string, unknown> | undefined;
    let audioSamples = 0;
    report.forEach((entry) => {
      if (entry.type === 'transport' && entry.selectedCandidatePairId) pair = report.get(entry.selectedCandidatePairId);
      if (entry.type === 'inbound-rtp' && entry.kind === 'audio') audioSamples += Number(entry.totalSamplesReceived ?? 0);
    });
    if (!pair) return null;
    const local = report.get(String(pair['localCandidateId']));
    const remote = report.get(String(pair['remoteCandidateId']));
    return {
      policy: connection.getConfiguration().iceTransportPolicy,
      localType: String(local.candidateType), remoteType: String(remote.candidateType),
      localIp: String(local.address ?? local.ip ?? ''), localPort: Number(local.port ?? 0),
      relayProtocol: String(local.relayProtocol ?? local.protocol ?? ''),
      bytesSent: Number(pair['bytesSent'] ?? 0), bytesReceived: Number(pair['bytesReceived'] ?? 0), audioSamples,
    };
  });
}

async function connectPair(browser: Browser, base: string, forceRelay: boolean) {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  try {
    for (const [index, name] of ['Demo host', 'Judge guest'].entries()) {
      const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: index ? 390 : 1440, height: 900 } });
      contexts.push(context);
      await context.addInitScript(() => {
        const Original = window.RTCPeerConnection;
        (window as ObservedWindow).demoConnections = [];
        window.RTCPeerConnection = class extends Original {
          constructor(configuration?: RTCConfiguration) { super(configuration); (window as ObservedWindow).demoConnections.push(this); }
        };
      });
      const page = await context.newPage();
      pages.push(page);
      const url = index ? await pages[0]!.getByRole('textbox', { name: 'Invite link', exact: true }).inputValue() : base;
      await page.goto(url);
      await expect(page.getByRole('button', { name: index ? 'Join call' : 'Create call', exact: true })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Automatic', exact: true })).toHaveAttribute('aria-pressed', 'true');
      if (!index && forceRelay) await page.getByRole('button', { name: 'Force TURN', exact: true }).click();
      await page.getByLabel('Your name', { exact: true }).fill(name);
      await page.getByRole('button', { name: index ? 'Join call' : 'Create call', exact: true }).click();
      await expect(page.getByTestId('call-status')).toHaveText(index ? 'Connected' : 'Waiting for guest');
    }
    return { host: pages[0]!, guest: pages[1]!, close: async () => { for (const context of contexts) await context.close(); } };
  } catch (cause) {
    for (const context of contexts) await context.close();
    throw cause;
  }
}

test('public deployment defaults to Automatic and can allocate through the hosted TURN provider', async ({ page, request }) => {
  const configResponse = await request.get('/api/config');
  expect(configResponse.ok()).toBe(true);
  const config = await configResponse.json() as { defaultMode: string; relay: { name: string; managed: boolean } };
  expect(config.defaultMode).toBe('auto');
  expect(config.relay.managed).toBe(true);
  expect(config.relay.name).toBe('Metered Open Relay');
  expect((await request.get('/api/health')).ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create call', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Test relay', exact: true }).click();
  await expect(page.getByText('Relay allocated', { exact: true })).toBeVisible();
});

for (const forceRelay of [false, true]) {
  test(`public ${forceRelay ? 'Force TURN' : 'Automatic ICE'} call receives media and live diagnostics`, async ({ browser, baseURL }, info) => {
    const pair = await connectPair(browser, baseURL!, forceRelay);
    try {
      for (const page of [pair.host, pair.guest]) {
        await expect(page.getByTestId('call-status')).toHaveText('Connected');
        await expect.poll(() => page.getByTestId('remote-video').evaluate((element) => {
          const video = element as HTMLVideoElement;
          return video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 10;
        })).toBe(true);
        await expect.poll(async () => (await mediaProof(page))?.audioSamples ?? 0).toBeGreaterThan(0);
        const proof = await mediaProof(page);
        expect(proof?.policy).toBe(forceRelay ? 'relay' : 'all');
        expect(proof?.bytesSent).toBeGreaterThan(0);
        expect(proof?.bytesReceived).toBeGreaterThan(0);
        if (forceRelay) {
          expect(proof?.localType).toBe('relay');
          expect(proof?.remoteType).toBe('relay');
          expect(proof?.localIp).not.toBe('');
          expect(proof?.localPort).toBeGreaterThan(0);
          await expect(page.getByTestId('connection-route')).toHaveText('TURN relay');
        }
        await info.attach('selected-ice-proof', { body: JSON.stringify(proof, null, 2), contentType: 'application/json' });
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      }
      await pair.host.getByRole('button', { name: 'Open relay console', exact: true }).click();
      const dialog = pair.host.getByRole('dialog', { name: 'Relay console', exact: true });
      await expect(dialog.getByTestId('inbound-bitrate')).not.toHaveText('--');
      const sample = await dialog.getByTestId('stats-sample-time').textContent();
      await expect(dialog.getByTestId('stats-sample-time')).not.toHaveText(sample!);
      if (forceRelay) {
        await expect(dialog.getByTestId('ice-candidate-pair')).toHaveText('relay / relay');
        await expect(dialog.getByTestId('local-relay-address')).not.toHaveText('Not disclosed by browser');
        expect(Number(await dialog.getByTestId('local-relay-port').textContent())).toBeGreaterThan(0);
        await expect(dialog.getByTestId('local-relay-location')).not.toHaveText('Looking up...');
        const relayIp = (await mediaProof(pair.host))!.localIp;
        const response = await pair.host.request.get(`/api/network?ip=${encodeURIComponent(relayIp)}`);
        expect(response.ok()).toBe(true);
        const location = await response.json() as { status: string; country: string | null; city: string | null; organization: string | null; ip: string };
        expect(location.ip).toBe(relayIp);
        await info.attach('relay-location', { body: JSON.stringify(location, null, 2), contentType: 'application/json' });
      }
      await pair.host.screenshot({ path: info.outputPath('desktop-relay-console.png') });
      await pair.host.getByRole('button', { name: 'Close relay console', exact: true }).click();
      await pair.host.screenshot({ path: info.outputPath('desktop-live-stats.png'), fullPage: true });
      await pair.guest.getByRole('button', { name: 'Open relay console', exact: true }).click();
      await pair.guest.screenshot({ path: info.outputPath('mobile-relay-console.png') });
      await pair.guest.getByRole('heading', { name: 'Connection states', exact: true }).scrollIntoViewIfNeeded();
      await expect(pair.guest.getByRole('button', { name: 'Close relay console', exact: true })).toBeInViewport();
      await pair.guest.getByRole('button', { name: 'Close relay console', exact: true }).click();
      await pair.host.getByRole('button', { name: 'Mute microphone', exact: true }).click();
      await expect(pair.guest.locator('.participant .lucide-mic-off')).toHaveCount(1);
      await pair.host.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
      await expect(pair.guest.locator('.participant .lucide-mic-off')).toHaveCount(0);
      await pair.host.getByRole('button', { name: 'Turn camera off', exact: true }).click();
      await expect(pair.guest.getByTestId('remote-video')).toHaveClass(/video-hidden/);
      await pair.host.getByRole('button', { name: 'Turn camera on', exact: true }).click();
      await expect(pair.guest.getByTestId('remote-video')).not.toHaveClass(/video-hidden/);
      await pair.host.getByRole('button', { name: 'Leave call', exact: true }).click();
      await expect(pair.guest.getByTestId('call-status')).toHaveText('Waiting for guest');
    } finally { await pair.close(); }
  });
}