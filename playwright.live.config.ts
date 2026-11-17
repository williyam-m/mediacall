import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/live',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: {
    baseURL: process.env['LIVE_BASE_URL'] ?? 'https://mediacall-six.vercel.app',
    viewport: { width: 1440, height: 900 },
    permissions: ['camera', 'microphone'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
  },
});