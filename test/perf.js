'use strict';

/**
 * Speed test — how long the app takes to become usable.
 *
 *   node test/perf.js                                    # local dev (port 4000)
 *   BASE_URL=https://your-app.vercel.app node test/perf.js   # the live site
 *
 * It measures the two things people actually feel:
 *   1. /api/state latency  (this is the endpoint every screen waits for)
 *   2. time until the poll question / dashboard is on screen
 *
 * Thresholds come from STATE_BUDGET (ms, default 2500) and PAGE_BUDGET (ms, default 5000).
 * A hosted Postgres adds ~200 ms per round-trip, so the API is expected to be slower than
 * localhost — but never slower than STATE_BUDGET.
 */

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const STATE_BUDGET = Number(process.env.STATE_BUDGET || 2500);
const PAGE_BUDGET = Number(process.env.PAGE_BUDGET || 5000);

let pass = 0;
let fail = 0;

function ok(label, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  ✅ ${label}${detail ? '  — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${detail ? '  — ' + detail : ''}`);
  }
}

function pct(list, p) {
  const sorted = [...list].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[i]);
}

(async () => {
  console.log(`\n⚡ Speed check → ${BASE}`);
  console.log('='.repeat(58));

  /* ---------------- 1. the endpoint every screen waits for ---------------- */
  const stateTimes = [];
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/state`);
    await res.json();
    stateTimes.push(Date.now() - t0);
  }
  const p50 = pct(stateTimes, 50);
  const p95 = pct(stateTimes, 95);
  console.log(`\n  /api/state  p50 ${p50} ms · p95 ${p95} ms  (samples: ${stateTimes.join(', ')})`);
  ok(`/api/state under ${STATE_BUDGET} ms (p95)`, p95 < STATE_BUDGET, `${p95} ms`);

  /* ---------------- 2. what the user actually sees ---------------- */
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  const apiCalls = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/')) apiCalls.push(r.url().replace(BASE, ''));
  });

  // participant join → live poll screen
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.fill('#name', `Perf ${Date.now() % 10000}`);
  await page.click('#join-submit');
  await page.waitForTimeout(1200);

  apiCalls.length = 0;
  const tPoll = Date.now();
  // the poll page redirects to the join screen when the session cookie is refused, so a
  // navigation abort is expected there — don't let it kill the measurement
  await page.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page
    // whatever the participant actually sees: a live round, or the "waiting for the host" card
    .waitForSelector('#poll-area > *, #poll-question, .poll-question, #no-poll, .empty-state', {
      timeout: PAGE_BUDGET * 3
    })
    .catch(() => {});
  const pollShown = Date.now() - tPoll;
  ok(`poll screen usable under ${PAGE_BUDGET} ms`, pollShown < PAGE_BUDGET, `${pollShown} ms`);

  // admin dashboard
  const admin = await context.newPage();
  await admin.goto(`${BASE}/admin-login`, { waitUntil: 'domcontentloaded' });
  await admin.fill('#username', process.env.ADMIN_USER || 'admin');
  await admin.fill('#password', process.env.ADMIN_PASS || 'admin123');
  const tLogin = Date.now();
  await admin.click('#login-btn').catch(() => {});
  await admin.waitForSelector('#stat-participants, .stat-card, .kpi', { timeout: PAGE_BUDGET * 3 }).catch(() => {});
  const dashboardShown = Date.now() - tLogin;
  ok(`admin dashboard usable under ${PAGE_BUDGET} ms`, dashboardShown < PAGE_BUDGET, `${dashboardShown} ms`);

  /* ---------------- 3. reopening the phone with a hostile network ---------------- */
  /* The phone keeps the last state it saw. On a re-open the round must be on screen from that
     snapshot in one frame, even if every API call takes 1.5 s. This is the "why is the name
     missing for two seconds" complaint, measured. */
  const slow = await context.newPage();
  await slow.route('**/api/**', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const tSnap = Date.now();
  await slow.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  /* the phone marks itself the moment it has painted the remembered state */
  const painted = await slow
    .waitForSelector('body.from-snapshot', { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  const snapMs = Date.now() - tSnap;
  /* only meaningful when the phone had a snapshot to paint (it does, it just used the page) */
  ok('re-opening the phone paints from its snapshot before the network answers', painted && snapMs < 1200, `${snapMs} ms`);
  await slow.close();

  console.log(`\n  API calls made by the poll screen: ${apiCalls.length ? apiCalls.join(', ') : 'none'}`);

  await browser.close();

  console.log('\n' + '='.repeat(58));
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\n  Slow means the server is making one query per poll/option instead of');
    console.log('  batching them (see VISIBLE_IDS / bulkSql in server/state.js), or the');
    console.log('  deployment is cold. Compare against localhost to tell which.');
  }
  console.log('='.repeat(58) + '\n');
  process.exit(fail ? 1 : 0);
})();
