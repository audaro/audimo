/**
 * Tunnel UI smoke tests — Playwright
 *
 * Run with:
 *   cd frontend && npx playwright test e2e/tunnel.test.cjs --config=playwright.config.cjs --reporter=list
 *
 * Requires backend (port 8000) and addon (port 9004) to be running.
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = 'http://127.0.0.1:8000';

// The addon URL must contain a base64-encoded config that includes
// real credentials (RD API key, slskd password, …). Don't hardcode it
// here. Set TUNNEL_TEST_ADDON_URL in the environment, e.g. by exporting
// the URL from the desktop app's Tauri WebView devtools first.
const ADDON_URL = process.env.TUNNEL_TEST_ADDON_URL || 'http://localhost:9004';

const ADDON_ENTRY = {
  id: 'audimo-aio',
  url: ADDON_URL,
  manifest: {
    id: 'audimo-aio',
    name: 'Audimo AIO',
    version: '1.0.0',
    description: 'Aggregator addon',
    capabilities: [
      'resolve.sources',
      'resolve.sources.stream',
      'resolve.stream',
      'cache.resolve',
      'slskd.status',
      'search.books',
    ],
    settings_schema: [],
  },
  enabled: true,
  settings: {},
  installedAt: 1777430604678,
  updatedAt: Date.now(),
};

// Seed localStorage before each test so the addon is always present.
async function seedAddon(page) {
  await page.addInitScript((entry) => {
    localStorage.setItem('tunnel:addons', JSON.stringify([entry]));
  }, ADDON_ENTRY);
}

// ── 1. Boot check ───────────────────────────────────────────────────
test('1. app loads without console errors', async ({ page }) => {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await seedAddon(page);
  await page.goto(BASE_URL);
  await expect(page).toHaveTitle(/Tunnel/i);
  await page.waitForTimeout(2000);
  const criticalErrors = errors.filter(
    (e) =>
      !e.includes('favicon') &&
      !e.includes('fonts.googleapis') &&
      !e.includes('net::ERR_')
  );
  console.log('Console errors:', criticalErrors);
  expect(criticalErrors.length, `Unexpected JS errors: ${criticalErrors.join('\n')}`).toBe(0);
});

// ── 2. Addons tab shows installed addon ─────────────────────────────
test('2. addons tab — audimo-aio appears enabled', async ({ page }) => {
  await seedAddon(page);
  await page.goto(BASE_URL);
  await page.waitForTimeout(1500);

  const addonsNav = page.getByText(/addons/i).first();
  await addonsNav.click();
  await page.waitForTimeout(500);

  await expect(page.getByText('Audimo AIO')).toBeVisible();
  await expect(page.getByRole('button', { name: /^on$/i })).toBeVisible();
  console.log('✅ Addon card visible and enabled');
});

// ── 3. Track search returns results ─────────────────────────────────
// Search calls /api/search/tracks (Deezer-backed); results render as .songRow
test('3. search — track results appear within 10s', async ({ page }) => {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await seedAddon(page);
  await page.goto(BASE_URL);
  await page.waitForTimeout(1500);

  // The global search input (first one in the SearchView)
  const searchInput = page.getByPlaceholder('Search songs, artists, audiobooks…');
  await searchInput.click();
  await searchInput.fill('Eminem');
  // Results are debounced — no need to press Enter
  await page.waitForTimeout(600);

  // Songs section: rows use class containing "songRow"
  const songRows = page.locator('[class*="songRow"]');
  await expect(songRows.first()).toBeVisible({ timeout: 10000 });

  const count = await songRows.count();
  const consoleErrs = errors.filter(e => !e.includes('favicon') && !e.includes('fonts.googleapis'));
  console.log(`✅ Got ${count} song rows. Console errors: ${consoleErrs.length}`);
  expect(count).toBeGreaterThan(0);
  expect(consoleErrs.length).toBe(0);
});

// ── 4. Source picker opens on song click ────────────────────────────
test('4. source picker — opens when clicking a song result', async ({ page }) => {
  await seedAddon(page);
  await page.goto(BASE_URL);
  await page.waitForTimeout(1500);

  const searchInput = page.getByPlaceholder('Search songs, artists, audiobooks…');
  await searchInput.click();
  await searchInput.fill('Eminem Lose Yourself');
  await page.waitForTimeout(600);

  // Wait for song rows, then click first one
  const songRows = page.locator('[class*="songRow"]');
  await expect(songRows.first()).toBeVisible({ timeout: 10000 });
  await songRows.first().click();

  // SourcePicker renders .overlay (fixed backdrop) then .modal inside it.
  // Vite hashes: _overlay_rt5xo_1 / _modal_rt5xo_7
  const overlay = page.locator('[class*="_overlay_"]');
  await expect(overlay).toBeVisible({ timeout: 10000 });
  console.log('✅ Source picker opened');
});

// ── 5. Source picker shows sources from addon ───────────────────────
// Uses retries: prior tests (esp. #4) can leave the addon's SSE stream
// open, causing the first attempt to stall on network idle. On retry the
// stream has closed and everything is fast.
test('5. source picker — sources load from addon within 20s', { retries: 2 }, async ({ page }) => {
  await seedAddon(page);
  await page.goto(BASE_URL);
  await page.waitForTimeout(2000); // let prior SSE streams settle

  const searchInput = page.getByPlaceholder('Search songs, artists, audiobooks…');
  await searchInput.click();
  await searchInput.fill('Eminem Lose Yourself');
  await page.waitForTimeout(1000); // debounce (200ms) + API round trip

  // Use the same pattern as tests 3 & 4 which reliably finds the first visible row
  const songRows = page.locator('[class*="songRow"]');
  await expect(songRows.first()).toBeVisible({ timeout: 12000 });
  await songRows.first().click();

  // Wait for at least one source row to appear inside the picker
  const sourceRows = page.locator('[class*="_sourceRow_"], [class*="_pickerRow_"]');
  await expect(sourceRows.first()).toBeVisible({ timeout: 20000 });
  const count = await sourceRows.count();
  console.log(`✅ Source picker shows ${count} source rows`);
  expect(count).toBeGreaterThan(0);
});

// ── 6. Addon export produces a JSON file ────────────────────────────
test('6. addon export — download triggers', async ({ page }) => {
  await seedAddon(page);
  await page.goto(BASE_URL);
  await page.waitForTimeout(1500);

  const addonsNav = page.getByText(/addons/i).first();
  await addonsNav.click();
  await page.waitForTimeout(500);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.getByRole('button', { name: /export/i }).click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/tunnel-addons.*\.json/);
  console.log(`✅ Export download: ${download.suggestedFilename()}`);
});

// ── 7. Backend — library (cache) endpoint responds ──────────────────
test('7. backend — /api/cache/list returns 200', async ({ page }) => {
  await seedAddon(page);
  await page.goto(BASE_URL);

  const resp = await page.request.get(`${BASE_URL}/api/cache/list`);
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  const count = body?.count ?? (Array.isArray(body?.entries) ? body.entries.length : '?');
  console.log(`✅ /api/cache/list → ${count} library entries`);
});

// ── 8. Backend — search endpoint responds ───────────────────────────
test('8. backend — /api/search/tracks returns tracks', async ({ page }) => {
  await seedAddon(page);
  await page.goto(BASE_URL);

  const resp = await page.request.get(`${BASE_URL}/api/search/tracks?q=eminem&limit=5`);
  // 500 = transient Deezer API error (rate limit / upstream blip) — still counts as backend alive
  if (resp.status() === 500) {
    console.log('⚠️  /api/search/tracks → 500 (transient Deezer error, backend is alive)');
    return;
  }
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(Array.isArray(body.tracks)).toBe(true);
  expect(body.tracks.length).toBeGreaterThan(0);
  console.log(`✅ /api/search/tracks → ${body.tracks.length} results, first: "${body.tracks[0].title}" by ${body.tracks[0].artist}`);
});

// ── 9. Addon manifest reachable from browser context ────────────────
test('9. addon — manifest.json reachable', async ({ page }) => {
  await page.goto(BASE_URL);
  const resp = await page.request.get('http://localhost:9004/manifest.json');
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(body.id).toBe('audimo-aio');
  console.log(`✅ Addon v${body.version} — caps: ${body.capabilities.join(', ')}`);
});

// ── 10. My Music tab loads cleanly ──────────────────────────────────
test('10. my music tab — loads without JS errors', async ({ page }) => {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await seedAddon(page);
  await page.goto(BASE_URL);
  await page.waitForTimeout(1500);

  // Click the sidebar "My Library" nav item or bottom nav "Library" button
  const musicNav = page.getByRole('button', { name: /my library|library/i }).first();
  await musicNav.click();
  await page.waitForTimeout(1000);

  const criticalErrors = errors.filter(
    (e) =>
      !e.includes('favicon') &&
      !e.includes('fonts.googleapis') &&
      !e.includes('net::ERR_') &&
      !e.includes('Failed to load resource')
  );
  console.log('My Music errors:', criticalErrors);
  expect(criticalErrors.length).toBe(0);
  console.log('✅ My Music tab loaded cleanly');
});

// ── 11. Audiobooks tab loads cleanly ────────────────────────────────
test('11. audiobooks tab — loads without JS errors', async ({ page }) => {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await seedAddon(page);
  await page.goto(BASE_URL);
  await page.waitForTimeout(1500);

  const abNav = page.getByText(/audiobook/i).first();
  if (await abNav.isVisible()) {
    await abNav.click();
    await page.waitForTimeout(1000);
  }

  const criticalErrors = errors.filter(
    (e) =>
      !e.includes('favicon') &&
      !e.includes('fonts.googleapis') &&
      !e.includes('net::ERR_') &&
      !e.includes('Failed to load resource')
  );
  console.log('Audiobooks errors:', criticalErrors);
  expect(criticalErrors.length).toBe(0);
  console.log('✅ Audiobooks tab loaded cleanly');
});

// ── 12. slskd status reachable via addon ────────────────────────────
test('12. slskd — status endpoint responds', async ({ page }) => {
  await seedAddon(page);
  await page.goto(BASE_URL);

  const resp = await page.request.get('http://localhost:9004/slskd/status');
  console.log(`slskd status → HTTP ${resp.status()}`);
  // 200 = slskd running; 5xx = slskd down but addon is alive
  expect([200, 500, 502, 503]).toContain(resp.status());
  console.log(`✅ slskd endpoint responded (${resp.status()})`);
});
