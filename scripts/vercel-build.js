#!/usr/bin/env node
/**
 * Vercel build step.
 *
 * This project is a static site (`public/`) plus one serverless function (`api/index.js`).
 * There is nothing to compile — but we DO run a real build command because that is what
 * tells Vercel "this is a static output directory", instead of its zero-config guessing
 * that tries to find a Node server entrypoint (`index.js`, `server.js`, ...) and fails with
 * "Error: No entrypoint found".
 *
 * It also fails fast with a readable message if the repo layout is wrong, rather than
 * silently deploying a 404 site.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function fail(msg) {
  console.error('\n[vercel-build] BUILD FAILED\n' + msg + '\n');
  process.exit(1);
}

if (!fs.existsSync(PUBLIC) || !fs.statSync(PUBLIC).isDirectory()) {
  fail(
    'Missing folder: public/\n' +
      'Expected the repository root to contain: api/  public/  server/  package.json  vercel.json\n' +
      'If your files are inside a sub-folder, set Vercel → Settings → General → Root Directory to that folder.'
  );
}

if (!fs.existsSync(path.join(PUBLIC, 'index.html'))) {
  fail('Missing file: public/index.html (the participant join page).');
}
if (!fs.existsSync(path.join(ROOT, 'api', 'index.js'))) {
  fail('Missing file: api/index.js (the serverless backend).');
}

const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
for (const p of pages) {
  if (!fs.statSync(path.join(PUBLIC, p)).size) fail('Empty page: public/' + p);
}

// The backend must load without a database connection at build time; just syntax-check it.
for (const f of ['api/index.js', 'server/app.js', 'server/db.js', 'server/routes/public.js', 'server/routes/admin.js']) {
  const file = path.join(ROOT, f);
  if (!fs.existsSync(file)) fail('Missing file: ' + f);
  try {
    new Function(fs.readFileSync(file, 'utf8')); // parse only
  } catch (e) {
    fail('Syntax error in ' + f + ': ' + e.message);
  }
}

console.log('[vercel-build] OK');
console.log('  static output : public/ (' + pages.length + ' pages)');
console.log('  function      : api/index.js');
console.log('  database      : ' + (process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL ? 'DATABASE_URL present' : 'NOT SET — /api/health will report hasDatabase:false'));
