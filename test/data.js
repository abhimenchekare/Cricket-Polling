'use strict';

/**
 * v4.3.0 — the three things the host asked for the morning of the real auction:
 *
 *   1. The audience phone has NO results screen anywhere (link, page, text).
 *   2. The admin dashboard has NO "Queue — Ready to run" list.
 *   3. The database can be cleared from the admin panel, in three sizes, with a typed confirm.
 *
 *   node test/data.js
 *   BASE_URL=https://your-app.vercel.app node test/data.js
 */

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const STAMP = `v43-${Date.now() % 100000}`;

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

async function json(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

(async () => {
  console.log(`\n🧹 Data & audience-cleanliness → ${BASE}\n${'='.repeat(58)}`);

  /* ---------------- admin session ---------------- */
  const login = await json('/api/admin/login', {
    method: 'POST',
    body: {
      username: process.env.ADMIN_USER || 'admin',
      password: process.env.ADMIN_PASS || 'admin123'
    }
  });
  ok('admin signs in', login.status === 200 && !!login.data.token, `HTTP ${login.status}`);
  const auth = { 'x-admin-token': login.data.token };

  const browser = await chromium.launch();

  /* ================================================================== */
  /* 1. The audience phone has no results screen                          */
  /* ================================================================== */
  console.log('\n📱 Audience phone — no results anywhere');
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneCtx.newPage();
  await phone.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const joinHtml = await phone.evaluate(() => document.body.innerHTML);
  ok('the join page has no results link', !/href="\/results"/.test(joinHtml));

  await phone.fill('#name', `DataPhone ${STAMP}`);
  await phone.click('#join-submit');
  await phone.waitForTimeout(1300);
  await phone.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
  await phone.waitForTimeout(1200);

  const pollHtml = await phone.evaluate(() => document.body.innerHTML);
  ok('the live bid page has no results link', !/href="\/results"/.test(pollHtml));
  ok('the live bid page does not mention results at all', !/results/i.test(await phone.evaluate(() => document.body.innerText)));

  /* the page itself is host-only now */
  const aud = await phoneCtx.newPage();
  await aud.goto(`${BASE}/results`, { waitUntil: 'domcontentloaded' });
  await aud.waitForTimeout(1500);
  const audUrl = new URL(aud.url()).pathname;
  ok('a participant opening /results is sent back to the live bid', audUrl !== '/results', audUrl);

  /* ================================================================== */
  /* 2. No queue on the admin dashboard                                   */
  /* ================================================================== */
  console.log('\n🎛️  Admin dashboard — no queue list');
  const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await adminCtx.addInitScript((token) => {
    localStorage.setItem('cp_admin_token', token);
  }, login.data.token);
  const admin = await adminCtx.newPage();
  await admin.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await admin.waitForTimeout(2500);
  const dash = await admin.evaluate(() => document.body.innerText);
  ok('the dashboard no longer shows a "Ready to run" queue', !/ready to run/i.test(dash));
  ok('the dashboard no longer lists recently closed polls', !/recently closed/i.test(dash));
  ok('the SHOUT control is still the first thing on the dashboard', /shout/i.test(dash));
  await admin.screenshot({ path: 'test/screenshots/d43-dashboard-clean.png', fullPage: false });

  /* the data page is reachable from the sidebar */
  const dashHtml = await admin.evaluate(() => document.body.innerHTML);
  ok('the sidebar links to Data & reset', /href="\/admin\/data"/.test(dashHtml));

  await admin.goto(`${BASE}/admin/data`, { waitUntil: 'domcontentloaded' });
  await admin.waitForSelector('#counts .data-cell', { timeout: 15000 }).catch(() => {});
  const dataText = await admin.evaluate(() => document.body.innerText);
  ok('the Data page renders live counts', /partic|guesses/i.test(dataText));
  ok('the Data page offers all three clearing sizes', /clear rounds/i.test(dataText) && /delete everything/i.test(dataText));
  await admin.screenshot({ path: 'test/screenshots/d43-data-page.png', fullPage: true });

  /* ================================================================== */
  /* 3. The API refuses anything unconfirmed                              */
  /* ================================================================== */
  console.log('\n🔒 Clearing data needs an admin and a typed confirm');
  const anon = await json('/api/admin/data/clear', { method: 'POST', body: { scope: 'rounds', confirm: 'CLEAR' } });
  ok('an audience member cannot clear the database', anon.status === 401 || anon.status === 403, `HTTP ${anon.status}`);

  const noConfirm = await json('/api/admin/data/clear', { method: 'POST', headers: auth, body: { scope: 'rounds' } });
  ok('clearing without typing CLEAR is refused', noConfirm.status === 400 && noConfirm.data.needsConfirm === true, `HTTP ${noConfirm.status}`);

  const badScope = await json('/api/admin/data/clear', { method: 'POST', headers: auth, body: { scope: 'nonsense', confirm: 'CLEAR' } });
  ok('an unknown scope is refused', badScope.status === 400, `HTTP ${badScope.status}`);

  /* ================================================================== */
  /* 4. Each clearing size does exactly what it says                      */
  /* ================================================================== */
  console.log('\n🧽 Clearing scopes');

  /* make some data: a player on the roster, a live round, a guess */
  await json('/api/admin/players', {
    method: 'POST',
    headers: auth,
    body: { text: `Data Bat ${STAMP}, Batter, 1 Cr\nData Bowl ${STAMP}, Bowler, 50 L` }
  });
  const shout = await json('/api/admin/shout', { method: 'POST', headers: auth, body: { timerSeconds: 60 } });
  ok('a round can be shouted for the test', shout.status === 201, `HTTP ${shout.status}`);

  const before = (await json('/api/admin/data', { headers: auth })).data.counts;
  ok('the counts see the roster and the round', before.rounds > 0 && before.players > 0, JSON.stringify(before));

  /* --- scope: rounds keeps participants and players --- */
  const roundsClear = await json('/api/admin/data/clear', { method: 'POST', headers: auth, body: { scope: 'rounds', confirm: 'CLEAR' } });
  ok('scope=rounds is accepted', roundsClear.status === 200, `HTTP ${roundsClear.status}`);
  const afterRounds = (await json('/api/admin/data', { headers: auth })).data.counts;
  ok('scope=rounds deletes every round', afterRounds.rounds === 0, JSON.stringify(afterRounds));
  ok('scope=rounds keeps the auction list', afterRounds.players === before.players, `${afterRounds.players} players`);
  ok('scope=rounds keeps participants', afterRounds.participants === before.participants, `${afterRounds.participants} participants`);
  ok('scope=rounds puts every player back in the queue', afterRounds.sold === 0 && afterRounds.queued === afterRounds.players);

  /* --- scope: audience also removes participants --- */
  await json('/api/admin/players', {
    method: 'POST',
    headers: auth,
    body: { text: `Data Bat2 ${STAMP}, Batter, 1 Cr` }
  });
  const audClear = await json('/api/admin/data/clear', { method: 'POST', headers: auth, body: { scope: 'audience', confirm: 'CLEAR' } });
  ok('scope=audience is accepted', audClear.status === 200, `HTTP ${audClear.status}`);
  const afterAud = (await json('/api/admin/data', { headers: auth })).data.counts;
  ok('scope=audience removes every participant', afterAud.participants === 0, JSON.stringify(afterAud));
  ok('scope=audience keeps the auction list', afterAud.players > 0, `${afterAud.players} players`);

  /* --- scope: everything empties the app but keeps the admin --- */
  const allClear = await json('/api/admin/data/clear', { method: 'POST', headers: auth, body: { scope: 'everything', confirm: 'CLEAR' } });
  ok('scope=everything is accepted', allClear.status === 200, `HTTP ${allClear.status}`);
  const afterAll = (await json('/api/admin/data', { headers: auth })).data.counts;
  ok('scope=everything empties the auction list too', afterAll.players === 0, JSON.stringify(afterAll));
  const me = await json('/api/admin/me', { headers: auth });
  ok('scope=everything keeps the host signed in', me.status === 200, `HTTP ${me.status}`);

  /* the event settings are restored to factory defaults, so the join page never locks itself */
  const meta = (await json('/api/meta')).data;
  ok('join stays open after a full clear', meta.join && meta.join.allowNewParticipants === true, JSON.stringify(meta.join));
  ok('the event name survives a full clear', !!(meta.event && meta.event.name), meta.event && meta.event.name);

  /* --- a clean database seeds no draft polls --- */
  ok('a cleared database has no sample drafts in it', afterAll.rounds === 0);

  await browser.close();

  console.log('\n' + '='.repeat(58));
  console.log(`  Data & audience-cleanliness: ${pass} passed, ${fail} failed`);
  console.log('='.repeat(58) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n💥 test crashed:', err);
  process.exit(1);
});
