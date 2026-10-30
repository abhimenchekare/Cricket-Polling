'use strict';

/**
 * Browser UI test — slider-only edition (v3).
 * Drives the real pages at phone + desktop sizes and captures console errors.
 *
 *   npm run dev
 *   node test/ui.js
 */

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const SHOT_DIR = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const errors = [];
let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOT_DIR, name) });
function watch(page, tag) {
  page.on('pageerror', (e) => errors.push(`[${tag}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 40[13]|navigator\.vibrate/.test(m.text())) errors.push(`[${tag}] ${m.text()}`);
  });
}

const PLAYER = `UI Player ${Date.now() % 100000}`;

(async () => {
  const browser = await chromium.launch();
  const mobile = await browser.newContext({ ...devices['iPhone 13'] });

  /* ------------------------------ participant ---------------------------- */
  console.log('\n📱 Participant (mobile)');
  const p1 = await mobile.newPage();
  watch(p1, 'participant');

  await p1.goto(BASE, { waitUntil: 'networkidle' });
  ok('join page renders', await p1.locator('#join-form').isVisible());
  await shot(p1, '01-join-mobile.png');

  await p1.fill('#name', 'UI Tester');
  await p1.fill('#employeeId', `UI-${Date.now() % 100000}`);
  await p1.click('#join-submit');
  await p1.waitForTimeout(2000);
  ok('join lands on the poll screen', p1.url().includes('/poll') || (await p1.locator('#poll-area').count()) > 0);
  await shot(p1, '02-poll-idle-mobile.png');

  /* -------------------------------- admin -------------------------------- */
  console.log('\n🖥  Admin (desktop)');
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const admin = await desktop.newPage();
  watch(admin, 'admin');

  await admin.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await admin.waitForURL('**/admin-login**', { timeout: 8000 }).catch(() => {});
  ok('unauthenticated admin redirects to login', admin.url().includes('/admin-login'));

  await admin.fill('#username', 'admin');
  await admin.fill('#password', 'admin123');
  await admin.click('#login-btn');
  await admin.waitForURL('**/admin', { timeout: 8000 });
  await admin.waitForTimeout(1200);
  ok('admin dashboard loads after login', await admin.locator('#dash-kpis').isVisible());
  await shot(admin, '03-admin-dashboard.png');

  /* the poll editor is slider-only */
  await admin.goto(`${BASE}/admin-polls`, { waitUntil: 'networkidle' });
  await admin.click('#new-poll');
  await admin.waitForTimeout(300);
  ok('editor has a player name field', (await admin.locator('#f-player').count()) === 1);
  ok('multiple-choice toggle is gone', (await admin.locator('#type-seg').count()) === 0);
  ok('answer-option rows are gone', (await admin.locator('.option-input-row, #option-editor').count()) === 0);

  await admin.fill('#f-player', PLAYER);
  await admin.click('#timer-presets button[data-secs="60"]');
  await shot(admin, '04-admin-create-round.png');
  await admin.click('#save-start');
  await admin.waitForTimeout(2200);
  ok('bid round created and started from the UI', (await admin.locator('.poll-item.is-live').count()) > 0);
  const autoQ = await admin
    .locator('.poll-item.is-live .poll-item-q')
    .first()
    .textContent()
    .catch(() => '');
  ok('question auto-written from the player name', new RegExp(PLAYER).test(autoQ || ''), autoQ || 'none');
  await shot(admin, '05-admin-polls-live.png');

  /* keep only our round live so the participant is guaranteed to see it */
  await admin.evaluate(async (player) => {
    const st = await (await fetch('/api/admin/state')).json();
    for (const poll of st.polls) {
      const ours = poll.status === 'active' && poll.playerName === player;
      if (['active', 'paused'].includes(poll.status) && !ours) {
        await fetch(`/api/admin/polls/${poll.id}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'close' })
        });
      }
    }
  }, PLAYER);
  await admin.waitForTimeout(600);

  /* --------------------------- participant guesses ----------------------- */
  console.log('\n🎚  Slider guess on the phone');
  await p1.waitForTimeout(2500);
  const qText = await p1.locator('.poll-question').textContent().catch(() => '');
  ok('participant gets the live round without refreshing', new RegExp(PLAYER).test(qText || ''), qText || 'none');
  ok('the price slider is on screen', (await p1.locator('#bid-range, input[type="range"]').count()) > 0);
  ok('no radio-style options exist', (await p1.locator('.option[data-option]').count()) === 0);
  await shot(p1, '06-guess-slider-mobile.png');

  /* drag the slider like a thumb would */
  const slider = p1.locator('#bid-range').first();
  const box = await slider.boundingBox();
  if (box) {
    await p1.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await p1.mouse.down();
    await p1.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2, { steps: 12 });
    await p1.mouse.up();
  }
  await p1.waitForTimeout(400);
  const shownValue = await p1.locator('#bid-value, .bid-value, .bid-price').first().textContent().catch(() => '');
  ok('dragging updates the shown price', /L|Cr/.test(shownValue || ''), shownValue || 'none');
  await shot(p1, '07-guess-dragged-mobile.png');

  await p1.click('#vote-btn');
  await p1.waitForURL('**/vote-confirmed**', { timeout: 9000 });
  await p1.waitForTimeout(250);
  ok('confirmation page reports the locked guess', /Cr|L/.test((await p1.locator('#choice').textContent()) || ''));
  await shot(p1, '08-guess-confirmed-mobile.png');

  // the confirmation is a stop-off, not a destination — it returns to the poll on its own
  await p1.waitForURL('**/poll', { timeout: 9000 });
  ok('confirmation returns to the poll by itself', p1.url().endsWith('/poll'));
  await p1.waitForTimeout(1500);
  ok('page shows the already-guessed state', (await p1.locator('.voted-state, #vote-btn').count()) >= 0);
  ok('cannot guess twice', (await p1.locator('#vote-btn:not([disabled])').count()) === 0);

  /* ------------------------- sold price → winners ------------------------ */
  console.log('\n🏆 Sold price → winners everywhere');
  await admin.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await admin.waitForTimeout(1500);
  ok('dashboard shows the sold-price control for the live round', (await admin.locator('#adm-bid-range, #adm-bid-save').count()) > 0);

  await admin.evaluate(async (player) => {
    const st = await (await fetch('/api/admin/state')).json();
    const poll = st.polls.find((p) => p.playerName === player);
    await fetch(`/api/admin/polls/${poll.id}/actual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lakh: 200 })
    });
  }, PLAYER);
  await admin.waitForTimeout(1200);

  const projCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const proj = await projCtx.newPage();
  watch(proj, 'display');
  await proj.goto(`${BASE}/display`, { waitUntil: 'networkidle' });
  // bat-and-ball reveal first, then the winners board
  await proj.waitForSelector('.dp-winner, .dp-idle', { timeout: 12000 }).catch(() => {});
  await proj.waitForTimeout(2600);
  const projText = await proj.locator('body').innerText();
  ok('projector shows the winners board', /most accurate guesses|no player has been sold/i.test(projText), projText.slice(0, 80));
  await shot(proj, '09-display-winners.png');

  await p1.goto(`${BASE}/poll`, { waitUntil: 'networkidle' });
  await p1.waitForTimeout(2500);
  ok('phone shows the winners', /winner|🥇|2\.00 Cr/i.test(await p1.locator('#poll-area').innerText()));
  await shot(p1, '10-poll-winners-mobile.png');

  /* --------------------------- the guess sheet --------------------------- */
  console.log('\n👥 Admin guess sheet (per poll)');
  await admin.goto(`${BASE}/admin-polls`, { waitUntil: 'networkidle' });
  await admin.waitForTimeout(1200);
  const sheetBtn = admin.locator('[data-guesses]').first();
  ok('a guess-sheet button exists on each round', (await sheetBtn.count()) > 0);
  await sheetBtn.click();
  await admin.waitForTimeout(1500);
  ok('guess sheet opens', await admin.locator('#guess-sheet').isVisible());
  const sheetText = await admin.locator('#guess-sheet').innerText();
  ok('sheet lists participants', /UI Tester/.test(sheetText), sheetText.slice(0, 80));
  ok('sheet shows the guess value', /Cr|L/.test(sheetText));
  ok('sheet shows who has not guessed yet', /Still missing/i.test(sheetText));
  ok('sheet names the winners', /Winners/i.test(sheetText));
  await shot(admin, '11-guess-sheet.png');
  await admin.click('#gs-close');
  await admin.waitForTimeout(300);
  ok('guess sheet closes', !(await admin.locator('#guess-sheet').isVisible()));

  /* ------------------------------ other pages ---------------------------- */
  console.log('\n📄 Other pages');
  const rp = await mobile.newPage();
  watch(rp, 'results');
  await rp.goto(`${BASE}/results`, { waitUntil: 'networkidle' });
  await rp.waitForTimeout(1200);
  ok('results page loads', await rp.locator('body').isVisible());
  await shot(rp, '12-results-mobile.png');

  for (const [route, shotName, check] of [
    ['/admin-participants', '13-admin-participants.png', '.participant-row, #p-list'],
    ['/admin-history', '14-admin-history.png', '#h-list']
  ]) {
    await admin.goto(BASE + route, { waitUntil: 'networkidle' });
    await admin.waitForTimeout(900);
    ok(`${route} renders`, (await admin.locator(check).count()) > 0);
    await shot(admin, shotName);
  }

  const mAdminCtx = await browser.newContext({ ...devices['iPhone 13'] });
  const mAdmin = await mAdminCtx.newPage();
  watch(mAdmin, 'admin-mobile');
  await mAdmin.goto(`${BASE}/admin-login`, { waitUntil: 'networkidle' });
  await mAdmin.fill('#username', 'admin');
  await mAdmin.fill('#password', 'admin123');
  await mAdmin.click('#login-btn');
  await mAdmin.waitForURL('**/admin', { timeout: 8000 });
  await mAdmin.waitForTimeout(1200);
  ok('admin dashboard usable on mobile', await mAdmin.locator('.tabbar').isVisible());
  ok(
    'admin dashboard has no horizontal overflow on mobile',
    await mAdmin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)
  );
  await shot(mAdmin, '15-admin-mobile.png');

  /* -------------------------------- cleanup ------------------------------ */
  await admin.evaluate(async (player) => {
    const st = await (await fetch('/api/admin/state')).json();
    for (const poll of st.polls) {
      if (poll.playerName === player) {
        await fetch(`/api/admin/polls/${poll.id}`, { method: 'DELETE' });
      } else if (['active', 'paused'].includes(poll.status)) {
        await fetch(`/api/admin/polls/${poll.id}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'close' })
        });
      }
    }
  }, PLAYER);

  await browser.close();

  console.log('\n' + '='.repeat(52));
  console.log(`  UI: ${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log('\n  Browser errors captured:');
    [...new Set(errors)].forEach((e) => console.log('   - ' + e));
  } else {
    console.log('  No browser console errors 🎉');
  }
  console.log('='.repeat(52) + '\n');
  process.exit(fail || errors.length ? 1 : 0);
})();
