'use strict';

/**
 * 🖥  Big screen — the winners podium.
 *
 * The projector has to answer the only question the room is asking:
 * "who has guessed the most players accurately?" — 1st, 2nd and 3rd.
 *
 *   npm run dev
 *   node test/display.js
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
  console.log(`\n🖥  Big screen winners → ${BASE}\n${'='.repeat(58)}`);

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

  const meta = await fetch(`${BASE}/api/meta`).then((r) => r.json());
  const LADDER = meta.bid.ladder;
  const idxOf = (lakh) => {
    const i = LADDER.findIndex((x) => x.lakh === lakh);
    if (i < 0) throw new Error(`${lakh} not on ladder`);
    return i;
  };

  /* three players, three rounds: Alpha is closest most often, then Bravo, then Charlie */
  await closeLive();
  const players = [`Screen A ${STAMP}`, `Screen B ${STAMP}`, `Screen C ${STAMP}`];
  await api('/api/admin/players', { method: 'POST', body: JSON.stringify({ names: players.join('\n') }) });
  const roster = (await api('/api/admin/players')).data.players;
  const ours = roster.filter((p) => p.name.includes(STAMP)).map((p) => p.id);
  await api('/api/admin/players/reorder', {
    method: 'POST',
    body: JSON.stringify({ ids: [...ours, ...roster.filter((p) => !p.name.includes(STAMP)).map((p) => p.id)] })
  });

  const guessers = [
    { name: `Alpha ${STAMP}`, id: `DS-A-${STAMP}`, lakh: 225 }, // called on every round
    { name: `Bravo ${STAMP}`, id: `DS-B-${STAMP}`, lakh: 250 },
    { name: `Charlie ${STAMP}`, id: `DS-C-${STAMP}`, lakh: 300 }
  ];

  const browser = await chromium.launch();
  for (const g of guessers) {
    g.ctx = await browser.newContext();
    const page = await g.ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${g.name}] ${e.message}`));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.fill('#name', g.name);
    await page.fill('#employeeId', g.id);
    await page.click('#join-submit');
    await page.waitForTimeout(500);
    await page.close();
  }

  /* Play the rounds: each player sells for 2.00 / 2.20 / 2.40 Cr.
     Alpha is always the closest (25 L, then 5 L, then 15 L)
     Bravo is second twice, Charlie second once. */
  const rounds = [
    { player: players[0], sold: 200 },
    { player: players[1], sold: 220 },
    { player: players[2], sold: 240 }
  ];

  for (const round of rounds) {
    const shout = await api('/api/admin/shout', { method: 'POST', body: JSON.stringify({ timerSeconds: 300 }) });
    if (shout.status !== 201) throw new Error('shout failed: ' + JSON.stringify(shout.data));
    for (const g of guessers) {
      const page = await g.ctx.newPage();
      await page.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#bid-range', { timeout: 15000 });
      await page.waitForTimeout(250);
      await page.locator('#bid-range').first().evaluate((el, idx) => {
        el.value = String(idx);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, idxOf(g.lakh));
      await page.waitForTimeout(120);
      await page.click('#vote-btn');
      await page.waitForSelector('text=Guess locked in', { timeout: 15000 });
      await page.close();
    }
    const sold = await api(`/api/admin/polls/${shout.data.poll.id}/actual`, {
      method: 'POST',
      body: JSON.stringify({ lakh: round.sold })
    });
    if (sold.status !== 200) throw new Error('price failed: ' + JSON.stringify(sold.data));
  }

  const standings = (await api('/api/admin/ledger')).data.standings;
  console.log('\n1️⃣  The numbers the screen must show');
  standings.slice(0, 3).forEach((s) => console.log(`     ${s.rank}. ${s.name} — ${s.nearest} accurate, ${s.exact} exact`));
  ok('Alpha leads on accurate guesses', standings[0].name === `Alpha ${STAMP}`, standings[0].name);
  ok('three participants are ranked', standings.length >= 3);

  /* ---------------------------- the big screen ---------------------------- */
  console.log('\n2️⃣  The projector shows the podium');
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const dp = await ctx.newPage();
  dp.on('pageerror', (e) => errors.push(`[display] ${e.message}`));
  await dp.goto(`${BASE}/display`, { waitUntil: 'domcontentloaded' });
  await dp.waitForSelector('#dp-leaders.is-on', { timeout: 15000 });
  await dp.waitForTimeout(700);

  const shown = await dp.locator('#dp-leaders').innerText();
  const first = await dp.locator('.dp-leader.rank-1 .dp-leader-name').innerText();
  const second = await dp.locator('.dp-leader.rank-2 .dp-leader-name').innerText();
  const third = await dp.locator('.dp-leader.rank-3 .dp-leader-name').innerText();

  ok('the strip is titled clearly', /most accurate guesses/i.test(shown), shown.split('\n')[0]);
  ok('1st place is shown', first.includes(`Alpha ${STAMP}`), first);
  ok('2nd place is shown', second.includes(`Bravo ${STAMP}`), second);
  ok('3rd place is shown', third.includes(`Charlie ${STAMP}`), third);
  ok('the accurate count is displayed', /\d+/.test(await dp.locator('.dp-leader.rank-1 .dp-leader-score').innerText()));
  ok('the medal labels are 1st/2nd/3rd', (await dp.locator('.dp-leader.rank-1 .dp-leader-medal').innerText()).trim() === '1st');
  ok('how many players are sold is shown', /players sold/i.test(shown));

  /* readable from the back of the room */
  const size = await dp.locator('.dp-leader.rank-1 .dp-leader-name').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  ok('the winner name is projector-sized (>= 20px at 1080p)', size >= 20, `${Math.round(size)}px`);

  /* it must not push the live round or the footer off the screen */
  const layout = await dp.evaluate(() => {
    const r = (s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom) };
    };
    return { vh: window.innerHeight, leaders: r('#dp-leaders'), foot: r('.dp-foot'), main: r('#dp-main') };
  });
  ok('the strip is on screen', layout.leaders.bottom <= layout.vh, JSON.stringify(layout.leaders));
  ok('the footer is still on screen', layout.foot.bottom <= layout.vh + 2, JSON.stringify(layout.foot));
  ok('the live round still has room', layout.main.bottom <= layout.leaders.top + 2);

  await dp.screenshot({ path: 'test/screenshots/dp1-leaders.png' });

  /* ------------------------------ live update ----------------------------- */
  console.log('\n3️⃣  It updates by itself when a round settles');
  const before = await dp.locator('.dp-leaders-sub').innerText();
  await api('/api/admin/players', { method: 'POST', body: JSON.stringify({ names: `Screen D ${STAMP}` }) });
  const shout = await api('/api/admin/shout', { method: 'POST', body: JSON.stringify({ timerSeconds: 300 }) });
  for (const g of guessers) {
    const page = await g.ctx.newPage();
    await page.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#bid-range', { timeout: 15000 });
    await page.waitForTimeout(250);
    await page.locator('#bid-range').first().evaluate((el, idx) => {
      el.value = String(idx);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, idxOf(g.lakh));
    await page.waitForTimeout(120);
    await page.click('#vote-btn');
    await page.waitForSelector('text=Guess locked in', { timeout: 15000 });
    await page.close();
  }
  await api(`/api/admin/polls/${shout.data.poll.id}/actual`, { method: 'POST', body: JSON.stringify({ lakh: 230 }) });
  await dp.waitForTimeout(3500);
  const after = await dp.locator('.dp-leaders-sub').innerText();
  ok('the "players sold" counter moves on its own', before !== after, `${before} → ${after}`);

  await browser.close();

  /* -------------------------------- cleanup ------------------------------- */
  await closeLive();
  await api('/api/admin/shout/undo', { method: 'POST', body: JSON.stringify({ confirm: true }) }).catch(() => {});
  for (const p of (await api('/api/admin/state')).data.polls) {
    if (new RegExp(`Screen [A-D] ${STAMP}`).test(p.playerName || '')) await api(`/api/admin/polls/${p.id}`, { method: 'DELETE' });
  }
  for (const p of (await api('/api/admin/participants')).data.participants) {
    if (String(p.employeeId).includes(STAMP)) await api(`/api/admin/participants/${p.id}`, { method: 'DELETE' });
  }
  for (const p of (await api('/api/admin/players')).data.players) {
    if (p.name.includes(STAMP)) await api(`/api/admin/players/${p.id}`, { method: 'DELETE' });
  }

  console.log('\n' + '='.repeat(58));
  console.log(`  Big screen winners: ${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log('\n  Browser errors:');
    [...new Set(errors)].forEach((e) => console.log('   - ' + e));
  } else {
    console.log('  No browser errors 🎉');
  }
  console.log('='.repeat(58) + '\n');
  process.exit(fail || errors.length ? 1 : 0);
})();
