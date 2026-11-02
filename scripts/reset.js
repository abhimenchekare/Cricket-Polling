'use strict';

/**
 * DANGER: wipes all polls, votes and participants, then re-creates the default
 * admin account (and nothing else — v4.3.0 seeds no sample polls).
 * Use it on the morning of the event to start from a clean database.
 *
 *   npm run reset -- --yes
 */

require('dotenv').config({ quiet: true });
const { init, q } = require('../server/db');

(async () => {
  if (!process.argv.includes('--yes')) {
    console.log('\nThis DELETES every poll, vote and participant in the database. It also clears the');
  console.log('auction player list, so paste your player list again afterwards.');
    console.log('Re-run with:  npm run reset -- --yes\n');
    process.exit(0);
  }

  await init();
  await q('TRUNCATE votes, participant_sessions, participants, options, polls, admin_sessions, activity_log RESTART IDENTITY CASCADE');
  await q('DELETE FROM auction_players');
  await q("DELETE FROM settings WHERE key <> 'schema_version'");
  await q('DELETE FROM admins');

  // Re-seed (init() only runs once per process, so reset the cached promise)
  const fresh = require.cache[require.resolve('../server/db')];
  delete require.cache[require.resolve('../server/db')];
  const db2 = require('../server/db');
  await db2.init();

  console.log('\nDatabase cleared. The default admin account is back and the polls table is EMPTY');
  console.log('(v4.3.0 no longer seeds sample drafts — your rounds are created by SHOUT).');
  console.log('Paste your auction list in /admin/players and you are ready.\n');
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
