'use strict';

/**
 * Static sanity check for the Vercel setup:
 *  - vercel.json is valid and points at files that exist
 *  - every page in public/ is reachable (clean URLs or an explicit rewrite)
 *  - the serverless entry point exists and exports a handler
 *  - no leftover Socket.IO / QR references in the served files
 *
 *   node test/check-vercel-config.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${extra}`);
  }
};

console.log('\n▲ Vercel configuration check\n' + '='.repeat(46));

/* ------------------------------- vercel.json ------------------------------ */

const configPath = path.join(ROOT, 'vercel.json');
ok('vercel.json exists', fs.existsSync(configPath));

let config = null;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  ok('vercel.json is valid JSON', true);
} catch (err) {
  ok('vercel.json is valid JSON', false, err.message);
}

if (config) {
  ok('uses the Node function entry api/index.js', Boolean(config.functions?.['api/index.js']));
  ok('function maxDuration is set', Boolean(config.functions?.['api/index.js']?.maxDuration));
  ok('cleanUrls enabled', config.cleanUrls === true);
  ok(
    'static pages are pinned to outputDirectory "public"',
    config.outputDirectory === 'public' && fs.existsSync(path.join(ROOT, 'public', 'index.html'))
  );
  // Vercel must be told this is a static build; otherwise it hunts for a Node server
  // entrypoint (index.js/server.js/app.js) and fails with "No entrypoint found".
  ok('explicit buildCommand set (blocks Node-entrypoint detection)', typeof config.buildCommand === 'string' && config.buildCommand.length > 0);
  ok(
    'buildCommand points at an existing script',
    !!JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['vercel-build'] &&
      fs.existsSync(path.join(ROOT, 'scripts', 'vercel-build.js'))
  );
  ok('no "builds" array alongside outputDirectory (they conflict)', !Array.isArray(config.builds));
  ok(
    'all /api traffic is rewritten to the function',
    (config.rewrites || []).some((r) => r.source === '/api/(.*)' && r.destination === '/api/index')
  );
  ok(
    'API responses are marked no-store',
    (config.headers || []).some(
      (h) => h.source === '/api/(.*)' && h.headers.some((x) => x.key === 'Cache-Control')
    )
  );

  for (const r of config.rewrites || []) {
    if (!r.destination.startsWith('/api')) {
      const file = path.join(ROOT, 'public', r.destination.replace(/^\//, ''));
      ok(`rewrite ${r.source} → ${r.destination} has a matching file`, fs.existsSync(file));
    }
  }
}

/* ----------------------------- serverless entry --------------------------- */

const entry = path.join(ROOT, 'api', 'index.js');
ok('api/index.js exists', fs.existsSync(entry));
const entrySource = fs.readFileSync(entry, 'utf8');
ok('api/index.js exports the Express app', /module\.exports\s*=\s*app/.test(entrySource));

/* ---------------------------------- pages --------------------------------- */

const publicDir = path.join(ROOT, 'public');
const pages = fs.readdirSync(publicDir).filter((f) => f.endsWith('.html'));
ok('all required pages are present', pages.length >= 10, `found ${pages.length}`);

const required = [
  'index.html', // join
  'poll.html', // polling
  'vote-confirmed.html', // confirmation
  'results.html', // results
  'admin-login.html', // admin login
  'admin.html', // dashboard
  'admin-polls.html', // create/manage
  'admin-participants.html', // participants
  'admin-history.html', // history/reports
  'display.html' // big screen
];
for (const page of required) {
  ok(`page present: ${page}`, pages.includes(page));
}

/* ------------------------ no sockets / no QR leftovers -------------------- */

const filesToScan = [];
for (const f of fs.readdirSync(path.join(publicDir, 'js'))) filesToScan.push(path.join(publicDir, 'js', f));
for (const f of pages) filesToScan.push(path.join(publicDir, f));

let socketRefs = 0;
let qrRefs = 0;
for (const file of filesToScan) {
  const text = fs.readFileSync(file, 'utf8');
  if (/socket\.io|window\.io\(|connectSocket/.test(text)) socketRefs++;
  if (/qrDataUrl|qrcode|scan the QR|QR code/i.test(text)) qrRefs++;
}
ok('no Socket.IO references left in the frontend', socketRefs === 0, `${socketRefs} file(s)`);
ok('no QR-code references left in the frontend', qrRefs === 0, `${qrRefs} file(s)`);

/* --------------------------------- package -------------------------------- */

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
ok('pg driver is a runtime dependency', Boolean(pkg.dependencies.pg));
ok('socket.io is not a dependency', !pkg.dependencies['socket.io'] && !pkg.dependencies['socket.io-client']);
ok('better-sqlite3 is not a dependency', !pkg.dependencies['better-sqlite3']);
ok('express is a dependency', Boolean(pkg.dependencies.express));

console.log('\n' + '='.repeat(46));
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(46) + '\n');
process.exit(fail ? 1 : 0);
