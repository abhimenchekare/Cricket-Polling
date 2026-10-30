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
  const rankOf = (n) => {
    const i = standings.findIndex((s) => s.name === n);
    return i < 0 ? 999 : i + 1;
  };
  const rAlpha = rankOf(`Alpha ${STAMP}`);
  const rBravo = rankOf(`Bravo ${STAMP}`);
  const rCharlie = rankOf(`Charlie ${STAMP}`);
  console.log(`     Alpha #${rAlpha} · Bravo #${rBravo} · Charlie #${rCharlie} (of ${standings.length})`);
  ok('Alpha outranks Bravo', rAlpha < rBravo, `#${rAlpha} vs #${rBravo}`);
  ok('Bravo outranks Charlie', rBravo < rCharlie, `#${rBravo} vs #${rCharlie}`);
  ok('all three are ranked', rCharlie < 999);

  /* ---------------------------- the big screen ---------------------------- */
  console.log('\n2️⃣  The projector plays the bat-and-ball reveal, then the board');
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const dp = await ctx.newPage();
  dp.on('pageerror', (e) => errors.push(`[display] ${e.message}`));
  await dp.goto(`${BASE}/display`, { waitUntil: 'domcontentloaded' });

  // the animation is on screen immediately, before any winners are shown
  await dp.waitForSelector('#dp-swing.is-playing', { timeout: 8000 });
  const swingText = await dp.locator('#dp-swing').innerText();
  ok('a bat-and-ball reveal plays first', true);
  ok('the reveal is loud about it', /six/i.test(swingText), swingText.trim());
  ok('winners stay hidden while the ball is in the air', (await dp.locator('.dp-winner:visible').count()) === 0);
  await dp.screenshot({ path: 'test/screenshots/dp1-swing.png' });

  // …and then hands over to the winners
  await dp.waitForSelector('.dp-board .dp-winner', { timeout: 8000 });
  await dp.waitForTimeout(900);

  const shown = await dp.locator('#dp-main').innerText();
  const first = await dp.locator('.dp-winner.rank-1 .dp-winner-name').innerText();
  const second = await dp.locator('.dp-winner.rank-2 .dp-winner-name').innerText();
  const third = await dp.locator('.dp-winner.rank-3 .dp-winner-name').innerText();

  /* the screen must agree with the API, whoever happens to be leading */
  const top3 = standings.slice(0, 3).map((s) => s.name);
  ok('1st place matches the standings', first.trim() === top3[0], `${first.trim()} vs ${top3[0]}`);
  ok('2nd place matches the standings', second.trim() === top3[1], `${second.trim()} vs ${top3[1]}`);
  ok('3rd place matches the standings', third.trim() === top3[2], `${third.trim()} vs ${top3[2]}`);
  ok(
    'it says how many guesses were accurate',
    /accurate/i.test(await dp.locator('.dp-winner.rank-1 .dp-winner-score').innerText()),
    (await dp.locator('.dp-winner.rank-1 .dp-winner-score').innerText()).replace(/\n/g, ' ')
  );
  ok('the badges read 1st/2nd/3rd', (await dp.locator('.dp-winner.rank-1 .dp-winner-badge').innerText()).trim() === '1st');
  ok('how many players are sold is shown', /players sold/i.test(shown));

  console.log('\n3️⃣  No player name, no question — winners only');
  ok('the current player name is not on the board', !/Screen [A-D]/.test(shown));
  ok('the question is not on the board', !/what will be the bid range/i.test(shown));
  ok('the sold price of the live round is not on the board', !/sold for/i.test(shown));

  /* readable from the back of the room */
  const size = await dp.locator('.dp-winner.rank-1 .dp-winner-name').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  ok('the winner name is projector-sized (>= 28px at 1080p)', size >= 28, `${Math.round(size)}px`);

  /* it must fit the screen */
  const layout = await dp.evaluate(() => {
    const r = (s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom) };
    };
    return { vh: window.innerHeight, board: r('.dp-board'), foot: r('.dp-foot'), head: r('.dp-head') };
  });
  ok('the board is on screen', layout.board.bottom <= layout.vh, JSON.stringify(layout.board));
  ok('the footer is still on screen', layout.foot.bottom <= layout.vh + 2, JSON.stringify(layout.foot));

  await dp.screenshot({ path: 'test/screenshots/dp2-board.png' });

  /* ------------------------------ live update ----------------------------- */
  console.log('\n4️⃣  It updates by itself when a round settles');
  const before = await dp.locator('.dp-board-sub').innerText();
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

  // the new round triggers the reveal again, then the updated board
  await dp.waitForSelector('#dp-swing.is-playing', { timeout: 15000 });
  ok('a new sold price replays the bat-and-ball reveal', true);
  await dp.waitForSelector('.dp-board .dp-winner', { timeout: 15000 });
  await dp.waitForTimeout(600);
  const after = await dp.locator('.dp-board-sub').innerText();
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
