'use strict';

/**
 * 🎚️ Slider memory — nobody else's vote may move a slider you are holding.
 *
 *   Round 12 bug reports, both reproduced here before the fix:
 *     "when 1 audience person submit his bid then others person bid get reset / back to +10"
 *     "in admin when audience bid that admin bar also get reset"
 *
 *   The fix has three layers, and this suite checks the ones a browser can see:
 *     1. the phone rebuilds the guess card only when the round itself changes
 *        (another person's vote just patches the guess counter)
 *     2. the phone remembers the ladder index it was left on, per round
 *     3. the admin panel remembers the sold-price index per round, in both places
 *        (the shout/settle block and the live control panel)
 *
 *   npm run dev
 *   node test/slider-memory.js
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
    console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
};

const STAMP = Date.now().toString().slice(-5);

(async () => {
  console.log(`\n🎚️  Slider memory → ${BASE}\n${'='.repeat(58)}`);

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

  /* ---------- a clean round of our own ---------- */
  for (const p of (await api('/api/admin/state')).data.polls) {
    if (['active', 'paused'].includes(p.status)) {
      await api(`/api/admin/polls/${p.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'close' }) });
    }
  }
  await api('/api/admin/players', {
    method: 'POST',
    body: JSON.stringify({ names: `Slider Probe ${STAMP}, Batter, 2 Cr` })
  });
  const roster = (await api('/api/admin/players')).data.players;
  const mine = roster.filter((p) => p.name === `Slider Probe ${STAMP}`).map((p) => p.id);
  await api('/api/admin/players/reorder', {
    method: 'POST',
    body: JSON.stringify({ ids: [...mine, ...roster.filter((p) => !mine.includes(p.id)).map((p) => p.id)] })
  });
  const shout = await api('/api/admin/shout', {
    method: 'POST',
    body: JSON.stringify({ timerSeconds: 600, allowUnpriced: true })
  });
  ok('a round is live for the test', shout.status === 201 || shout.status === 200, `status ${shout.status}`);

  const browser = await chromium.launch();

  const joinPhone = async (name, employeeId) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 664 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.fill('#name', name);
    await page.fill('#employeeId', employeeId);
    await page.click('#join-submit');
    await page.waitForTimeout(500);
    await page.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#bid-range', { timeout: 15000 });
    await page.waitForTimeout(2600); // let the shout splash finish
    return page;
  };
  const dial = (page, value) =>
    page.evaluate((v) => {
      const r = document.querySelector('#bid-range');
      r.value = String(v);
      r.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  const readIndex = (page, sel = '#bid-range') =>
    page.evaluate((s) => {
      const r = document.querySelector(s);
      return r ? Number(r.value) : null;
    }, sel);

  /* ---------------------- 1️⃣  the audience phone ---------------------- */
  console.log('\n1️⃣  Another participant votes while you are still guessing');

  const alice = await joinPhone('Slider Alice', `SL-A-${STAMP}`);
  await dial(alice, 24);
  await alice.waitForTimeout(250);
  const aliceBefore = await readIndex(alice);
  const aliceLabel = await alice.textContent('.bid-value');
  ok('Alice is holding a position away from the default', aliceBefore === 24, `index ${aliceBefore} · ${aliceLabel}`);

  const bob = await joinPhone('Slider Bob', `SL-B-${STAMP}`);
  await dial(bob, 8);
  await bob.click('#vote-btn');
  await bob.waitForTimeout(3000);

  const aliceAfter = await readIndex(alice);
  const aliceLabelAfter = await alice.textContent('.bid-value');
  ok(
    "Bob's vote does not move Alice's slider",
    aliceAfter === aliceBefore,
    `${aliceBefore} → ${aliceAfter} (${aliceLabelAfter})`
  );
  ok('Alice still sees her own price on the button', aliceLabelAfter.trim() === aliceLabel.trim(), aliceLabelAfter.trim());

  const countText = await alice.textContent('#vote-count-num').catch(() => '');
  ok('the guess counter did still go up in place', countText.trim().length > 0, `counter "${countText.trim()}"`);

  /* Two more votes in quick succession — the old bug showed up on the second push. */
  for (const [n, v] of [['Slider Carol', 30], ['Slider Dev', 12]]) {
    const p = await joinPhone(n, `SL-${n.slice(-1)}-${STAMP}`);
    await dial(p, v);
    await p.click('#vote-btn');
    await p.waitForTimeout(1200);
  }
  await alice.waitForTimeout(1500);
  const aliceAfterMany = await readIndex(alice);
  ok('it survives a burst of other votes', aliceAfterMany === aliceBefore, `${aliceBefore} → ${aliceAfterMany}`);

  /* Alice reloads and comes back — her position is remembered for this round. */
  await alice.reload({ waitUntil: 'domcontentloaded' });
  await alice.waitForSelector('#bid-range', { timeout: 15000 });
  await alice.waitForTimeout(2600);
  const aliceReloaded = await readIndex(alice);
  ok('her position is remembered after a reload', aliceReloaded === aliceBefore, `${aliceBefore} → ${aliceReloaded}`);

  /* --------------------------- 2️⃣  the admin --------------------------- */
  console.log('\n2️⃣  The host dials the sold price while the room is voting');

  const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await adminCtx.addInitScript((t) => localStorage.setItem('cp_admin_token', t), login.token);
  const admin = await adminCtx.newPage();
  admin.on('pageerror', (e) => errors.push(`[admin] ${e.message}`));
  await admin.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#ss-range', { timeout: 15000 });
  await admin.waitForTimeout(1200);

  /* the panel repaints while it settles — dial once the element is really there */
  const dialWhenReady = async (sel, value) => {
    for (let i = 0; i < 12; i++) {
      const done = await admin.evaluate(([s, v]) => {
        const r = document.querySelector(s);
        if (!r) return false;
        r.value = String(v);
        r.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }, [sel, value]).catch(() => false);
      if (done) return true;
      await admin.waitForTimeout(400);
    }
    return false;
  };
  await dialWhenReady('#ss-range', 26);
  await admin.waitForTimeout(300);
  const settleBefore = await readIndex(admin, '#ss-range');
  ok('the host can dial the sold price before anyone votes', settleBefore === 26, `index ${settleBefore}`);

  const eve = await joinPhone('Slider Eve', `SL-E-${STAMP}`);
  await dial(eve, 20);
  await eve.click('#vote-btn');
  await eve.waitForTimeout(3000);

  const settleAfter = await readIndex(admin, '#ss-range');
  ok(
    "an incoming vote does not reset the host's sold-price slider",
    settleAfter === settleBefore,
    `${settleBefore} → ${settleAfter}`
  );

  /* The live control panel has its own slider — same rule. */
  if (await admin.$('#adm-bid-range')) {
    await dialWhenReady('#adm-bid-range', 31);
    await admin.waitForTimeout(300);
    const liveBefore = await readIndex(admin, '#adm-bid-range');
    const frank = await joinPhone('Slider Frank', `SL-F-${STAMP}`);
    await dial(frank, 6);
    await frank.click('#vote-btn');
    await frank.waitForTimeout(3000);
    const liveAfter = await readIndex(admin, '#adm-bid-range');
    ok(
      'the live-control slider keeps its position too',
      liveAfter === liveBefore,
      `${liveBefore} → ${liveAfter}`
    );
  } else {
    console.log('  ℹ️  live control slider not on screen in this state — skipped');
  }

  /* ------------------------ 3️⃣  no leftover names ------------------------ */
  console.log('\n3️⃣  The finished phone screen keeps quiet');

  await api(`/api/admin/polls/${(await api('/api/admin/state')).data.polls.find((p) => p.status === 'active')?.id}/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'close' })
  }).catch(() => null);
  await alice.waitForTimeout(1800);
  const closedText = await alice.evaluate(() => document.body.innerText);
  ok('no player name on the finished screen', !/Slider Probe/i.test(closedText), closedText.split('\n')[0]);
  ok('no sold price on the finished screen', !/sold for/i.test(closedText));
  ok('no rank line on the finished screen', !/#\d+ of \d+/i.test(closedText));
  ok('the duck is still there', (await alice.$('.duck')) !== null);

  /* ---------------------- 4️⃣  the duck has some action ---------------------- */
  console.log('\n4️⃣  The waiting duck bats, and then gets bowled');

  const parts = await alice.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const anim = (s) => {
      const el = q(s);
      return el ? getComputedStyle(el).animationName : null;
    };
    return {
      bat: anim('.duck-bat'),
      ball: anim('.duck-ball'),
      ballLow: anim('.duck-ball-low'),
      spark: anim('.duck-spark'),
      bails: anim('.duck-bails'),
      stumps: anim('.duck-stumps'),
      stumpsBox: (() => {
        const el = q('.duck-stumps');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      })()
    };
  });
  ok('the bat swings', parts.bat === 'duckBat', parts.bat);
  ok('a ball leaves the bat', parts.ball === 'duckBall', parts.ball);
  ok('contact spark fires on the shot', parts.spark === 'duckSpark', parts.spark);
  ok('a second ball comes in low', parts.ballLow === 'duckBallLow', parts.ballLow);
  ok('the stumps are on screen', parts.stumpsBox && parts.stumpsBox.h > 10, JSON.stringify(parts.stumpsBox));
  ok('the bails fly off', parts.bails === 'duckBails', parts.bails);
  ok('the stumps rock on impact', parts.stumps === 'duckWicket', parts.stumps);

  /* the ball actually moves — sample across a whole loop, not two frames of the same beat */
  const frames = [];
  for (let i = 0; i < 10; i++) {
    frames.push(
      await alice.evaluate(() => {
        const b = document.querySelector('.duck-ball');
        return b ? getComputedStyle(b).transform : 'none';
      })
    );
    await alice.waitForTimeout(450);
  }
  const distinct = new Set(frames).size;
  ok('the ball is in motion (not a still picture)', distinct >= 3, `${distinct} distinct positions over 4.5 s`);

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
