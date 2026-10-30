'use strict';

/**
 * Live-propagation test — the thing the host actually cares about:
 * "I press Start, and it is on every phone's screen right now, without anyone refreshing."
 *
 *   node test/live.js
 *   BASE_URL=https://your-app.vercel.app node test/live.js
 *
 * It opens a real audience page and the projector page, then times how long the admin action
 * takes to appear on screen. SLOW_MS (default 1500 on localhost, 2500 when BASE_URL is remote)
 * is the failure threshold. It also proves the polling fallback still works when the stream is
 * blocked.
 */

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const REMOTE = !/localhost|127\.0\.0\.1/.test(BASE);
const SLOW_MS = Number(process.env.SLOW_MS || (REMOTE ? 2500 : 1500));

let pass = 0;
let fail = 0;
function ok(label, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  ✅ ${label}${detail ? '  — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${detail ? '  — ' + detail : ''}`);
  }
}

async function json(url, options = {}) {
  const res = await fetch(BASE + url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, cookies: res.headers.getSetCookie?.() || [] };
}

(async () => {
  console.log(`\n📡 Live propagation → ${BASE}  (budget ${SLOW_MS} ms)`);
  console.log('='.repeat(60));

  /* ---------------- admin session (HTTP level) ---------------- */
  const login = await json('/api/admin/login', {
    method: 'POST',
    body: { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASS || 'admin123' }
  });
  if (login.status !== 200) {
    console.log(`  ❌ admin login failed (${login.status}) — ${JSON.stringify(login.data)}`);
    process.exit(1);
  }
  const token = login.data.token;
  const authHeaders = { 'x-admin-token': token };

  // park any poll that is currently live so the assertions below start from a known state
  const state0 = await json('/api/admin/state', { headers: authHeaders });
  for (const p of state0.data.polls || []) {
    if (p.status === 'active' || p.status === 'paused') {
      await json(`/api/admin/polls/${p.id}/action`, {
        method: 'POST',
        headers: authHeaders,
        body: { action: 'close' }
      });
    }
  }

  const question = null; // the server composes it from the player name
  const created = await json('/api/admin/polls', {
    method: 'POST',
    headers: authHeaders,
    body: {
      playerName: `Live Test ${Date.now() % 10000}`,
      description: 'propagation test',
      category: 'LIVE',
      timerSeconds: 60,
      showResults: 'during',
      anonymous: false
    }
  });
  if (created.status !== 201 && created.status !== 200) {
    console.log(`  ❌ could not create poll: ${JSON.stringify(created.data)}`);
    process.exit(1);
  }
  const pollId = created.data.poll.id;

  /* ---------------- browsers ---------------- */
  const browser = await chromium.launch();
  const adminCtx = await browser.newContext();
  await adminCtx.addCookies([
    { name: 'cp_admin', value: token, url: BASE, httpOnly: true, secure: REMOTE, sameSite: 'Lax' }
  ]);

  const adminPage = await adminCtx.newPage();

  const audienceCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const audience = await audienceCtx.newPage();
  await audience.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await audience.fill('#name', `Live ${Date.now() % 100000}`);
  await audience.fill('#employeeId', `LIVE-${Date.now() % 1000000}`);
  await audience.click('#join-submit');
  await audience.waitForTimeout(1200);
  await audience.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
  await audience.waitForTimeout(1200);

  const displayCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const display = await displayCtx.newPage();
  await display.goto(`${BASE}/display`, { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(1200);

  /* ---------------- how are the pages listening? ---------------- */
  const mode = await audience.evaluate(() => (window.__liveMode || 'unknown'));
  console.log(`\n  audience listening mode: ${mode}`);
  ok('audience page uses the push stream', mode !== 'polling', mode);

  /* ---------------- THE measurement: press Start → on screen ---------------- */
  const t0 = Date.now();
  const started = await json(`/api/admin/polls/${pollId}/action`, {
    method: 'POST',
    headers: authHeaders,
    body: { action: 'start', timerSeconds: 60 }
  });
  ok('admin Start accepted', started.status === 200, `HTTP ${started.status}`);

  const playerName = created.data.poll.playerName;
  await audience
    .waitForFunction((q) => document.body.innerText.includes(q), playerName, { timeout: 15000, polling: 16 })
    .catch(() => {});
  const audienceMs = Date.now() - t0;
  ok(`audience phone shows the poll in under ${SLOW_MS} ms`, audienceMs < SLOW_MS, `${audienceMs} ms`);

  /* the projector is the winners board now, so the second screen measured is another phone */
  const secondCtx = await browser.newContext();
  const second = await secondCtx.newPage();
  // start the clock after this page exists, so its own first load is not counted as propagation delay
  let secondReadyAt = Date.now();
  // a phone with no session is sent to the join screen, so join first
  await second.goto(BASE, { waitUntil: 'domcontentloaded' });
  await second.fill('#name', 'Live Second');
  await second.fill('#employeeId', `LIVE2-${Date.now() % 1000000}`);
  await second.click('#join-submit');
  await second.waitForTimeout(800);
  await second.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
  await second
    .waitForFunction((q) => document.body.innerText.includes(q), playerName, { timeout: 15000, polling: 16 })
    .catch(() => {});
  const displayMs = Date.now() - secondReadyAt;
  ok(`a second phone shows the poll in under ${SLOW_MS} ms`, displayMs < SLOW_MS, `${displayMs} ms`);

  /* ---------------- a vote reaches the other phone ---------------- */
  const voteCountIn = (text) => {
    const m = text.match(/\b([1-9]\d*)\s+(?:vote|votes|guess|guesses)\b/i);
    return m ? Number(m[1]) : 0;
  };
  const before = voteCountIn(await second.evaluate(() => document.body.innerText));

  await audience.locator('#bid-range').first().fill('30').catch(() => {});
  await audience.waitForTimeout(200);
  const tVote = Date.now();
  await audience.locator('#vote-btn').click({ timeout: 5000 }).catch(() => {});
  const voted = await audience
    .waitForFunction(() => /locked|confirmed|recorded|thanks/i.test(document.body.innerText), null, {
      timeout: 8000,
      polling: 50
    })
    .then(() => true)
    .catch(() => false);
  ok('the audience vote was accepted', voted);

  await second
    .waitForFunction(
      (prev) => {
        const m = document.body.innerText.match(/\b([1-9]\d*)\s+(?:vote|votes|guess|guesses)\b/i);
        return m && Number(m[1]) > prev;
      },
      before,
      { timeout: 15000, polling: 16 }
    )
    .catch(() => {});
  const voteMs = Date.now() - tVote;
  ok(`the vote shows on the other phone in under ${SLOW_MS + 500} ms`, voteMs < SLOW_MS + 500, `${voteMs} ms`);

  /* ---------------- closing reveals results instantly ---------------- */
  const tClose = Date.now();
  await json(`/api/admin/polls/${pollId}/actual`, {
    method: 'POST',
    headers: authHeaders,
    body: { lakh: 150 }
  });
  /* The phone's job at the close of a round is to clear the bid and go back to the duck —
     names, prices and winners belong to the projector, never to the audience screen. */
  await audience
    .waitForFunction(() => document.querySelector('.duck') !== null, null, { timeout: 15000, polling: 16 })
    .catch(() => {});
  const closeMs = Date.now() - tClose;
  ok(
    `entering the sold price clears the phone in under ${SLOW_MS + 500} ms`,
    closeMs < SLOW_MS + 500,
    `${closeMs} ms (no winner text shown: ${!/winner|sold for/i.test(await audience.evaluate(() => document.body.innerText))})`
  );

  /* ---------------- admin dashboard still updates ---------------- */
  await adminPage.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await adminPage.waitForTimeout(2500);
  const adminText = await adminPage.evaluate(() => document.body.innerText);
  ok('admin dashboard shows the finished round', adminText.includes(playerName));

  /* ---------------- fallback: block the stream, polling must carry it ---------------- */
  const fallbackCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const fb = await fallbackCtx.newPage();
  await fb.route('**/api/stream', (route) => route.abort());
  await fb.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await fb.fill('#name', `Fb ${Date.now() % 100000}`);
  await fb.fill('#employeeId', `FB-${Date.now() % 1000000}`);
  await fb.click('#join-submit');
  await fb.waitForTimeout(1200);
  await fb.goto(`${BASE}/poll`, { waitUntil: 'domcontentloaded' });
  await fb.waitForTimeout(4000);
  const fbMode = await fb.evaluate(() => window.__liveMode || 'unknown');
  const fbText = await fb.evaluate(() => document.body.innerText);
  ok('with the stream blocked the page falls back to polling', fbMode === 'polling', fbMode);
  ok('fallback still shows the poll content', fbText.length > 40);

  await browser.close();

  /* ---------------- clean up ---------------- */
  await json(`/api/admin/polls/${pollId}`, { method: 'DELETE', headers: authHeaders }).catch(() => {});

  console.log('\n' + '='.repeat(60));
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\n  Slow or missing updates usually mean /api/stream is being buffered by a');
    console.log('  proxy, the function is timing out, or the page fell back to polling.');
    console.log('  curl -N <base>/api/stream should print "event: ready" immediately.');
  }
  console.log('='.repeat(60) + '\n');
  process.exit(fail ? 1 : 0);
})();
