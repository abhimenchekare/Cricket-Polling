'use strict';

/**
 * Prints what is currently in the database and makes sure the schema exists.
 *
 *   npm run seed
 */

require('dotenv').config({ quiet: true });
const { init, q, scalar } = require('../server/db');

(async () => {
  await init();
  const admins = await q('SELECT username FROM admins');
  const polls = await q('SELECT id, question, status FROM polls ORDER BY id');
  const participants = Number(await scalar('SELECT COUNT(*)::int AS c FROM participants'));
  const votes = Number(await scalar('SELECT COUNT(*)::int AS c FROM votes'));

  console.log('\nDatabase ready.');
  console.log('Admins      :', admins.map((a) => a.username).join(', ') || 'none');
  console.log('Participants:', participants);
  console.log('Votes       :', votes);
  console.log('Polls       :', polls.length);
  for (const p of polls) console.log(`  #${p.id} [${p.status}] ${p.question}`);
  console.log('\nSign in at /admin-login\n');
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
