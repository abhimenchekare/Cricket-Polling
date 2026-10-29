'use strict';

/**
 * ⚡ Round length — the "Shout settings" card.
 *
 * The host runs 10–15 second rounds, so fine timer increments have to be one tap away,
 * remembered between sessions, and actually used by the next SHOUT.
 *
 *   npm run dev
 *   node test/ui-rapid.js
 *   BASE_URL=https://your-app.vercel.app node test/ui-rapid.js
 */

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

let pass = 0;
let fail = 0;
const errors = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
};
const watch = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`[${tag}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 40[13]/.test(m.text())) errors.push(`[${tag}] ${m.text()}`);
  });
};

(async () => {
  console.log(`\n⚡ Round length → ${BASE}\n${'='.repeat(54)}`);

  const login = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS })
  });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  const api = (p, o = {}) =>
    fetch(BASE + p, {
      ...o,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(o.headers || {}) }
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

  // close anything live so the shout button is free
  for (const poll of (await api('/api/admin/state')).data.polls) {
    if (['active', 'paused'].includes(poll.status)) {
      await api(`/api/admin/polls/${poll.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'close' }) });
    }
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const admin = await ctx.newPage();
  watch(admin, 'admin');

  await admin.goto(`${BASE}/admin-login`, { waitUntil: 'networkidle' });
  await admin.fill('#username', ADMIN_USER);
  await admin.fill('#password', ADMIN_PASS);
  await admin.click('#login-btn');
  await admin.waitForURL('**/admin', { timeout: 12000 });
  await admin.waitForTimeout(1800);

  console.log('\n🎛  The card');
  ok('the shout settings card is on the dashboard', await admin.locator('#rapid-card').isVisible());
  ok('it explains that names come from the auction list', /never type/i.test(await admin.locator('#rapid-card').innerText()));
  ok('there is no player-name box to type into', (await admin.locator('#rr-player, #f-player').count()) === 0);
  ok('there is no options textarea', (await admin.locator('#rr-options, #type-seg').count()) === 0);

  console.log('\n⏱  Fine increments');
  for (const sec of [10, 15, 20, 30, 45, 60, 90, 120]) {
    ok(`${sec}s is one tap away`, (await admin.locator(`#rr-seconds button[data-sec="${sec}"]`).count()) === 1);
  }

  await admin.click('#rr-seconds button[data-sec="15"]');
  await admin.waitForTimeout(600);
  ok('picking 15s highlights it', /active/.test((await admin.locator('#rr-seconds button[data-sec="15"]').getAttribute('class')) || ''));
  ok('the choice is remembered', (await admin.evaluate(() => localStorage.getItem('shout_seconds'))) === '15');

  console.log('\n🔁  It survives a reload');
  await admin.reload({ waitUntil: 'networkidle' });
  await admin.waitForTimeout(1800);
  ok(
    '15s is still selected after a refresh',
    /active/.test((await admin.locator('#rr-seconds button[data-sec="15"]').getAttribute('class')) || '')
  );

  console.log('\n📣  And the next SHOUT uses it');
  const shouted = await api('/api/admin/shout', { method: 'POST', body: JSON.stringify({ timerSeconds: 15 }) });
  ok('a shout opens a round', shouted.status === 201, JSON.stringify(shouted.data && shouted.data.error));
  ok('with the 15 second countdown', shouted.data.poll.timerSeconds === 15, String(shouted.data.poll && shouted.data.poll.timerSeconds));

  await api(`/api/admin/polls/${shouted.data.poll.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'close' }) });
  await admin.waitForTimeout(400);
  if (shouted.data.shouted) await api('/api/admin/shout/undo', { method: 'POST', body: JSON.stringify({ confirm: true }) });

  console.log('\n🔒  Defaults');
  ok('10s is the default when nothing is stored', (await api('/api/admin/shout', {
    method: 'POST',
    body: JSON.stringify({})
  })).data.poll.timerSeconds === 10);
  const liveNow = (await api('/api/admin/state')).data.polls.find((p) => p.status === 'active');
  if (liveNow) await api(`/api/admin/polls/${liveNow.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'close' }) });
  await api('/api/admin/shout/undo', { method: 'POST', body: JSON.stringify({ confirm: true }) }).catch(() => {});

  await browser.close();

  console.log('\n' + '='.repeat(54));
  console.log(`  Round length: ${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log('\n  Browser errors:');
    [...new Set(errors)].forEach((e) => console.log('   - ' + e));
  } else {
    console.log('  No browser errors 🎉');
  }
  console.log('='.repeat(54) + '\n');
  process.exit(fail || errors.length ? 1 : 0);
})();
