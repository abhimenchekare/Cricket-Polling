'use strict';

/**
 * ⚡ Guess submit speed — "I pressed Lock in, why is it thinking?"
 *
 * The tap has to feel instant even when the serverless function is cold. This measures:
 *
 *   1. tap → POST /api/vote answered
 *   2. tap → "Guess locked in!" painted on screen
 *
 * and repeats the measurement with every /api/meta and /api/state call artificially delayed
 * by 800 ms (a cold Vercel function + Neon wake-up). The confirmation must still paint from the
 * locally cached result instead of waiting for those calls.
 *
 *   npm run dev
 *   node test/vote-speed.js
 */

const { chromium, devices } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

let pass = 0;
let fail = 0;
const errors = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
};

const STAMP = Date.now().toString().slice(-5);

(async () => {
  console.log(`\n⚡ Guess submit speed → ${BASE}\n${'='.repeat(58)}`);

  const login = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS })
  }).then((r) => r.json());
  const H = { 'Content-Type': 'application/json', 'x-admin-token': login.token };
  const api = (p, o = {}) =>
    fetch(BASE + p, { ...o, headers: { ...H, ...(o.headers || {}) } }).then(async (r) => ({
      status: r.status,
      data: await r.json().catch(() => null)
    }));

  const closeLive = async () => {
    for (const p of (await api('/api/admin/state')).data.polls) {
      if (['active', 'paused'].includes(p.status)) {
        await api(`/api/admin/polls/${p.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'close' }) });
      }
    }
  };
  await closeLive();

  // make sure a player exists to shout
  const roster = (await api('/api/admin/players')).data;
  if (!roster.counts.queued) {
    await api('/api/admin/players', { method: 'POST', body: JSON.stringify({ names: `Speed Player ${STAMP}, Batter, 2 Cr` }) });
  }

  const browser = await chromium.launch();

  /* ------------------------- one measured submission ------------------------- */
  async function measure({ delayMs = 0, employeeId, label }) {
    await closeLive();
    // each round eats one queued player — make sure there is always one to shout
    const queue = (await api('/api/admin/players')).data;
    if (!queue.counts.queued) {
      await api('/api/admin/players', {
        method: 'POST',
        body: JSON.stringify({ names: `Speed Player ${STAMP}-${label}, Batter, 2 Cr` })
      });
    }
    const shouted = await api('/api/admin/shout', { method: 'POST', body: JSON.stringify({ timerSeconds: 120 }) });
    if (shouted.status !== 201) throw new Error('shout failed: ' + JSON.stringify(shouted.data));
    const pollId = shouted.data.poll.id;

    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));

    if (delayMs) {
      // every background API call behaves like a cold serverless function
      await page.route('**/api/meta*', async (route) => {
        await new Promise((r) => setTimeout(r, delayMs));
        route.continue();
      });
      await page.route('**/api/state*', async (route) => {
        await new Promise((r) => setTimeout(r, delayMs));
        route.continue();
      });
    }

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.fill('#name', `Speed ${label || employeeId} ${STAMP}`);
    await page.click('#join-submit');
    await page.waitForTimeout(600);

    await page.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#bid-range', { timeout: 15000 });
    await page.waitForTimeout(400);

    await page.locator('#bid-range').first().fill('40');
    await page.waitForTimeout(120);

    const t0 = Date.now();
    const voteResponse = page.waitForResponse((r) => r.url().includes('/api/vote'), { timeout: 15000 });
    await page.click('#vote-btn');
    const res = await voteResponse;
    const apiMs = Date.now() - t0;

    await page.waitForSelector('text=Guess locked in', { timeout: 15000 });
    const paintMs = Date.now() - t0;

    const shown = (await page.locator('#choice').innerText().catch(() => '')).trim();
    await ctx.close();
    return { apiMs, paintMs, status: res.status(), shown, pollId };
  }

  console.log('\n📶 Warm server');
  const warm = await measure({ employeeId: `SPD-W-${STAMP}`, label: 'warm' });
  ok('the guess is accepted', warm.status === 200, `HTTP ${warm.status}`);
  ok('the submit is answered in under 400 ms', warm.apiMs < 400, `${warm.apiMs} ms`);
  ok('"Guess locked in" is on screen in under 900 ms', warm.paintMs < 900, `${warm.paintMs} ms`);
  ok('the locked price is shown', /L|Cr/.test(warm.shown), warm.shown.split('\n').slice(0, 3).join(' ').slice(0, 60));

  console.log('\n🧊 Cold function (every /api call delayed 800 ms)');
  const cold = await measure({ delayMs: 800, employeeId: `SPD-C-${STAMP}`, label: 'cold' });
  ok('the guess is still accepted', cold.status === 200, `HTTP ${cold.status}`);
  ok(
    'the screen does not wait for the slow API calls',
    cold.paintMs < 1500,
    `${cold.paintMs} ms (would be 2×800 ms if it waited)`
  );
  ok('the locked price is still correct', /L|Cr/.test(cold.shown), cold.shown.split('\n').slice(0, 3).join(' ').slice(0, 60));

  console.log('\n📊 Result');
  console.log(`   warm: ${warm.apiMs} ms to answer · ${warm.paintMs} ms to paint`);
  console.log(`   cold: ${cold.apiMs} ms to answer · ${cold.paintMs} ms to paint`);

  await browser.close();

  /* cleanup */
  await closeLive();
  await api('/api/admin/shout/undo', { method: 'POST', body: JSON.stringify({ confirm: true }) }).catch(() => {});
  for (const p of (await api('/api/admin/state')).data.polls) {
    if (/Speed Player/.test(p.playerName || '')) await api(`/api/admin/polls/${p.id}`, { method: 'DELETE' });
  }
  for (const p of (await api('/api/admin/participants')).data.participants) {
    if (String(p.employeeId).startsWith('SPD-')) await api(`/api/admin/participants/${p.id}`, { method: 'DELETE' });
  }
  for (const p of (await api('/api/admin/players')).data.players) {
    if (/Speed Player/.test(p.name)) await api(`/api/admin/players/${p.id}`, { method: 'DELETE' });
  }

  console.log('\n' + '='.repeat(58));
  console.log(`  Guess submit speed: ${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log('\n  Browser errors:');
    [...new Set(errors)].forEach((e) => console.log('   - ' + e));
  } else {
    console.log('  No browser errors 🎉');
  }
  console.log('='.repeat(58) + '\n');
  process.exit(fail || errors.length ? 1 : 0);
})();
