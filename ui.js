'use strict';

/**
 * Browser UI test for the Vercel edition (HTTP polling instead of sockets).
 * Drives the real pages at mobile + desktop sizes and captures console errors.
 *
 *   npm run dev          # terminal 1
 *   node test/ui.js      # terminal 2
 */

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const SHOT_DIR = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const errors = [];
let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

function watch(page, label) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // 401s are expected on the login page (session probe)
    if (/status of 401/.test(text)) return;
    errors.push(`[${label}] console: ${text}`);
  });
  page.on('pageerror', (err) => errors.push(`[${label}] pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (url.includes('socket.io')) return;
    errors.push(`[${label}] requestfailed: ${url} ${req.failure()?.errorText}`);
  });
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: false });
}

/**
 * Removes leftovers from previous UI test runs so the suite is repeatable.
 * Uses the API directly (not the browser).
 */
async function resetTestData() {
  const loginRes = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ADMIN_USERNAME || 'admin',
      password: process.env.ADMIN_PASSWORD || 'admin123'
    })
  });
  const cookie = (loginRes.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  const call = (method, path, body) =>
    fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined
    });

  const state = await call('GET', '/api/admin/state').then((r) => r.json());
  for (const poll of state.polls) {
    if (poll.question.startsWith('UI test')) {
      await call('DELETE', `/api/admin/polls/${poll.id}`);
    } else if (['active', 'paused'].includes(poll.status)) {
      await call('POST', `/api/admin/polls/${poll.id}/action`, { action: 'close' });
    }
  }
  const people = await call('GET', '/api/admin/participants').then((r) => r.json());
  for (const p of people.participants.filter((x) => x.employeeId.startsWith('UI-'))) {
    await call('DELETE', `/api/admin/participants/${p.id}`);
  }
}

(async () => {
  await resetTestData();
  const browser = await chromium.launch();

  /* ------------------------- participant mobile ------------------------- */
  console.log('\n📱 Participant flow (iPhone 13 viewport)');
  const mobile = await browser.newContext({ ...devices['iPhone 13'] });
  const p1 = await mobile.newPage();
  watch(p1, 'participant');

  await p1.goto(BASE, { waitUntil: 'networkidle' });
  ok('join page loads', await p1.locator('#join-form').isVisible());
  ok('share link shown on the join page', /^https?:\/\//.test((await p1.locator('#join-url').textContent()) || ''));
  const noOverflow = await p1.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok('no horizontal overflow on mobile', noOverflow);
  await shot(p1, '01-join-mobile.png');

  await p1.fill('#name', 'Priya Sharma');
  await p1.fill('#employeeId', 'UI-1001');
  await p1.click('#join-submit');
  await p1.waitForURL('**/poll', { timeout: 8000 });
  ok('join redirects to polling page', p1.url().includes('/poll'));
  await p1.waitForTimeout(1200);
  await shot(p1, '02-poll-idle-mobile.png');

  /* ------------------------------ admin flow ---------------------------- */
  console.log('\n🖥  Admin flow (desktop)');
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const admin = await desktop.newPage();
  watch(admin, 'admin');

  await admin.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  ok('unauthenticated admin redirects to login', admin.url().includes('/admin-login'));
  await shot(admin, '03-admin-login.png');

  await admin.fill('#username', 'admin');
  await admin.fill('#password', 'admin123');
  await admin.click('#login-btn');
  await admin.waitForURL('**/admin', { timeout: 8000 });
  await admin.waitForTimeout(1200);
  ok('admin dashboard loads after login', await admin.locator('#dash-kpis').isVisible());
  ok('dashboard KPIs rendered', (await admin.locator('.kpi').count()) >= 4);
  await shot(admin, '04-admin-dashboard.png');

  /* create + start a poll through the UI */
  await admin.goto(`${BASE}/admin/polls`, { waitUntil: 'networkidle' });
  await admin.click('#new-poll');
  await admin.fill('#f-question', 'UI test: who lifts the trophy tonight?');
  await admin.fill('#f-category', 'Fun Poll');
  const rows = admin.locator('.option-input-row');
  await rows.nth(0).locator('input').nth(1).fill('Pune Panthers');
  await rows.nth(1).locator('input').nth(1).fill('Mumbai Mavericks');
  await admin.click('#add-option');
  await rows.nth(2).locator('input').nth(1).fill('Delhi Dynamos');
  await admin.click('#timer-presets button[data-secs="120"]');
  await shot(admin, '05-admin-create-poll.png');
  await admin.click('#save-start');
  await admin.waitForTimeout(1800);
  ok('poll created and started from UI', await admin.locator('.poll-item.is-live').count() > 0);
  await shot(admin, '06-admin-polls-live.png');

  /* participant sees live poll in real time */
  await p1.waitForTimeout(4500);
  const questionText = await p1.locator('.poll-question').textContent().catch(() => '');
  ok('participant sees the live poll without refreshing (polling)', /trophy tonight/i.test(questionText || ''), questionText || 'none');
  ok('options rendered', (await p1.locator('.option').count()) === 3);
  await p1.locator('.option').first().click();
  ok('selected option gets highlight', await p1.locator('.option.selected').count() === 1);
  await shot(p1, '07-poll-vote-mobile.png');

  await p1.click('#vote-btn');
  await p1.waitForURL('**/vote-confirmed**', { timeout: 8000 });
  await p1.waitForTimeout(1000);
  ok('confirmation page shows chosen answer', /Pune Panthers/.test(await p1.locator('#choice').textContent()));
  await shot(p1, '08-vote-confirmed-mobile.png');

  /* duplicate vote prevention in the UI */
  await p1.goto(`${BASE}/poll`, { waitUntil: 'networkidle' });
  await p1.waitForTimeout(1200);
  ok('poll page shows "already voted" state after voting', await p1.locator('.voted-state').count() === 1);
  ok('vote button hidden after voting', await p1.locator('#vote-btn').count() === 0);
  await shot(p1, '09-poll-voted-mobile.png');

  /* results visibility: admin reveals live results */
  await admin.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await admin.click('[data-visibility="during"]');
  await admin.waitForTimeout(2500);
  await p1.waitForTimeout(4000);
  const hasResults = await p1.locator('.result-row').count();
  ok('live results appear for participants when revealed', hasResults > 0, `rows=${hasResults}`);
  await shot(p1, '10-poll-results-mobile.png');
  await shot(admin, '11-admin-dashboard-live.png');

  /* results page + history */
  const rp = await mobile.newPage();
  watch(rp, 'results');
  await rp.goto(`${BASE}/results`, { waitUntil: 'networkidle' });
  await rp.waitForTimeout(1000);
  ok('results page loads for participants', await rp.locator('body').isVisible());
  await shot(rp, '12-results-mobile.png');

  /* display / projector */
  const projCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const proj = await projCtx.newPage();
  watch(proj, 'display');
  await proj.goto(`${BASE}/display`, { waitUntil: 'networkidle' });
  await proj.waitForTimeout(3200);
  ok('big-screen display renders the live poll', /trophy tonight/i.test(await proj.locator('.dp-question').first().textContent().catch(() => '')));
  ok('display shows the join link', /localhost|http/.test((await proj.locator('#dp-url').textContent()) || ''));
  await shot(proj, '13-display-live.png');

  /* admin pages */
  for (const [route, shotName, check] of [
    ['/admin/participants', '14-admin-participants.png', '.participant-row'],
    ['/admin/history', '15-admin-history.png', '#h-list']
  ]) {
    await admin.goto(BASE + route, { waitUntil: 'networkidle' });
    await admin.waitForTimeout(900);
    ok(`${route} renders`, (await admin.locator(check).count()) > 0);
    await shot(admin, shotName);
  }

  /* mobile admin */
  const mAdminCtx = await browser.newContext({ ...devices['iPhone 13'] });
  const mAdmin = await mAdminCtx.newPage();
  watch(mAdmin, 'admin-mobile');
  await mAdmin.goto(`${BASE}/admin-login`, { waitUntil: 'networkidle' });
  await mAdmin.fill('#username', 'admin');
  await mAdmin.fill('#password', 'admin123');
  await mAdmin.click('#login-btn');
  await mAdmin.waitForURL('**/admin', { timeout: 8000 });
  await mAdmin.waitForTimeout(1200);
  ok('admin dashboard usable on mobile', await mAdmin.locator('.tabbar').isVisible());
  const adminOverflow = await mAdmin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
  ok('admin dashboard has no horizontal overflow on mobile', adminOverflow);
  await shot(mAdmin, '16-admin-mobile.png');

  /* close the poll and check the final display */
  await admin.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await admin.waitForTimeout(1200);
  await admin.click('[data-poll-act="close"]');
  await admin.waitForTimeout(500);
  await admin.click('.modal [data-act="ok"]');
  await admin.waitForTimeout(2200);
  await proj.waitForTimeout(4500);
  await shot(proj, '17-display-closed.png');
  await p1.goto(`${BASE}/poll`, { waitUntil: 'networkidle' });
  await p1.waitForTimeout(2500);
  ok('participants see closed state with results', /closed|Final/i.test(await p1.locator('#poll-area').textContent()));
  await shot(p1, '18-poll-closed-mobile.png');

  /* start a sample poll for the live demo screenshots */
  await admin.goto(`${BASE}/admin/polls`, { waitUntil: 'networkidle' });
  await admin.waitForTimeout(800);
  const startBtn = admin.locator('[data-poll-act="start"]').first();
  if (await startBtn.count()) {
    await startBtn.click();
    await admin.waitForTimeout(400);
    await admin.click('.modal [data-act="ok"]');
    await admin.waitForTimeout(1500);
  }
  await shot(admin, '19-admin-polls-final.png');

  await browser.close();

  console.log('\n' + '='.repeat(52));
  console.log(`  UI: ${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log('\n  Browser errors captured:');
    [...new Set(errors)].forEach((e) => console.log('   - ' + e));
  } else {
    console.log('  No browser console errors 🎉');
  }
  console.log('='.repeat(52) + '\n');
  process.exit(fail || errors.length ? 1 : 0);
})();
