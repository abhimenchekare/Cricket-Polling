'use strict';

/**
 * ⚡ Round-trips — how long SHOUT and Lock in take when the database is a network away.
 *
 *   The venue uses Vercel + Neon, so every SQL statement is a ~40 ms round trip. The button
 *   therefore feels as fast as the NUMBER of statements behind it, not the speed of any one of
 *   them. This suite runs the server with DB_FAKE_LATENCY_MS set, and holds two promises:
 *
 *     1. the player's name reaches the phones within 2 s of the host pressing SHOUT
 *     2. Lock in is confirmed within 1.5 s
 *
 *   It also proves the projector board does not repaint on every heartbeat (the "winners blink"
 *   bug): a winner card must survive incoming votes untouched.
 *
 *   npm run dev        (DB_FAKE_LATENCY_MS=40 npm run dev)
 *   node test/latency.js
 */

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const DB_LATENCY = Number(process.env.DB_FAKE_LATENCY_MS || 40);

/* Budgets. With a 40 ms round trip per statement these leave room for a cold serverless start
   without hiding a regression. */
const SHOUT_TO_PHONE_MS = 2000;
const VOTE_TO_CONFIRM_MS = 1500;

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
  console.log(`\n⚡ Round trips (fake ${DB_LATENCY} ms / query) → ${BASE}\n${'='.repeat(58)}`);

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

  const timed = async (label, fn) => {
    const t = Date.now();
    const out = await fn();
    return { ms: Date.now() - t, out };
  };

  /* ---------------- clean slate ---------------- */
  for (const p of (await api('/api/admin/state')).data.polls) {
    if (['active', 'paused'].includes(p.status)) {
      await api(`/api/admin/polls/${p.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'close' }) });
    }
  }
  const players = [`Fast A ${STAMP}`, `Fast B ${STAMP}`, `Fast C ${STAMP}`];
  await api('/api/admin/players', { method: 'POST', body: JSON.stringify({ names: players.join('\n') }) });
  const roster = (await api('/api/admin/players')).data.players;
  const ours = roster.filter((p) => p.name.includes(STAMP)).map((p) => p.id);
  await api('/api/admin/players/reorder', {
    method: 'POST',
    body: JSON.stringify({ ids: [...ours, ...roster.filter((p) => !p.name.includes(STAMP)).map((p) => p.id)] })
  });

  const browser = await chromium.launch();

  /* ---------------- phones ---------------- */
  console.log('\n1️⃣  Two phones on the audience screen');
  const joinPhone = async (name) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 664 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.fill('#name', name); // v4.1.0 — name only, no employee ID
    await page.click('#join-submit');
    await page.waitForURL('**/poll', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(700);
    return page;
  };

  const phoneA = await joinPhone(`Fast One ${STAMP}`);
  const phoneB = await joinPhone(`Fast Two ${STAMP}`);
  ok('a phone joins with a name and nothing else', phoneA.url().endsWith('/poll'), phoneA.url().split('/').pop());

  /* ---------------- SHOUT → phone ---------------- */
  console.log('\n2️⃣  SHOUT must reach a phone in under 2 s');
  await phoneA.waitForTimeout(1200);
  const shouts = [];
  for (const expected of players) {
    const t0 = Date.now();
    const res = await api('/api/admin/shout', {
      method: 'POST',
      body: JSON.stringify({ timerSeconds: 300, allowUnpriced: true, force: true })
    });
    const postMs = Date.now() - t0;
    ok(`SHOUT ${expected} accepted`, res.status === 201, `POST ${postMs} ms`);

    await phoneA
      .waitForFunction((n) => document.body.innerText.includes(n), expected, { timeout: 15000, polling: 10 })
      .catch(() => {});
    const visibleMs = Date.now() - t0;
    shouts.push({ postMs, visibleMs });
    ok(`the name reached the phone inside ${SHOUT_TO_PHONE_MS} ms`, visibleMs < SHOUT_TO_PHONE_MS, `${visibleMs} ms`);

    /* a vote from the other phone keeps the room honest */
    await phoneB.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
    await phoneB.waitForSelector('#bid-range', { timeout: 15000 });
    await phoneB.evaluate(() => {
      const r = document.querySelector('#bid-range');
      r.value = '20';
      r.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await phoneB.waitForTimeout(120);
    await phoneB.click('#vote-btn');
    await phoneB.waitForURL('**/vote-confirmed**', { timeout: 15000 }).catch(() => {});
  }

  console.log('     ' + shouts.map((s) => `POST ${s.postMs} ms / phone ${s.visibleMs} ms`).join(' · '));
  const avgVisible = Math.round(shouts.reduce((n, s) => n + s.visibleMs, 0) / shouts.length);
  ok('the average SHOUT → phone time is under 2 s', avgVisible < SHOUT_TO_PHONE_MS, `${avgVisible} ms`);
  const avgPost = Math.round(shouts.reduce((n, s) => n + s.postMs, 0) / shouts.length);
  ok('the SHOUT write itself answers in under 1 s', avgPost < 1000, `${avgPost} ms per shout`);

  /* ---------------- Lock in ---------------- */
  console.log('\n3️⃣  Lock in must be confirmed in under 1.5 s');
  const voteTimes = [];
  for (let i = 0; i < 3; i++) {
    await phoneA.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
    await phoneA.waitForSelector('#bid-range', { timeout: 15000 });
    const active = (await api('/api/admin/state')).data;
    const live = active.polls.find((p) => p.status === 'active');
    if (!live) break;
    await phoneA.evaluate(() => {
      const r = document.querySelector('#bid-range');
      r.value = '24';
      r.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const t0 = Date.now();
    await phoneA.click('#vote-btn');
    await phoneA.waitForURL('**/vote-confirmed**', { timeout: 15000 }).catch(() => {});
    voteTimes.push(Date.now() - t0);
    break; // one round is enough — the phone cannot guess the same player twice
  }
  if (voteTimes.length) {
    ok('Lock in is confirmed fast', voteTimes[0] < VOTE_TO_CONFIRM_MS, `${voteTimes[0]} ms`);
  } else {
    console.log('  ℹ️  no live round to guess — skipped');
  }

  /* ---------------- the projector must not blink ---------------- */
  console.log('\n4️⃣  The winners board holds still while the room votes');
  const price = await api(`/api/admin/polls/${(await api('/api/admin/state')).data.polls.find((p) => p.status === 'active').id}/actual`, {
    method: 'POST',
    body: JSON.stringify({ price: '2 Cr' })
  });
  ok('a sold price lands so the board has something to show', price.status === 200, `status ${price.status}`);

  const dp = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  dp.on('pageerror', (e) => errors.push(`[display] ${e.message}`));
  await dp.goto(`${BASE}/display`, { waitUntil: 'domcontentloaded' });
  await dp.waitForSelector('.dp-winner', { timeout: 20000 }).catch(() => {});
  await dp.waitForTimeout(3500);

  const medal = await dp.evaluate(() => {
    const el = document.querySelector('.dp-winner.rank-1 .dp-medal');
    return el
      ? { present: true, animation: getComputedStyle(el).animationName, num: (el.textContent || '').trim() }
      : { present: false };
  });
  ok('the winner card carries a medal', medal.present, JSON.stringify(medal));
  ok('the medal is gold/silver/bronze artwork, not an emoji', medal.present && /dpMedalDrop/.test(medal.animation), medal.animation);

  /* hold a reference to the card, then make the room noisy: joins + votes + heartbeats */
  const watched = await dp.evaluateHandle(() => document.querySelector('.dp-winner.rank-1'));
  for (let i = 0; i < 3; i++) {
    await fetch(`${BASE}/api/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Noise ${i} ${STAMP}-${Date.now() % 1000}` })
    }).catch(() => {});
  }
  await dp.waitForTimeout(6000);
  const stillThere = await dp.evaluate((el) => document.contains(el), watched);
  ok('incoming traffic does not rebuild the winner card (no blinking)', stillThere === true, stillThere ? 'card untouched' : 'card was replaced');

  const stableShots = await dp.evaluate(async () => {
    /* sample the card's animation state over 3 s — a repaint would restart these */
    const el = document.querySelector('.dp-winner.rank-1');
    const first = getComputedStyle(el).animationName + '|' + getComputedStyle(el).animationPlayState;
    await new Promise((r) => setTimeout(r, 3000));
    const el2 = document.querySelector('.dp-winner.rank-1');
    return { same: document.contains(el) && el === el2, first };
  });
  ok('the card is not being re-animated in a loop', stableShots.same, stableShots.first);

  console.log(`\n${'='.repeat(58)}`);
  if (errors.length) {
    console.log(`⚠️  page errors: ${errors.length}`);
    errors.slice(0, 5).forEach((e) => console.log('   ' + e));
    fail += errors.length;
  }
  console.log(`RESULT: ${pass} passed, ${fail} failed\n`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
