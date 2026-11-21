import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:4173', permissions: ['camera','microphone'],
    launchOptions: { executablePath: process.env.AIRCAST_BROWSER || undefined,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling','--disable-renderer-backgrounding'] } },
  webServer: { command: 'node tests/server.mjs', url:'http://127.0.0.1:4173/', reuseExistingServer: false }
});
