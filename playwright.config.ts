import { defineConfig, devices } from '@playwright/test'

// iPhone 13 metrics on chromium: device options belong in `use` (unknown
// top-level project keys are dropped by the runner). defaultBrowserType is
// removed so the project's chromium is used — webkit is not installed.
const { defaultBrowserType: _deviceDefault, ...iphoneUse } = devices['iPhone 13']

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  projects: [
    {
      name: 'iPhone Safari-like',
      browserName: 'chromium',
      use: { ...iphoneUse },
    },
  ],
  webServer: {
    command:
      'npm run build && WORKMUX_HTTP_PORT=4173 WORKMUX_HTTP_FIXTURES=$PWD/fixtures WORKMUX_CLAUDE_COMMIT_CMD="/usr/bin/true" npm start',
    url: 'http://127.0.0.1:4173/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
