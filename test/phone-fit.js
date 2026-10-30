'use strict';

/**
 * 📱 One-screen guess card — the phone layout rules the host asked for.
 *
 *   1. no "next player" hint anywhere on the audience phone
 *   2. the whole round (player, countdown, slider, chips, Lock in) fits one screen — no scrolling
 *   3. a long player name still fits without cutting the name or overlapping the countdown
 *   4. it still works on a small 360×640 phone
 *
 *   npm run dev
 *   node test/phone-fit.js
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
const LONG_NAME = `Suryakumar Yadav Longname ${STAMP}`;

(async () => {
  console.log(`\n📱 Phone guess card → ${BASE}\n${'='.repeat(58)}`);

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

  /* put a deliberately long name at the front of the queue */
  await api('/api/admin/players', { method: 'POST', body: JSON.stringify({ names: `${LONG_NAME}, Batter, 2 Cr` }) });
  const roster = (await api('/api/admin/players')).data.players;
  const mine = roster.filter((p) => p.name === LONG_NAME).map((p) => p.id);
  await api('/api/admin/players/reorder', {
    method: 'POST',
    body: JSON.stringify({ ids: [...mine, ...roster.filter((p) => !mine.includes(p.id)).map((p) => p.id)] })
  });

  await api('/api/admin/shout', { method: 'POST', body: JSON.stringify({ timerSeconds: 600 }) });

  const browser = await chromium.launch();

  const measure = async (label, device, employeeId) => {
    const ctx = await browser.newContext({ ...device });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
    await p.goto(BASE, { waitUntil: 'domcontentloaded' });
    await p.fill('#name', `Fit ${label} ${STAMP}`);
    await p.click('#join-submit');
    await p.waitForTimeout(600);
    await p.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#bid-range', { timeout: 15000 });
    await p.waitForTimeout(2600); // let the shout splash finish

    const chrome = await p.evaluate(() => ({
      greet: (document.querySelector('#greet-name') || {}).textContent || '',
      stats: (document.querySelector('#stats-bar') || {}).innerText || '',
      greetVisible: (() => {
        const el = document.querySelector('.greet');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.height > 10 && getComputedStyle(el).display !== 'none';
      })()
    }));

    const m = await p.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
      };
      const nameEl = document.querySelector('.bid-player');
      return {
        vh: window.innerHeight,
        scrollH: document.documentElement.scrollHeight,
        text: document.body.innerText,
        player: box('.bid-player'),
        timer: box('#timer'),
        range: box('#bid-range'),
        chips: box('#bid-chips'),
        button: box('#vote-btn'),
        nameClipped: nameEl ? nameEl.scrollWidth > nameEl.clientWidth + 1 : null,
        nameText: nameEl ? nameEl.innerText : '',
        tagText: (document.querySelector('.bid-player-tag') || {}).innerText || ''
      };
    });

    await p.screenshot({ path: `test/screenshots/fit-${label}.png` });
    await ctx.close();
    return { ...m, chrome };
  };

  /* ------------------------------- iPhone 13 ------------------------------- */
  console.log('\n1️⃣  iPhone 13 (390×664 visible)');
  const ip = await measure('iphone', devices['iPhone 13'], `FIT-A-${STAMP}`);

  ok('the greeting card stays on the live screen', ip.chrome.greetVisible && ip.chrome.greet.startsWith('Hi,'), ip.chrome.greet.trim());
  ok('the participant/guess counters stay', /participants/i.test(ip.chrome.stats) && /guess/i.test(ip.chrome.stats), ip.chrome.stats.replace(/\n/g, ' '));
  ok('the slider is visible without scrolling', ip.range.top >= 0 && ip.range.bottom <= ip.vh, `top ${ip.range.top} / ${ip.vh}`);
  ok('the Lock in button is above the fold', ip.button.bottom <= ip.vh, `bottom ${ip.button.bottom} / ${ip.vh}`);
  ok('the page does not scroll at all', ip.scrollH <= ip.vh + 2, `content ${ip.scrollH}px vs screen ${ip.vh}px`);
  ok('the chip shortcuts fit in the same screen', ip.chips.bottom <= ip.vh);


  console.log('\n2️⃣  Nothing about the next player');
  ok('no "next:" hint on the phone', !/next:/i.test(ip.text));
  ok('no ⏭ next-player pill', !ip.text.includes('⏭'));
  ok('the player on the block is still named', ip.nameText.includes('Suryakumar'), ip.nameText.replace(/\n/g, ' '));

  console.log('\n3️⃣  Long names');
  ok('the full name is shown, not truncated', !ip.nameClipped && /Longname/.test(ip.nameText));
  const verticallySeparated = ip.timer.bottom <= ip.player.top + 1 || ip.timer.top >= ip.player.bottom - 1;
  ok(
    'the countdown is not overlapped by the name',
    verticallySeparated || ip.player.right <= ip.timer.left + 2,
    verticallySeparated ? 'separate rows' : `side by side, ${ip.player.right} < ${ip.timer.left}`
  );
  ok('the PLAYER tag stays on one line', !/\n/.test(ip.tagText.trim()), JSON.stringify(ip.tagText));

  /* ------------------------------- small phone ------------------------------ */
  console.log('\n4️⃣  360×640 phone');
  const small = await measure('se', { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, `FIT-B-${STAMP}`);
  ok('still one screen', small.scrollH <= small.vh + 2, `content ${small.scrollH}px vs screen ${small.vh}px`);
  ok('slider and button still visible', small.range.bottom <= small.vh && small.button.bottom <= small.vh);

  /* --------------------- waiting screen: duck, nothing else ---------------- */
  console.log('\n5️⃣  Waiting screen — a duck with a bat, nothing else');
  await closeLive();
  const waitCtx = await browser.newContext({ ...devices['iPhone 13'] });
  const wait = await waitCtx.newPage();
  wait.on('pageerror', (e) => errors.push(`[waiting] ${e.message}`));
  await wait.goto(BASE, { waitUntil: 'domcontentloaded' });
  await wait.fill('#name', `Duck ${STAMP}`);
  await wait.click('#join-submit');
  await wait.waitForTimeout(700);
  await wait.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
  await wait.waitForSelector('.duck', { timeout: 12000 });
  await wait.waitForTimeout(600);
  const waitText = await wait.locator('#poll-area').innerText();
  ok('the duck mascot is on screen', (await wait.locator('.duck').count()) === 1);
  ok('it holds a bat', (await wait.locator('.duck-bat').count()) === 1);
  ok('the bat is animated', /duckBat/.test(await wait.locator('.duck-bat').evaluate((el) => getComputedStyle(el).animationName)));
  ok(
    'it says what is happening',
    /waiting for the next player|that player is done/i.test(waitText),
    waitText.split('\n')[0]
  );
  ok('no previous-poll archive', !/previous polls|results archive/i.test(await wait.locator('body').innerText()));
  ok('no results or archive cards on the phone', (await wait.locator('#results-area, #history-area').count()) === 0);
  ok('the greeting card is still there', (await wait.locator('.greet #greet-name').count()) === 1);
  ok('the participant counter is still there', /participants/i.test(await wait.locator('#stats-bar').innerText()));
  ok('the waiting screen fits one screen', (await wait.evaluate(() => document.documentElement.scrollHeight)) <= (await wait.evaluate(() => window.innerHeight)) + 2);
  await wait.screenshot({ path: 'test/screenshots/fit-duck.png' });

  /* ------------------------------ still usable ------------------------------ */
  console.log('\n6️⃣  It still submits');
  await api('/api/admin/players', {
    method: 'POST',
    body: JSON.stringify({ names: `Fit Submit Player ${STAMP}, Batter, 1 Cr` })
  }).catch(() => {});
  const reshout = await api('/api/admin/shout', { method: 'POST', body: JSON.stringify({ timerSeconds: 300 }) });
  ok('a fresh round is open for the submit check', reshout.status === 201, JSON.stringify(reshout.data && reshout.data.error));
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`[submit] ${e.message}`));
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p.fill('#name', `Fit Submit ${STAMP}`);
  await p.click('#join-submit');
  await p.waitForTimeout(600);
  await p.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#bid-range', { timeout: 15000 });
  await p.waitForTimeout(2400);
  await p.locator('#bid-range').fill('20');
  await p.waitForTimeout(150);
  await p.click('#vote-btn');
  await p.waitForSelector('text=Guess locked in', { timeout: 15000 });
  ok('a guess from the one-screen card is accepted', true);

  await browser.close();

  /* --------------------------------- cleanup -------------------------------- */
  await closeLive();
  await api('/api/admin/shout/undo', { method: 'POST', body: JSON.stringify({ confirm: true }) }).catch(() => {});
  for (const pl of (await api('/api/admin/state')).data.polls) {
    if (pl.playerName === LONG_NAME) await api(`/api/admin/polls/${pl.id}`, { method: 'DELETE' });
  }
  for (const pl of (await api('/api/admin/participants')).data.participants) {
    if (String(pl.employeeId).includes(STAMP)) await api(`/api/admin/participants/${pl.id}`, { method: 'DELETE' });
  }
  for (const pl of (await api('/api/admin/players')).data.players) {
    if (pl.name === LONG_NAME) await api(`/api/admin/players/${pl.id}`, { method: 'DELETE' });
  }

  console.log('\n' + '='.repeat(58));
  console.log(`  Phone guess card: ${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log('\n  Browser errors:');
    [...new Set(errors)].forEach((e) => console.log('   - ' + e));
  } else {
    console.log('  No browser errors 🎉');
  }
  console.log('='.repeat(58) + '\n');
  process.exit(fail || errors.length ? 1 : 0);
})();
