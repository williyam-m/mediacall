import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

type InstrumentedWindow = Window & { testConnections: RTCPeerConnection[] };

async function contextWithMedia(browser: Browser, clientTransport?: 'udp' | 'tcp' | 'direct') {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    const original = window.RTCPeerConnection;
    const instrumented = window as InstrumentedWindow;
    instrumented.testConnections = [];
    window.RTCPeerConnection = class extends original {
      constructor(config?: RTCConfiguration) { super(config); instrumented.testConnections.push(this); }
    };
  });
  if (clientTransport) await context.route('**/api/ice', async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { iceServers: RTCIceServer[]; expiresAt: number };
    body.iceServers = clientTransport === 'direct' ? [] : body.iceServers.flatMap((server) => {
      const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => url.startsWith('turn:') && url.endsWith(`?transport=${clientTransport}`));
      return urls.length ? [{ ...server, urls }] : [];
    });
    await route.fulfill({ response, json: body });
  });
  return context;
}

async function selectedPair(page: Page) {
  return page.evaluate(async () => {
    const connection = (window as InstrumentedWindow).testConnections.find((entry) => entry.connectionState === 'connected');
    if (!connection) return null;
    const report = await connection.getStats();
    let pair: Record<string, unknown> | undefined;
    report.forEach((entry) => { if (entry.type === 'transport' && entry.selectedCandidatePairId) pair = report.get(entry.selectedCandidatePairId); });
    if (!pair) return null;
    const local = report.get(String(pair['localCandidateId']));
    const remote = report.get(String(pair['remoteCandidateId']));
    return {
      policy: connection.getConfiguration().iceTransportPolicy,
      localType: local.candidateType, remoteType: remote.candidateType,
      relayProtocol: local.relayProtocol, protocol: local.protocol,
      bytesSent: pair['bytesSent'], bytesReceived: pair['bytesReceived'],
    };
  });
}

async function connectPair(browser: Browser, mode: 'auto' | 'relay', audio = false, tcpOnly = false, guestForce = false) {
  const contexts: BrowserContext[] = [];
  try {
    const clientTransport = mode === 'relay' ? (tcpOnly ? 'tcp' : 'udp') : guestForce ? undefined : 'direct';
    const firstContext = await contextWithMedia(browser, clientTransport);
    contexts.push(firstContext);
    const secondContext = await contextWithMedia(browser, clientTransport);
    contexts.push(secondContext);
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    await first.goto('http://127.0.0.1:5180');
    await expect(first.getByRole('button', { name: 'Create call', exact: true })).toBeEnabled();
    await first.getByLabel('Your name', { exact: true }).fill('Alex Morgan');
    if (mode === 'relay') await first.getByRole('button', { name: 'Force TURN', exact: true }).click();
    if (audio) await first.getByRole('button', { name: 'Audio call', exact: true }).click();
    await first.getByRole('button', { name: 'Create call', exact: true }).click();
    await expect(first.getByTestId('call-status')).toHaveText('Waiting for guest');
    const invite = await first.getByRole('textbox', { name: 'Invite link', exact: true }).inputValue();
    await second.goto(invite);
    await expect(second.getByRole('button', { name: 'Join call', exact: true })).toBeEnabled();
    await second.getByLabel('Your name', { exact: true }).fill('Sam Rivera');
    if (guestForce) await second.getByRole('button', { name: 'Force TURN', exact: true }).click();
    if (audio) await second.getByRole('button', { name: 'Audio call', exact: true }).click();
    await second.getByRole('button', { name: 'Join call', exact: true }).click();
    await expect(first.getByTestId('call-status')).toHaveText('Connected');
    await expect(second.getByTestId('call-status')).toHaveText('Connected');
    return { first, second, close: async () => { for (const context of contexts) await context.close(); } };
  } catch (cause) {
    for (const context of contexts) await context.close();
    throw cause;
  }
}

for (const scenario of [
  { title: 'automatic routing selects a direct peer connection', mode: 'auto' as const, tcpOnly: false },
  { title: 'force TURN sends video through the custom UDP relay', mode: 'relay' as const, tcpOnly: false },
  { title: 'force TURN works over TCP-only client transport', mode: 'relay' as const, tcpOnly: true },
]) {
  test(scenario.title, async ({ browser }, info) => {
    const pair = await connectPair(browser, scenario.mode, false, scenario.tcpOnly);
    try {
      const route = scenario.mode === 'relay' ? 'TURN relay' : 'Peer-to-peer';
      await expect(pair.first.getByTestId('connection-route')).toHaveText(route);
      await expect(pair.second.getByTestId('connection-route')).toHaveText(route);
      for (const page of [pair.first, pair.second]) {
        await expect.poll(async () => selectedPair(page)).not.toBeNull();
        const selected = await selectedPair(page);
        expect(selected?.policy).toBe(scenario.mode === 'relay' ? 'relay' : 'all');
        if (scenario.mode === 'relay') {
          expect(selected?.localType).toBe('relay');
          expect(selected?.remoteType).toBe('relay');
          expect(selected?.relayProtocol).toBe(scenario.tcpOnly ? 'tcp' : 'udp');
        }
        await expect.poll(() => page.getByTestId('remote-video').evaluate((element) => {
          const video = element as HTMLVideoElement;
          return video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 3;
        })).toBe(true);
        const pixels = await page.getByTestId('remote-video').evaluate((element) => {
          const canvas = document.createElement('canvas');
          canvas.width = 96; canvas.height = 54;
          const context = canvas.getContext('2d')!;
          context.drawImage(element as HTMLVideoElement, 0, 0, 96, 54);
          const data = context.getImageData(0, 0, 96, 54).data;
          const colors = new Set<string>();
          for (let offset = 0; offset < data.length; offset += 16) colors.add(`${data[offset]}:${data[offset + 1]}:${data[offset + 2]}`);
          return colors.size;
        });
        expect(pixels).toBeGreaterThan(8);
        await info.attach('selected-ice-pair', { body: JSON.stringify(selected, null, 2), contentType: 'application/json' });
      }
      await pair.first.screenshot({ path: info.outputPath('connected-desktop.png') });
      if (scenario.mode === 'auto') {
        await pair.first.getByRole('button', { name: 'Mute microphone', exact: true }).click();
        expect(await pair.first.evaluate(() => (window as InstrumentedWindow).testConnections.find((entry) => entry.connectionState === 'connected')!.getSenders().find((sender) => sender.track?.kind === 'audio')!.track!.enabled)).toBe(false);
        await expect(pair.second.locator('.participant .lucide-mic-off')).toHaveCount(1);
        await pair.first.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
        await expect(pair.second.locator('.participant .lucide-mic-off')).toHaveCount(0);
        await pair.first.getByRole('button', { name: 'Turn camera off', exact: true }).click();
        await expect(pair.second.getByTestId('remote-video')).toHaveClass(/video-hidden/);
        await pair.first.getByRole('button', { name: 'Turn camera on', exact: true }).click();
        await expect(pair.second.getByTestId('remote-video')).not.toHaveClass(/video-hidden/);
        await pair.first.evaluate(() => {
          navigator.mediaDevices.getDisplayMedia = async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 1280; canvas.height = 720;
            const context = canvas.getContext('2d')!;
            context.fillStyle = '#c4ed85'; context.fillRect(0, 0, 1280, 720);
            context.fillStyle = '#315dca'; context.fillRect(80, 80, 600, 400);
            return canvas.captureStream(15);
          };
        });
        await pair.first.getByRole('button', { name: 'Share screen', exact: true }).click();
        await expect(pair.second.locator('.stage-tag')).toHaveText('SCREEN SHARE');
        await pair.first.getByRole('button', { name: 'Stop sharing screen', exact: true }).click();
        await expect(pair.second.locator('.stage-tag')).toHaveText('LIVE CALL');
      }
      await pair.first.getByRole('button', { name: 'Leave call', exact: true }).click();
      await expect(pair.first.getByTestId('call-status')).toHaveText('Call ended');
      await expect(pair.second.getByTestId('call-status')).toHaveText('Waiting for guest');
      expect(await pair.first.getByTestId('local-video').evaluate((element) => (element as HTMLVideoElement).srcObject)).toBeNull();
    } finally { await pair.close(); }
  });
}

test('audio-only calls relay real audio without capturing video', async ({ browser }) => {
  const pair = await connectPair(browser, 'relay', true);
  try {
    await expect(pair.first.getByTestId('connection-route')).toHaveText('TURN relay');
    for (const page of [pair.first, pair.second]) {
      const kinds = await page.evaluate(() => (window as InstrumentedWindow).testConnections.find((entry) => entry.connectionState === 'connected')!.getSenders().filter((sender) => sender.track).map((sender) => sender.track!.kind));
      expect(kinds).toEqual(['audio']);
      await expect.poll(() => page.evaluate(async () => {
        const current = (window as InstrumentedWindow).testConnections.find((entry) => entry.connectionState === 'connected')!;
        const report = await current.getStats();
        let samples = 0;
        report.forEach((entry) => { if (entry.type === 'inbound-rtp' && entry.kind === 'audio') samples += Number(entry.totalSamplesReceived ?? 0); });
        return samples;
      })).toBeGreaterThan(0);
    }
  } finally { await pair.close(); }
});

test('a guest choosing Force TURN makes both peers relay-only', async ({ browser }) => {
  const pair = await connectPair(browser, 'auto', false, false, true);
  try {
    for (const page of [pair.first, pair.second]) {
      await expect(page.getByTestId('connection-route')).toHaveText('TURN relay');
      const selected = await selectedPair(page);
      expect(selected?.policy).toBe('relay');
      expect(selected?.localType).toBe('relay');
      expect(selected?.remoteType).toBe('relay');
    }
  } finally { await pair.close(); }
});

test('desktop, mobile, and narrow editor layouts fit; the relay probe allocates', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create call', exact: true })).toBeEnabled();
  for (const width of [1440, 768, 390, 320, 266]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    if (width === 1440 || width === 390) await page.screenshot({ path: info.outputPath(`preview-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Call settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Call settings', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Test relay', exact: true }).click();
  await expect(page.getByText('Relay allocated', { exact: true })).toBeVisible();
});

test('permission denial produces an actionable error instead of a stuck call', async ({ page }) => {
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); }; });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create call', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Create call', exact: true }).click();
  await expect(page.getByTestId('call-status')).toHaveText('Call unavailable');
  await expect(page.getByRole('alert')).toContainText('access was denied');
  await expect(page.getByRole('button', { name: 'Create call', exact: true })).toBeEnabled();
});