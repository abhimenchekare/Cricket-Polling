'use strict';

/**
 * Route smoke test — catches the class of bug where a pretty URL silently serves the
 * WRONG page (e.g. /admin/polls returning the participant join page because a
 * vercel.json rewrite pointed at "*.html" and cleanUrls redirected it).
 *
 * Works against local dev and against a live deployment:
 *
 *   node test/routes.js
 *   BASE_URL=https://your-app.vercel.app node test/routes.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:4000';

/** path -> a string that MUST appear in <title> */
const ROUTES = [
  ['/', 'Join Live Polls'],
  ['/join', 'Join Live Polls'],
  ['/poll', 'Live Poll'],
  ['/results', 'Poll Results'],
  ['/display', 'Big Screen'],
  ['/admin-login', 'Admin Login'],
  ['/admin', 'Admin Dashboard'],
  ['/admin/polls', 'Manage Polls'],
  ['/admin/participants', 'Participants'],
  ['/admin/history', 'History'],
  ['/admin-polls', 'Manage Polls'],
  ['/admin-participants', 'Participants'],
  ['/admin-history', 'History'],
  ['/admin/players', 'Auction list'],
  ['/admin-players', 'Auction list'],
  ['/admin/results', 'Results ledger'],
  ['/admin-results', 'Results ledger']
];

let pass = 0;
let fail = 0;
const failures = [];

(async () => {
  console.log(`\n🧭 Route check → ${BASE}\n${'='.repeat(54)}`);

  for (const [path, expected] of ROUTES) {
    let status = 0;
    let title = '';
    try {
      const res = await fetch(BASE + path, { redirect: 'follow' });
      status = res.status;
      const html = await res.text();
      title = (html.match(/<title>([^<]*)/) || [, ''])[1].trim();
    } catch (err) {
      title = `ERROR ${err.message}`;
    }
    const okStatus = status === 200;
    const okTitle = title.toLowerCase().includes(expected.toLowerCase());
    if (okStatus && okTitle) {
      pass++;
      console.log(`  ✅ ${path.padEnd(22)} ${status}  ${title}`);
    } else {
      fail++;
      failures.push(path);
      console.log(`  ❌ ${path.padEnd(22)} ${status}  got "${title}" (expected to contain "${expected}")`);
    }
  }

  /* the APIs the pages depend on */
  console.log('\n🔌 API endpoints');
  const apis = [
    ['/api/health', (d) => d.ok === true && typeof d.build === 'string', 'health + build id'],
    ['/api/meta', (d) => d.bid && d.bid.ladder.length === 81, 'bid ladder exposed'],
    ['/api/state', (d) => 'poll' in d, 'public state'],
    ['/api/diag', (d) => d.database && 'reachable' in d.database, 'diagnostics']
  ];
  for (const [path, check, label] of apis) {
    try {
      const res = await fetch(BASE + path);
      const data = await res.json();
      if (res.ok && check(data)) {
        pass++;
        console.log(`  ✅ ${label}`);
      } else {
        fail++;
        failures.push(path);
        console.log(`  ❌ ${label} — status ${res.status}`);
      }
    } catch (err) {
      fail++;
      failures.push(path);
      console.log(`  ❌ ${label} — ${err.message}`);
    }
  }

  console.log(`\n${'='.repeat(54)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\n  Broken routes:');
    failures.forEach((f) => console.log('   - ' + f));
    console.log('\n  If a /admin/* path shows the wrong page, the deployment is stale or a');
    console.log('  vercel.json rewrite points at "*.html" (cleanUrls redirects those).');
  }
  console.log(`${'='.repeat(54)}\n`);
  process.exit(fail ? 1 : 0);
})();
