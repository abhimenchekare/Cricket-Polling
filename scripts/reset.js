'use strict';

/**
 * DANGER: wipes all polls, votes and participants, then re-creates the
 * sample polls and the admin account. Use it before a rehearsal.
 *
 *   npm run reset -- --yes
 */

require('dotenv').config({ quiet: true });
const { init, q } = require('../server/db');

(async () => {
  if (!process.argv.includes('--yes')) {
    console.log('\nThis DELETES every poll, vote and participant in the database.');
    console.log('Re-run with:  npm run reset -- --yes\n');
    process.exit(0);
  }

  await init();
  await q('TRUNCATE votes, participant_sessions, participants, options, polls, admin_sessions, activity_log RESTART IDENTITY CASCADE');
  await q("DELETE FROM settings WHERE key <> 'schema_version'");
  await q('DELETE FROM admins');

  // Re-seed (init() only runs once per process, so reset the cached promise)
  const fresh = require.cache[require.resolve('../server/db')];
  delete require.cache[require.resolve('../server/db')];
  const db2 = require('../server/db');
  await db2.init();

  console.log('\nDatabase cleared and re-seeded with the default admin + 6 sample polls.\n');
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
