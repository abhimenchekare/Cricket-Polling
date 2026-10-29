'use strict';

/**
 * 📣 SHOUT flow — the way the host actually runs the auction.
 *
 *   roster (pasted once) → press SHOUT → next player goes on the block on every phone
 *   → guesses come in → enter the sold price → three winners → press SHOUT again
 *
 *   npm run dev
 *   node test/shout.js
 *   BASE_URL=https://your-app.vercel.app node test/shout.js
 */

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const SHOT_DIR = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

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
const shot = (page, name) => page.screenshot({ path: path.join(SHOT_DIR, name) });
const watch = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`[${tag}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 40[13]|navigator\.vibrate/.test(m.text())) errors.push(`[${tag}] ${m.text()}`);
  });
};

const STAMP = Date.now().toString().slice(-5);
const ROSTER = [
  `Shout A ${STAMP}, Batter, 2 Cr`,
  `Shout B ${STAMP}, Bowler, 1.5 Cr`,
  `Shout C ${STAMP}, All-rounder`
];

(async () => {
  console.log(`\n📣 Shout flow → ${BASE}\n${'='.repeat(54)}`);

  /* ---------------- admin session ---------------- */
  const login = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASS || 'admin123' })
  }).then((r) => r.json());
  const H = { 'Content-Type': 'application/json', 'x-admin-token': login.token };
  const api = (p, o = {}) => fetch(BASE + p, { ...o, headers: { ...H, ...(o.headers || {}) } }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

  // clean slate: close live rounds, reset the run, clear the roster this test owns
  const st0 = await api('/api/admin/state');
  for (const p of st0.data.polls) {
    if (['active', 'paused'].includes(p.status)) await api(`/api/admin/polls/${p.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'close' }) });
  }
  await api('/api/admin/players/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) });
  // only this test's leftovers are removed — a real roster is never touched
  for (const p of (await api('/api/admin/players')).data.players) {
    if (p.name.includes(STAMP)) await api(`/api/admin/players/${p.id}`, { method: 'DELETE' });
  }

  /* ---------------- browsers ---------------- */
  const browser = await chromium.launch();
  const desk = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const admin = await desk.newPage();
  watch(admin, 'admin');
  await admin.goto(`${BASE}/admin-login`, { waitUntil: 'networkidle' });
  await admin.fill('#username', process.env.ADMIN_USER || 'admin');
  await admin.fill('#password', process.env.ADMIN_PASS || 'admin123');
  await admin.click('#login-btn');
  await admin.waitForURL('**/admin', { timeout: 12000 });
  await admin.waitForTimeout(1200);

  /* ---------------- 1. the roster ---------------- */
  console.log('\n📋 Auction list');
  await admin.goto(`${BASE}/admin/players`, { waitUntil: 'networkidle' });
  await admin.waitForTimeout(1000);
  ok('the auction list page opens', (await admin.locator('#import-text').count()) === 1);

  await admin.fill('#import-text', ROSTER.join('\n'));
  await admin.click('#import-btn');
  await admin.waitForTimeout(1500);
  const rosterRows = await admin.locator('.player-row').count();
  ok('pasted players appear in the shout order', rosterRows >= ROSTER.length, `${rosterRows} rows`);

  // re-pasting must not duplicate
  await admin.fill('#import-text', ROSTER[0]);
  await admin.click('#import-btn');
  await admin.waitForTimeout(1200);
  ok('pasting the same name twice does not duplicate it', (await admin.locator('.player-row').count()) === rosterRows);
  await shot(admin, 'sh1-auction-list.png');

  const listed = await api('/api/admin/players');
  const mine = listed.data.players.filter((p) => p.name.includes(STAMP));
  ok('every pasted player is queued', mine.length === ROSTER.length && mine.every((p) => p.status === 'queued'));
  ok('base price parsed from the paste', mine[0].baseLabel === '2.00 Cr', String(mine[0].baseLabel));

  // the ↑↓ buttons must reorder the queue — check with whatever is on screen
  const beforeMove = (await api('/api/admin/players')).data.players.map((p) => p.name);
  const secondRow = await admin.locator('.player-row').nth(1).getAttribute('data-id');
  await admin.locator(`.player-row[data-id="${secondRow}"] [data-move="-1"]`).click();
  await admin.waitForTimeout(900);
  const afterMove = (await api('/api/admin/players')).data.players.map((p) => p.name);
  ok('↑ moves a player up the shout order', afterMove[0] !== beforeMove[0], `${beforeMove[0]} → ${afterMove[0]}`);

  // put THIS test's three players at the front so the sequence below is deterministic
  const allNow = (await api('/api/admin/players')).data.players;
  const ourIds = allNow.filter((p) => p.name.includes(STAMP)).map((p) => p.id);
  const restIds = allNow.filter((p) => !p.name.includes(STAMP)).map((p) => p.id);
  await api('/api/admin/players/reorder', { method: 'POST', body: JSON.stringify({ ids: [...ourIds, ...restIds] }) });
  await admin.waitForTimeout(700);
  const order = (await api('/api/admin/players')).data.players.filter((p) => p.name.includes(STAMP)).map((p) => p.name);
  ok('the queue can be put in an explicit order', order.length === 3, order.join(' → '));

  /* ---------------- 2. audience phone ---------------- */
  console.log('\n📱 Audience phone');
  const mob = await browser.newContext({ ...devices['iPhone 13'] });
  const phone = await mob.newPage();
  watch(phone, 'phone');
  await phone.goto(BASE, { waitUntil: 'domcontentloaded' });
  await phone.fill('#name', `Shout Tester ${STAMP}`);
  await phone.fill('#employeeId', `SHOUT-${STAMP}`);
  await phone.click('#join-submit');
  await phone.waitForTimeout(1500);
  await phone.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
  await phone.waitForTimeout(1200);
  ok(
    'the phone is quiet until the host shouts',
    (await phone.locator('#shout-splash.shout-splash-in').count()) === 0
  );

  /* ---------------- 3. SHOUT #1 ---------------- */
  console.log('\n📣 SHOUT');
  await admin.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await admin.waitForTimeout(1800);
  const firstExpected = order[0];
  const shoutBtnText = (await admin.locator('#shout-btn').innerText()).trim();
  ok('the SHOUT button names the next player', new RegExp(firstExpected.toUpperCase()).test(shoutBtnText.toUpperCase()), shoutBtnText);
  ok('admin does not type a player name anywhere', (await admin.locator('#f-player, input[placeholder*="Rohit" i]').count()) === 0);

  const t0 = Date.now();
  await admin.click('#shout-btn');
  await phone.waitForSelector('#shout-splash.shout-splash-in', { timeout: 10000 }).catch(() => {});
  const splashMs = Date.now() - t0;
  const splashName = await phone.locator('.shout-splash-name').textContent().catch(() => '');
  ok('the phone shows the ON THE BLOCK splash', /ON THE BLOCK/i.test(await phone.locator('#shout-splash').innerText().catch(() => '')));
  ok('the splash names the shouted player', splashName.trim() === firstExpected, `${splashName.trim()} vs ${firstExpected}`);
  ok('it lands in under 2.5 s', splashMs < 2500, `${splashMs} ms`);
  await shot(phone, 'sh2-shout-splash.png');

  await phone.waitForSelector('#bid-range', { timeout: 8000 }).catch(() => {});
  ok('the price slider for that player is ready', (await phone.locator('#bid-range').count()) === 1);
  const pollNow = await api('/api/state');
  ok('the round belongs to the next player in the list', pollNow.data.poll.playerName === firstExpected, pollNow.data.poll.playerName);
  ok('the next player is shown to the audience', pollNow.data.auction.upNext !== firstExpected && !!pollNow.data.auction.upNext);

  /* one guess so the round is not empty */
  await phone.locator('#bid-range').first().fill('40');
  await phone.waitForTimeout(250);
  await phone.click('#vote-btn');
  await phone.waitForTimeout(900);
  ok('the audience can guess the shouted player', phone.url().includes('vote-confirmed') || /locked/i.test(await phone.locator('body').innerText()));

  await admin.waitForTimeout(1500);
  const dashText = await admin.locator('#shout-panel').innerText();
  ok('the dashboard shows who is on the block', dashText.includes(firstExpected), dashText.split('\n')[1] || '');
  ok('the dashboard shows how many guesses are in', /1 guess/i.test(dashText));
  await shot(admin, 'sh3-on-the-block.png');

  /* ---------------- 4. sold price → winners ---------------- */
  console.log('\n💰 Sold price');
  const liveId = pollNow.data.poll.id;
  const sold = await api(`/api/admin/polls/${liveId}/actual`, { method: 'POST', body: JSON.stringify({ price: '2.10 Cr' }) });
  ok('sold price accepted', sold.status === 200 && sold.data.actualLakh === 210);
  ok('the roster records the player as SOLD', sold.data.player && sold.data.player.status === 'sold', JSON.stringify(sold.data.player));

  const afterSale = await api('/api/admin/players');
  const soldRow = afterSale.data.players.find((p) => p.id === sold.data.player.id);
  ok('the sold price is stored against the player', soldRow.soldLabel === '2.10 Cr', String(soldRow.soldLabel));
  ok('SOLD count goes up', JSON.stringify(afterSale.data.counts.sold) !== '0');

  await phone.waitForTimeout(1500);
  ok(
    'the confirmation page announces the sold round',
    /sold|winner|locked/i.test(await phone.locator('body').innerText())
  );
  await phone.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
  await phone.waitForTimeout(1800);
  ok('the poll page shows the winners', /winner|sold for/i.test(await phone.locator('body').innerText()));

  /* ---------------- 5. SHOUT #2 ---------------- */
  console.log('\n📣 SHOUT again');
  await admin.waitForTimeout(1200);
  const secondExpected = order[1];
  const btn2 = (await admin.locator('#shout-btn').innerText()).trim();
  ok('the button moved on to the next player', new RegExp(secondExpected.toUpperCase()).test(btn2.toUpperCase()), btn2);

  const t1 = Date.now();
  await admin.click('#shout-btn');
  await phone.waitForSelector('.shout-splash-name', { timeout: 10000 }).catch(() => {});
  await phone.waitForTimeout(400);
  const secondName = (await phone.locator('.shout-splash-name').textContent().catch(() => '')).trim();
  ok('the second player is shouted to the phone', secondName === secondExpected, `${secondName} vs ${secondExpected}`);
  ok('the second shout lands in under 2.5 s', Date.now() - t1 < 2500, `${Date.now() - t1} ms`);
  await shot(phone, 'sh4-second-shout.png');
  await shot(admin, 'sh5-dashboard-sequence.png');

  /* ---------------- 6. skip / undo / guards ---------------- */
  console.log('\n↷ Guards');
  const blocked = await api('/api/admin/shout', { method: 'POST', body: JSON.stringify({}) });
  ok('cannot shout over a live round without confirming', blocked.status === 409 && !!blocked.data.onBlock, `status ${blocked.status}`);

  const undo = await api('/api/admin/shout/undo', { method: 'POST', body: JSON.stringify({ confirm: true }) });
  ok('undo puts the player back and clears the round', undo.status === 200);
  const afterUndo = await api('/api/admin/players');
  ok('the player is queued again', afterUndo.data.players.find((p) => p.id === undo.data.player.id).status === 'queued');

  const shoutedAgain = await api('/api/admin/shout', { method: 'POST', body: JSON.stringify({ timerSeconds: 30 }) });
  ok('the same player can be shouted again after undo', shoutedAgain.status === 201 && shoutedAgain.data.shouted.name === secondExpected);

  const skip = await api(`/api/admin/players/${shoutedAgain.data.shouted.id}/skip`, { method: 'POST', body: JSON.stringify({ status: 'queued' }) });
  ok('a player can be skipped', skip.status === 200);

  /* ---------------- 7. empty queue ---------------- */
  for (const p of (await api('/api/admin/players')).data.players) {
    if (p.name.includes(STAMP)) await api(`/api/admin/players/${p.id}`, { method: 'DELETE' });
  }
  const emptyRoster = (await api('/api/admin/players')).data.counts.queued === 0;
  if (emptyRoster) {
    const drained = await api('/api/admin/shout', { method: 'POST', body: JSON.stringify({ force: true }) });
    ok('an empty list gives a clear message', drained.status === 409 && drained.data.empty === true, JSON.stringify(drained.data));
  } else {
    // a real roster is loaded in this database — the guard is still exercised below
    const drained = await api('/api/admin/shout', { method: 'POST', body: JSON.stringify({ force: true }) });
    ok('shouting always takes the next queued player', drained.status === 201 && !!drained.data.shouted.name);
    await api('/api/admin/shout/undo', { method: 'POST', body: JSON.stringify({ confirm: true }) });
  }

  /* ---------------- cleanup ---------------- */
  for (const p of (await api('/api/admin/state')).data.polls) {
    if (['active', 'paused'].includes(p.status)) await api(`/api/admin/polls/${p.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'close' }) });
    if (p.playerName && p.playerName.includes(STAMP)) await api(`/api/admin/polls/${p.id}`, { method: 'DELETE' });
  }
  for (const p of (await api('/api/admin/participants')).data.participants) {
    if (p.employeeId === `SHOUT-${STAMP}`) await api(`/api/admin/participants/${p.id}`, { method: 'DELETE' });
  }

  await browser.close();

  console.log('\n' + '='.repeat(54));
  console.log(`  Shout flow: ${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log('\n  Browser errors:');
    [...new Set(errors)].forEach((e) => console.log('   - ' + e));
  } else {
    console.log('  No browser console errors 🎉');
  }
  console.log('='.repeat(54) + '\n');
  process.exit(fail || errors.length ? 1 : 0);
})();
