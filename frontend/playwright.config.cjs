const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:8000',
    headless: true,
    viewport: { width: 1280, height: 800 },
    // Allow connections to localhost addon
    ignoreHTTPSErrors: true,
  },
  reporter: [['list'], ['json', { outputFile: 'e2e/results.json' }]],
});
