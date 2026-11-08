import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  projects: [{ name: 'iPhone Safari-like', ...devices['iPhone 13'], browserName: 'chromium' }],
  webServer: {
    command: 'npm run build && WORKMUX_HTTP_PORT=4173 WORKMUX_HTTP_FIXTURES=$PWD/fixtures npm start',
    url: 'http://127.0.0.1:4173/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
