'use strict';

/**
 * Admin navigation / session test.
 *
 * Reproduces the reported bug: "every link or button in the admin panel sends me
 * back to the login page". Walks the whole panel like a human, clicking every nav
 * entry and every dashboard button, and asserts the session survives each one.
 *
 *   npm run dev            # terminal 1
 *   node test/ui-session.js
 */

const { chromium } = require('playwright');
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
    console.log(`  ❌ ${name} ${extra}`);
  }
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 40[13]|navigator\.vibrate/.test(m.text())) errors.push('console: ' + m.text());
  });

  console.log('\n🔐 Sign in');
  await page.goto(`${BASE}/admin-login`, { waitUntil: 'networkidle' });
  await page.fill('#username', 'admin');
  await page.fill('#password', 'admin123');
  await page.click('#login-btn');
  await page.waitForURL('**/admin', { timeout: 10000 });
  await page.waitForTimeout(1500);
  ok('logged in and landed on the dashboard', page.url().endsWith('/admin'));

  const cookies = await ctx.cookies();
  const adminCookie = cookies.find((c) => c.name === 'cp_admin');
  ok('admin cookie was stored by the browser', Boolean(adminCookie));
  ok('cookie is HttpOnly', adminCookie ? adminCookie.httpOnly : false);
  ok('cookie path is /', adminCookie ? adminCookie.path === '/' : false);

  console.log('\n🧭 Click every navigation entry (full page loads)');
  const routes = [
    { href: '/admin/polls', label: 'Polls' },
    { href: '/admin/participants', label: 'Participants' },
    { href: '/admin/history', label: 'History & reports' },
    { href: '/admin', label: 'Dashboard' }
  ];

  for (const r of routes) {
    await page.goto(BASE + r.href, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1400);
    const url = page.url();
    ok(
      `${r.label} (${r.href}) stays signed in`,
      url.includes(r.href.replace(/\/$/, '')) && !url.includes('admin-login'),
      url
    );
    const banner = await page.locator('#session-expired').count();
    ok(`${r.label} shows no session banner`, banner === 0);
  }

  console.log('\n🖱  Click in-page actions (no full reload)');
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);

  // Join-link modal
  await page.click('#show-qr');
  await page.waitForTimeout(1200);
  ok('Join link modal opens', (await page.locator('.modal').count()) === 1);
  ok('still signed in after opening a modal', !page.url().includes('admin-login'));
  await page.click('[data-close]');
  await page.waitForTimeout(400);

  // Session check (new diagnostic panel)
  await page.click('#session-check');
  await page.waitForTimeout(2000);
  const diagText = (await page.locator('#diag-body').innerText().catch(() => '')) || '';
  ok('session check panel opens', diagText.length > 20, diagText.slice(0, 40));
  ok('diag reports the admin cookie is present', /cookie present/i.test(diagText));
  await page.screenshot({ path: path.join(SHOT_DIR, 's1-session-check.png') });
  await page.click('[data-close]');
  await page.waitForTimeout(300);

  // Event settings modal
  await page.click('#event-settings');
  await page.waitForTimeout(1200);
  ok('event settings modal opens', (await page.locator('.modal').count()) === 1);
  await page.click('[data-close]').catch(() => {});
  await page.waitForTimeout(400);
  ok('still signed in after event settings', !page.url().includes('admin-login'));

  console.log('\n⏱  Survives a few polling cycles (background refreshes)');
  await page.waitForTimeout(9000);
  ok('no redirect after 9 s of live polling', !page.url().includes('admin-login'), page.url());
  const connText = (await page.locator('#admin-conn').innerText().catch(() => '')) || '';
  ok('connection indicator is healthy', /Live|Reconnect/i.test(connText), connText.replace(/\n/g, ' '));

  console.log('\n🍪 Server-side check of the same cookie');
  const cookieHeader = `cp_admin=${adminCookie.value}`;
  const me = await fetch(`${BASE}/api/admin/me`, { headers: { cookie: cookieHeader } });
  ok('/api/admin/me accepts the cookie', me.status === 200, `status ${me.status}`);
  const diag = await fetch(`${BASE}/api/diag`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
  ok('/api/diag resolves the same session', diag.request.adminCookieFoundInDatabase === true, JSON.stringify(diag.request));

  console.log('\n🚪 Sign out still works (and only then redirects)');
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.click('[data-logout]');
  await page.waitForTimeout(600);
  const confirmBtn = page.locator('.modal [data-act="ok"]');
  if (await confirmBtn.count()) await confirmBtn.click();
  await page.waitForTimeout(2500);
  ok('sign out returns to the login page', page.url().includes('admin-login'), page.url());

  /* ------------------------------------------------------------------ */
  /* Cookie-blocked browsers / proxies: the panel must still work.       */
  /* This is the extra safety net for "every button logs me out".        */
  /* ------------------------------------------------------------------ */
  console.log('\n🚫 Cookies blocked entirely (proxy / webview / privacy mode)');
  const blockedCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const bp = await blockedCtx.newPage();
  bp.on('pageerror', (e) => errors.push('cookieblocked pageerror: ' + e.message));

  // Strip every Set-Cookie header so the browser can never keep a session cookie.
  await blockedCtx.route('**/*', async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers['set-cookie'];
    await route.fulfill({ response, headers });
  });

  await bp.goto(`${BASE}/admin-login`, { waitUntil: 'networkidle' });
  await bp.fill('#username', 'admin');
  await bp.fill('#password', 'admin123');
  await bp.click('#login-btn');
  await bp.waitForURL('**/admin', { timeout: 12000 });
  await bp.waitForTimeout(1800);

  const storedToken = await bp.evaluate(() => localStorage.getItem('cp_admin_token'));
  ok('login survives with zero cookies (token stored)', Boolean(storedToken) && storedToken.length > 20);
  await blockedCtx.clearCookies(); // make certain no session cookie survives
  const cookieCount = (await blockedCtx.cookies()).filter((c) => c.name === 'cp_admin').length;
  ok('browser really has no admin cookie', cookieCount === 0);

  for (const href of ['/admin/polls', '/admin/participants', '/admin/history', '/admin']) {
    await bp.goto(BASE + href, { waitUntil: 'networkidle' });
    await bp.waitForTimeout(1500);
    const url = bp.url();
    ok(`cookie-less ${href} stays signed in`, url.includes(href.replace(/\/$/, '')) && !url.includes('admin-login'), url);
  }

  const blockedMe = await bp.evaluate(async () => {
    const r = await fetch('/api/admin/me', { headers: { 'x-admin-token': localStorage.getItem('cp_admin_token') } });
    return r.status;
  });
  ok('API authorises by header alone', blockedMe === 200, `status ${blockedMe}`);

  await blockedCtx.close();

  await browser.close();
  console.log('\n' + '='.repeat(52));
  console.log(`  Admin session: ${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log('\n  Browser errors:');
    [...new Set(errors)].forEach((e) => console.log('   - ' + e));
  } else {
    console.log('  No browser errors 🎉');
  }
  console.log('='.repeat(52) + '\n');
  process.exit(fail || errors.length ? 1 : 0);
})();
