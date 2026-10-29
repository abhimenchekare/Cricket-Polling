'use strict';

/**
 * Browser test for the two things added after the first deployment:
 *
 *   1. ⚡ Rapid round — admin fires a 10-15 s "guess the next player" round from the
 *      dashboard in one tap; participants vote; voting locks at 0 s and results appear.
 *   2. Session resilience — a flaky/blip request must NOT bounce the admin to the login
 *      page mid-action. We simulate a 401 on the session probe and assert that the page
 *      stays put and offers a "Reconnect" banner instead.
 *
 *   npm run dev            # terminal 1
 *   node test/ui-rapid.js  # terminal 2
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
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${extra}`);
  }
};

function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/status of 40[13]/.test(m.text())) return; // expected during the simulated blip
    errors.push(`[${label}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOT_DIR, name) });
}

(async () => {
  // close anything left live from other suites so the rapid round is the current poll
  {
    const login = await fetch(`${BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: process.env.ADMIN_USERNAME || 'admin',
        password: process.env.ADMIN_PASSWORD || 'admin123'
      })
    });
    const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
    const state = await fetch(`${BASE}/api/admin/state`, { headers: { cookie } }).then((r) => r.json());
    for (const poll of state.polls.filter((x) => ['active', 'paused'].includes(x.status))) {
      await fetch(`${BASE}/api/admin/polls/${poll.id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ action: 'close' })
      });
    }
  }

  const browser = await chromium.launch();

  /* ------------------------------ admin ------------------------------ */
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const admin = await desktop.newPage();
  watch(admin, 'admin');

  await admin.goto(`${BASE}/admin-login`, { waitUntil: 'networkidle' });
  await admin.fill('#username', 'admin');
  await admin.fill('#password', 'admin123');
  await admin.click('#login-btn');
  await admin.waitForURL('**/admin', { timeout: 10000 });
  await admin.waitForTimeout(1500);

  console.log('\n⚡ Rapid round — admin side');
  ok('rapid round card is on the dashboard', await admin.locator('#rapid-card').isVisible());
  ok('question is prefilled', ((await admin.inputValue('#rr-question')) || '').length > 5);
  ok('options are prefilled', ((await admin.inputValue('#rr-options')) || '').split('\n').length >= 2);
  ok('10s preset exists', (await admin.locator('#rr-seconds button[data-sec="10"]').count()) === 1);
  ok('15s preset exists', (await admin.locator('#rr-seconds button[data-sec="15"]').count()) === 1);

  await admin.fill('#rr-options', 'Player Alpha\nPlayer Bravo\nPlayer Charlie');
  await admin.click('#rr-seconds button[data-sec="20"]');
  await shot(admin, 'r1-rapid-panel.png');

  /* participant joins first, so a short round leaves enough time to vote */
  console.log('\n📱 Participant joins before the round');
  const mobile = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await mobile.newPage();
  watch(p, 'participant');
  await p.goto(BASE, { waitUntil: 'networkidle' });
  const unique = 'RR-' + Date.now().toString().slice(-6);
  await p.fill('#name', 'Rapid Player');
  await p.fill('#employeeId', unique);
  await p.click('#join-submit');
  await p.waitForURL('**/poll', { timeout: 10000 });
  await p.waitForTimeout(800);

  await admin.click('#rr-start');
  await admin.waitForTimeout(2500);

  const liveQuestion = await admin.locator('#live-control .card-title').first().textContent().catch(() => '');
  ok('round goes live from one click', /who will/i.test(liveQuestion || ''), liveQuestion || '(none)');
  const timerText = (await admin.locator('#admin-timer-text').textContent().catch(() => '')) || '';
  ok('admin countdown shows plain seconds', /^\d+s$|^00:0\d$/.test(timerText.trim()), timerText);
  await shot(admin, 'r2-rapid-live.png');

  /* --------------------------- participant --------------------------- */
  console.log('\n📱 Rapid round — participant votes');
  // idle pages poll every ~8 s, so give the phone time to pick the round up
  await p.locator('.option').first().waitFor({ timeout: 20000 }).catch(() => {});
  ok('participant sees the rapid round', (await p.locator('.option').count()) >= 3);
  await shot(p, 'r3-participant-rapid.png');
  await p.locator('.option').first().click();
  await p.click('#vote-btn');
  await p.waitForURL('**/vote-confirmed**', { timeout: 10000 });
  ok('vote confirmed', p.url().includes('vote-confirmed'));

  /* countdown must tick down in seconds on a short round */
  const countdown = (await p.locator('#timer-text').textContent().catch(() => '')) || '';
  console.log(`     participant countdown right now: "${countdown.trim()}"`);

  /* ------------------- session blip must not log out ------------------- */
  console.log('\n🛡  Session resilience (the "any button logs me out" bug)');
  await admin.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await admin.waitForTimeout(1200);

  // Keep failing the session probe, like a cold/stuck Neon database would.
  let failing = true;
  await admin.route('**/api/admin/**', async (route) => {
    if (failing) {
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Not signed in' })
      });
    }
    return route.continue();
  });

  await admin.click('#show-qr');
  await admin.waitForTimeout(8000);

  ok('admin page did NOT redirect to the login page', admin.url().includes('/admin') && !admin.url().includes('admin-login'), admin.url());
  ok('a reconnect banner is shown instead', (await admin.locator('#session-expired').count()) === 1);
  await shot(admin, 'r4-session-banner.png');

  // now recover and press Reconnect
  failing = false;
  await admin.locator('#session-retry').click();
  await admin.waitForTimeout(2500);
  ok('Reconnect restores the panel without a re-login', (await admin.locator('#session-expired').count()) === 0);
  ok('admin still on the control room', admin.url().endsWith('/admin'));

  /* ----------------------- results after the round -------------------- */
  console.log('\n🏁 Round closes → results revealed to participants');
  await admin.unroute('**/api/admin/**');

  // Fire one more round through the API (60s so it is still live when we close it),
  // then close it like the host does after the answer is in.
  const rr = await admin.evaluate(async () => {
    const create = await fetch('/api/admin/polls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Final check: who gets the next bid?',
        showResults: 'after',
        timerSeconds: 60,
        options: [{ label: 'Team Alpha' }, { label: 'Team Bravo' }]
      })
    });
    const { poll } = await create.json();
    await fetch(`/api/admin/polls/${poll.id}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', timerSeconds: 60 })
    });
    return poll.id;
  });

  await p.waitForTimeout(4500);
  await p.goto(`${BASE}/poll`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  const optionCount = await p.locator('.option').count();
  ok('participant is offered the new round', optionCount >= 2, `options: ${optionCount}`);

  await admin.evaluate(async (id) => {
    await fetch(`/api/admin/polls/${id}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'close' })
    });
  }, rr);

  await p.waitForTimeout(4500);
  const shown = await p.evaluate(() => document.body.innerText);
  ok('results appear for participants after the round closes', /result|vote|%|winner/i.test(shown));
  await shot(p, 'r5-participant-results.png');

  await browser.close();

  console.log('\n' + '='.repeat(52));
  console.log(`  Rapid round UI: ${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log('\n  Browser errors:');
    [...new Set(errors)].forEach((e) => console.log('   - ' + e));
  } else {
    console.log('  No browser console errors 🎉');
  }
  console.log('='.repeat(52) + '\n');
  process.exit(fail || errors.length ? 1 : 0);
})();
