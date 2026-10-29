'use strict';

/**
 * Local development server — mirrors the Vercel behaviour (API + static pages)
 * so you can test everything before deploying.
 *
 *   node dev-server.js          (or: npm run dev)
 */

require('dotenv').config?.();
const app = require('./server/app');
const { init } = require('./server/db');

const PORT = Number(process.env.PORT || 4000);

(async () => {
  try {
    await init();
    console.log('[db] schema ready');
  } catch (err) {
    console.error('\n[db] Could not initialise the database.');
    console.error('     Set DATABASE_URL in .env (Neon / Vercel Postgres / Supabase).');
    console.error('     ' + err.message + '\n');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🏏  Cricket Auction — Live Polling (local dev)`);
    console.log(`    Join page    : http://localhost:${PORT}/`);
    console.log(`    Admin panel  : http://localhost:${PORT}/admin-login`);
    console.log(`    Big screen   : http://localhost:${PORT}/display`);
    console.log(`    Health check : http://localhost:${PORT}/api/health\n`);
  });
})();
