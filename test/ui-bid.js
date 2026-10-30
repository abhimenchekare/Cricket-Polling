'use strict';

/**
 * Browser test for the bid-range round, driven like a human on a phone:
 * admin creates the round → participant DRAGS the price bar → admin enters the
 * hammer price → winners appear on the phone and on the projector.
 *
 *   npm run dev
 *   node test/ui-bid.js
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

function watch(page, tag) {
  page.on('pageerror', (e) => errors.push(`[${tag}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 40[13]|navigator\.vibrate/.test(m.text())) errors.push(`[${tag}] ${m.text()}`);
  });
}

async function cleanLeftovers() {
  const login = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ADMIN_USERNAME || 'admin',
      password: process.env.ADMIN_PASSWORD || 'admin123'
    })
  });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  const call = (method, path, body) =>
    fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined
    });
  const state = await call('GET', '/api/admin/state').then((r) => r.json());
  for (const poll of state.polls) {
    const mine =
      poll.pollType === 'bid' ||
      /dbg|testplayer|rohit \d|ui test/i.test(poll.question || '') ||
      String(poll.createdBy || '') === 'seed';
    if (mine) {
      await call('DELETE', `/api/admin/polls/${poll.id}`);
    } else if (['active', 'paused'].includes(poll.status)) {
      await call('POST', `/api/admin/polls/${poll.id}/action`, { action: 'close' });
    }
  }
  const people = await call('GET', '/api/admin/participants').then((r) => r.json());
  for (const person of people.participants.filter((x) => /^UI-BID-|^BID-[A-D]-|^DBG-BID/i.test(x.employeeId))) {
    await call('DELETE', `/api/admin/participants/${person.id}`);
  }
}

(async () => {
  await cleanLeftovers();
  const browser = await chromium.launch();

  /* ----------------------------- admin ----------------------------- */
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const admin = await desktop.newPage();
  watch(admin, 'admin');

  await admin.goto(`${BASE}/admin-login`, { waitUntil: 'networkidle' });
  await admin.fill('#username', 'admin');
  await admin.fill('#password', 'admin123');
  await admin.click('#login-btn');
  await admin.waitForURL('**/admin', { timeout: 12000 });
  await admin.waitForTimeout(1200);

  console.log('\n🎯 Create a bid round from the editor');
  await admin.goto(`${BASE}/admin/polls`, { waitUntil: 'networkidle' });
  await admin.click('#new-poll');
  await admin.waitForTimeout(500);
  await admin.waitForTimeout(300);

  ok('player field appears', await admin.locator('#f-player').isVisible());
  ok('there is no multiple-choice editor at all', (await admin.locator('#type-seg, #options-section').count()) === 0);
  ok('a short default countdown is suggested', Number(await admin.inputValue('#f-timer')) <= 30);

  const player = 'Rohit ' + Date.now().toString().slice(-4);
  await admin.fill('#f-player', player);
  await admin.fill('#f-question', '');
  await admin.click('#save-start');
  await admin.waitForTimeout(2200);

  const dash = await admin.evaluate(async () => (await fetch('/api/admin/state')).json());
  const live = dash.polls.find((p) => p.status === 'active');
  ok('bid round is live', !!live && live.pollType === 'bid', live ? live.pollType : 'none');
  ok('question auto-composed from the player name', live && live.question.includes(player), live && live.question);

  console.log('\n📱 Participant drags the price bar');
  const mobile = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await mobile.newPage();
  watch(p, 'participant');
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.fill('#name', 'Drag Tester');
  await p.fill('#employeeId', 'UI-BID-' + Date.now().toString().slice(-6));
  await p.click('#join-submit');
  await p.waitForURL('**/poll', { timeout: 12000 });
  await p.waitForTimeout(2500);

  ok('player name is shown on the phone', (await p.locator('.bid-player').innerText()).includes('Rohit'));
  ok('drag bar is rendered', await p.locator('#bid-range').isVisible());
  const startValue = await p.locator('#bid-value').innerText();
  ok('slider starts at a sensible price', /\d/.test(startValue), startValue);
  await shot(p, 'b1-bid-slider.png');

  /* the actual drag gesture — scroll the slider into view first, then drag the thumb */
  await p.locator('#bid-range').scrollIntoViewIfNeeded();
  await p.waitForTimeout(200);
  const rangeInfo = await p.locator('#bid-range').evaluate((el) => ({
    value: Number(el.value),
    max: Number(el.max)
  }));
  // land well away from the current thumb, but never on an end stop (the +/− checks follow)
  const targetFraction = rangeInfo.value > rangeInfo.max / 2 ? 0.28 : 0.72;
  const box = await p.locator('#bid-range').boundingBox();
  await p.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width * targetFraction, box.y + box.height / 2, { steps: 12 });
  await p.mouse.up();
  await p.waitForTimeout(400);
  const dragged = await p.locator('#bid-value').innerText();
  ok('dragging changes the guess', dragged !== startValue, `${startValue} → ${dragged}`);
  ok('the lock button follows the slider', (await p.locator('#vote-btn').innerText()).includes(dragged.trim()));

  /* fine tune with +, and a quick chip */
  await p.click('#bid-plus');
  await p.waitForTimeout(250);
  const afterPlus = await p.locator('#bid-value').innerText();
  ok('+ nudges one step up', afterPlus !== dragged, `${dragged} → ${afterPlus}`);
  await p.locator('.bid-chip').nth(1).click();
  await p.waitForTimeout(250);
  const chipValue = await p.locator('#bid-value').innerText();
  ok('quick-chip jumps to a round price', /Cr|L/.test(chipValue), chipValue);
  await shot(p, 'b2-bid-chosen.png');

  await p.click('#vote-btn');
  await p.waitForURL('**/vote-confirmed**', { timeout: 12000 });
  await p.waitForTimeout(250);
  const confirmText = await p.locator('body').innerText();
  ok('confirmation shows the locked price', confirmText.includes(chipValue.trim()), `want "${chipValue}" in page`);
  ok('confirmation uses guess wording', /Guess locked in/i.test(confirmText));
  ok('confirmation counts down back to the auction', (await p.locator('#confirm-return').count()) === 1);
  await shot(p, 'b3-bid-confirmed.png');

  // it is a confirmation, not a destination: the phone returns to the poll by itself
  await p.waitForURL('**/poll', { timeout: 8000 });
  ok('confirmation returns to the poll on its own', p.url().endsWith('/poll'));
  await p.waitForTimeout(600);
  ok('and the poll page shows the round again', /player|bid|range/i.test(await p.locator('body').innerText()));

  console.log('\n💰 Admin enters the hammer price');
  await admin.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await admin.waitForTimeout(1800);
  ok('sold-price panel is on the dashboard', await admin.locator('#adm-bid-range').isVisible());

  // drag the admin slider to a low price
  const abox = await admin.locator('#adm-bid-range').boundingBox();
  await admin.mouse.move(abox.x + abox.width * 0.5, abox.y + abox.height / 2);
  await admin.mouse.down();
  await admin.mouse.move(abox.x + abox.width * 0.1, abox.y + abox.height / 2, { steps: 10 });
  await admin.mouse.up();
  await admin.waitForTimeout(300);
  const soldLabel = (await admin.locator('#adm-bid-value').innerText()).trim();
  ok('admin slider shows a price', /Cr|L/.test(soldLabel), soldLabel);
  await shot(admin, 'b4-admin-price.png');

  await admin.click('#adm-bid-save');
  await admin.waitForTimeout(600);
  await admin.locator('.modal [data-act="ok"]').click();
  await admin.waitForTimeout(2500);

  const after = await admin.evaluate(async () => (await fetch('/api/admin/state')).json());
  const done = after.polls.find((x) => x.id === live.id);
  ok('round closed by entering the price', done.status === 'closed');
  ok('hammer price stored', done.actualLakh > 0, String(done.actualLakh));
  ok('winners computed', Array.isArray(done.results.winners), JSON.stringify(done.results.winners).slice(0, 80));

  console.log('\n🏆 Participants see the result');
  // the phone is the live bid and nothing else — a finished round is just the waiting duck
  await p.goto(`${BASE}/poll`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  const resultText = await p.locator('body').innerText();
  ok('no player name or sold price is left on the phone', !/sold for/i.test(resultText), resultText.replace(/\s+/g, ' ').slice(0, 90));
  ok('no rank line for this participant either', !/#\d+ of \d+/i.test(resultText));
  ok('no result list is dumped on the phone', !/Top 3 closest guesses|How the room guessed/i.test(resultText));
  ok('the phone is back to the waiting screen', (await p.locator('.duck').count()) === 1);
  await shot(p, 'b5-bid-results.png');

  console.log('\n🖥  Projector shows the winners');
  const big = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const dp = await big.newPage();
  watch(dp, 'display');
  await dp.goto(`${BASE}/display`, { waitUntil: 'networkidle' });
  // the projector opens with the bat-and-ball reveal, then settles on the winners board
  await dp.waitForSelector('.dp-winner', { timeout: 12000 }).catch(() => {});
  await dp.waitForTimeout(800);
  const dpText = await dp.locator('body').innerText();
  ok(
    'big screen shows the right-bids board',
    /right on the price/i.test(dpText) || /no player has been sold yet/i.test(dpText),
    dpText.replace(/\s+/g, ' ').slice(0, 90)
  );
  // with no guesses in the settled rounds the podium is legitimately empty — say so instead of blank
  const hasWinner = (await dp.locator('.dp-winner').count()) > 0;
  ok(
    'big screen either ranks a winner or says there is nothing yet',
    hasWinner || /nobody guessed yet|no player has been sold yet/i.test(dpText),
    dpText.replace(/\s+/g, ' ').slice(-90)
  );
  ok('big screen talks about right bids', /right bid|sold yet/i.test(dpText));
  ok('big screen does not name the player', !dpText.includes('Rohit'));
  await shot(dp, 'b6-display-winners.png');

  await browser.close();

  // leave the database clean so the other suites start from a known state
  await cleanLeftovers();

  console.log('\n' + '='.repeat(54));
  console.log(`  Bid round UI: ${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log('\n  Browser errors:');
    [...new Set(errors)].forEach((e) => console.log('   - ' + e));
  } else {
    console.log('  No browser errors 🎉');
  }
  console.log('='.repeat(54) + '\n');
  process.exit(fail || errors.length ? 1 : 0);
})();
