'use strict';

/**
 * 🏆 The ledger — 70 players, one by one.
 *
 * Proves the whole promise of the auction:
 *   - every round's result is stored, not recomputed from memory
 *   - the three winners are the three guesses closest to the sold price (1st, 2nd, 3rd)
 *   - a price can be entered long after the round closed (the host is never on a clock)
 *   - shouting past an unpriced player loses nothing — they stay settleable
 *   - the leaderboard adds up across every player sold
 *
 *   npm run dev
 *   node test/ledger.js
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
  console.log(`\n🏆 Results ledger → ${BASE}\n${'='.repeat(58)}`);

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

  /* ---------------- a clean three-player slice of the auction ---------------- */
  await closeLive();
  const players = [`Ledger A ${STAMP}`, `Ledger B ${STAMP}`, `Ledger C ${STAMP}`];
  await api('/api/admin/players', { method: 'POST', body: JSON.stringify({ names: players.join('\n') }) });

  // put our three at the front so the sequence is deterministic, and nothing else gets shouted
  const all = (await api('/api/admin/players')).data.players;
  const ours = all.filter((p) => p.name.includes(STAMP)).map((p) => p.id);
  const rest = all.filter((p) => !p.name.includes(STAMP)).map((p) => p.id);
  await api('/api/admin/players/reorder', { method: 'POST', body: JSON.stringify({ ids: [...ours, ...rest] }) });

  // the ladder index for a given lakh value, straight from the server
  const meta = await fetch(`${BASE}/api/meta`).then((r) => r.json());
  const LADDER = meta.bid.ladder;
  const idxOf = (lakh) => {
    const i = LADDER.findIndex((x) => x.lakh === lakh);
    if (i < 0) throw new Error(`lakh ${lakh} is not on the ladder`);
    return i;
  };

  /* ---------------- three guessers with known guesses ---------------- */
  const browser = await chromium.launch();
  const guessers = [
    { name: `Ledger Closest ${STAMP}`, id: `LG-1-${STAMP}`, lakh: 225 }, // 25 L off a 2 Cr sale
    { name: `Ledger Second ${STAMP}`, id: `LG-2-${STAMP}`, lakh: 250 }, // 50 L off
    { name: `Ledger Third ${STAMP}`, id: `LG-3-${STAMP}`, lakh: 275 }, // 75 L off
    { name: `Ledger Far ${STAMP}`, id: `LG-4-${STAMP}`, lakh: 600 } // 400 L off
  ];

  for (const g of guessers) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${g.name}] ${e.message}`));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.fill('#name', g.name);
    await page.fill('#employeeId', g.id);
    await page.click('#join-submit');
    await page.waitForTimeout(500);
    g.ctx = ctx;
  }

  async function guessAllRound() {
    for (const g of guessers) {
      const page = await g.ctx.newPage();
      await page.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#bid-range', { timeout: 15000 });
      await page.waitForTimeout(300);
      // the slider is an index into the ladder — set it by matching the lakh value
      await page.locator('#bid-range').first().evaluate((el, idx) => {
        el.value = String(idx);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, idxOf(g.lakh));
      await page.waitForTimeout(150);
      await page.click('#vote-btn');
      await page.waitForSelector('text=Guess locked in', { timeout: 15000 });
      await page.close();
    }
  }

  /* ---------------- round 1: shout → guess → sold price ---------------- */
  console.log('\n1️⃣  Round 1 — shout, guess, enter the price');
  const shout1 = await api('/api/admin/shout', { method: 'POST', body: JSON.stringify({ timerSeconds: 300 }) });
  ok('the first player goes on the block', shout1.status === 201 && shout1.data.shouted.name === players[0]);

  await guessAllRound();
  const round1 = shout1.data.poll.id;

  const sold1 = await api(`/api/admin/polls/${round1}/actual`, { method: 'POST', body: JSON.stringify({ price: '2 Cr' }) });
  ok('the sold price is accepted', sold1.status === 200 && sold1.data.actualLakh === 200, String(sold1.data.actualLakh));

  const w1 = sold1.data.winners || [];
  ok('three winners are declared', w1.length === 3, `${w1.length} winners`);
  ok('1st is the closest guess', w1[0] && w1[0].name === guessers[0].name, w1[0] && w1[0].name);
  ok('2nd is the next closest', w1[1] && w1[1].name === guessers[1].name, w1[1] && w1[1].name);
  ok('3rd is the third closest', w1[2] && w1[2].name === guessers[2].name, w1[2] && w1[2].name);
  ok('the farthest guesser is not a winner', !w1.some((w) => w.name === guessers[3].name));

  const ledger1 = await api('/api/admin/ledger');
  const row1 = ledger1.data.rows.find((r) => r.name === players[0]);
  ok('the result is stored in the ledger', row1 && row1.settled && row1.soldLabel === '2.00 Cr', row1 && row1.soldLabel);
  ok('the ledger keeps the three winners', row1 && row1.winners.length === 3);
  ok('the ledger records how many guessed', row1 && row1.guessCount === guessers.length, row1 && String(row1.guessCount));

  /* ---------------- round 2: the host is never on a clock ---------------- */
  console.log('\n2️⃣  Round 2 — shout past the timer, price later');
  const shout2 = await api('/api/admin/shout', { method: 'POST', body: JSON.stringify({ timerSeconds: 300 }) });
  ok('the second player goes on the block', shout2.status === 201 && shout2.data.shouted.name === players[1], shout2.data.shouted && shout2.data.shouted.name);

  await guessAllRound();
  // the countdown runs out (or the host closes it) before any price is typed
  await api(`/api/admin/polls/${shout2.data.poll.id}/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'close' })
  });
  await new Promise((r) => setTimeout(r, 300));

  const afterTimer = await api('/api/admin/ledger');
  const pending = afterTimer.data.rows.find((r) => r.name === players[1]);
  ok('a closed round with no price shows as awaiting', pending && !pending.settled && pending.pollId != null);
  ok('its guesses are already stored', pending && pending.guessCount === guessers.length, pending && String(pending.guessCount));

  const latePrice = await api(`/api/admin/polls/${shout2.data.poll.id}/actual`, {
    method: 'POST',
    body: JSON.stringify({ price: '1.5 Cr' })
  });
  ok('the price can be entered after the countdown ended', latePrice.status === 200 && latePrice.data.actualLakh === 150);
  // 1.5 Cr sale → 225 (75 off) beats 250 (100 off) beats 275 (125 off)
  ok('and the winners are still correct', latePrice.data.winners[0].name === guessers[0].name, latePrice.data.winners[0].name);

  /* ---------------- round 3: shout next WITHOUT a price, settle later ---------------- */
  console.log('\n3️⃣  Round 3 — shout past an unpriced player, settle it later');
  const shout3 = await api('/api/admin/shout', { method: 'POST', body: JSON.stringify({ timerSeconds: 300 }) });
  ok('the third player goes on the block', shout3.status === 201 && shout3.data.shouted.name === players[2]);
  await guessAllRound();

  const blocked = await api('/api/admin/shout', { method: 'POST', body: JSON.stringify({}) });
  ok('shouting on without a price asks first', blocked.status === 409 && blocked.data.needsPrice === true, JSON.stringify(blocked.data && blocked.data.needsPrice));

  // no more players queued for this test — add one so the shout has somewhere to go
  await api('/api/admin/players', { method: 'POST', body: JSON.stringify({ names: `Ledger D ${STAMP}` }) });
  const movedOn = await api('/api/admin/shout', {
    method: 'POST',
    body: JSON.stringify({ allowUnpriced: true, timerSeconds: 300 })
  });
  ok('the host can shout on anyway', movedOn.status === 201, JSON.stringify(movedOn.data && movedOn.data.error));

  const lostRow = (await api('/api/admin/ledger')).data.rows.find((r) => r.name === players[2]);
  ok('the unpriced player is kept in the ledger', lostRow && !lostRow.settled && lostRow.pollId != null);
  ok('their guesses are not lost either', lostRow && lostRow.guessCount === guessers.length, lostRow && String(lostRow.guessCount));

  const settledLate = await api(`/api/admin/polls/${lostRow.pollId}/actual`, {
    method: 'POST',
    body: JSON.stringify({ price: '2.5 Cr' })
  });
  ok('that player can still be settled afterwards', settledLate.status === 200, String(settledLate.status));
  const fixed = (await api('/api/admin/ledger')).data.rows.find((r) => r.name === players[2]);
  ok('and the ledger then shows them SOLD', fixed && fixed.settled && fixed.soldLabel === '2.50 Cr', fixed && fixed.soldLabel);
  ok('with their three winners', fixed && fixed.winners.length === 3);

  /* ---------------- the leaderboard adds up ---------------- */
  console.log('\n4️⃣  Leaderboard');
  const led = await api('/api/admin/ledger');
  const standings = led.data.standings || [];
  const closest = standings.find((s) => s.name === guessers[0].name);
  ok('the closest guesser leads', standings[0] && standings[0].name === guessers[0].name, standings[0] && standings[0].name);
  ok('points are 3/2/1 per round', closest && closest.points >= 3, closest && String(closest.points));

  // the same maths must be visible to the audience
  const publicStandings = await fetch(`${BASE}/api/standings`).then((r) => r.json());
  ok('the audience sees the same leaderboard', publicStandings.standings[0].name === standings[0].name);
  ok('and the number of players sold', publicStandings.rounds >= 3, String(publicStandings.rounds));

  /* ---------------- CSV ---------------- */
  const csv = await fetch(`${BASE}/api/admin/ledger.csv`, { headers: H });
  const text = await csv.text();
  ok('the ledger exports as CSV', csv.status === 200 && text.includes('1st (closest)'));
  ok('with a row per player', text.split('\n').length > 3);

  /* ---------------- admin page ---------------- */
  console.log('\n5️⃣  The ledger page');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const admin = await ctx.newPage();
  admin.on('pageerror', (e) => errors.push(`[admin] ${e.message}`));
  await admin.goto(`${BASE}/admin-login`, { waitUntil: 'networkidle' });
  await admin.fill('#username', ADMIN_USER);
  await admin.fill('#password', ADMIN_PASS);
  await admin.click('#login-btn');
  await admin.waitForURL('**/admin', { timeout: 12000 });
  await admin.goto(`${BASE}/admin/results`, { waitUntil: 'networkidle' });
  await admin.waitForTimeout(1800);
  const pageText = await admin.locator('body').innerText();
  ok('the page lists the sold players', pageText.includes(players[0]) && pageText.includes('2.00 Cr'));
  ok('the leaderboard card is rendered', (await admin.locator('#lg-standings table').count()) === 1);
  ok('the winner names are on the page', pageText.includes(guessers[0].name));
  await admin.screenshot({ path: 'test/screenshots/lg1-ledger.png', fullPage: false });

  await browser.close();

  /* ---------------- cleanup ---------------- */
  await closeLive();
  await api('/api/admin/shout/undo', { method: 'POST', body: JSON.stringify({ confirm: true }) }).catch(() => {});
  for (const p of (await api('/api/admin/state')).data.polls) {
    if (new RegExp(`Ledger [A-D] ${STAMP}`).test(p.playerName || '')) {
      await api(`/api/admin/polls/${p.id}`, { method: 'DELETE' });
    }
  }
  for (const p of (await api('/api/admin/participants')).data.participants) {
    if (String(p.employeeId).includes(STAMP)) await api(`/api/admin/participants/${p.id}`, { method: 'DELETE' });
  }
  for (const p of (await api('/api/admin/players')).data.players) {
    if (p.name.includes(STAMP)) await api(`/api/admin/players/${p.id}`, { method: 'DELETE' });
  }

  console.log('\n' + '='.repeat(58));
  console.log(`  Ledger: ${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log('\n  Browser errors:');
    [...new Set(errors)].forEach((e) => console.log('   - ' + e));
  } else {
    console.log('  No browser errors 🎉');
  }
  console.log('='.repeat(58) + '\n');
  process.exit(fail || errors.length ? 1 : 0);
})();
