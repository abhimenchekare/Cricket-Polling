'use strict';

/**
 * Adds realistic demo participants + votes so you can rehearse the big
 * screen and reports before the real event.
 *
 *   npm run demo-data
 *   npm run demo-data -- --clean
 *
 * Demo rows use employee IDs starting with "DEMO-".
 * It also loads a 10-player auction list (see /admin/players) so you can rehearse
 * the SHOUT button in the real bidding order.
 */

require('dotenv').config({ quiet: true });
const { init, q } = require('../server/db');

const DEMO_PLAYERS = [
  ['Rohit Sharma', 'Batter', 200],
  ['Jasprit Bumrah', 'Bowler', 200],
  ['Virat Kohli', 'Batter', 200],
  ['Hardik Pandya', 'All-rounder', 150],
  ['Rishabh Pant', 'Wicketkeeper', 150],
  ['Ravindra Jadeja', 'All-rounder', 125],
  ['Suryakumar Yadav', 'Batter', 100],
  ['KL Rahul', 'Wicketkeeper', 100],
  ['Mohammed Siraj', 'Bowler', 75],
  ['Shubman Gill', 'Batter', 75]
];

const DEMO_PEOPLE = [
  ['Aarav Mehta', 'DEMO-01', 'Mumbai Mavericks'],
  ['Priya Sharma', 'DEMO-02', 'Pune Panthers'],
  ['Rahul Nair', 'DEMO-03', 'Delhi Dynamos'],
  ['Sneha Kulkarni', 'DEMO-04', 'Pune Panthers'],
  ['Vikram Rao', 'DEMO-05', 'Bangalore Blasters'],
  ['Ananya Iyer', 'DEMO-06', 'Chennai Chargers'],
  ['Karan Patel', 'DEMO-07', 'Mumbai Mavericks'],
  ['Meera Joshi', 'DEMO-08', 'Pune Panthers'],
  ['Aditya Verma', 'DEMO-09', 'Delhi Dynamos'],
  ['Neha Gupta', 'DEMO-10', 'Bangalore Blasters'],
  ['Siddharth Menon', 'DEMO-11', 'Chennai Chargers'],
  ['Riya Desai', 'DEMO-12', 'Mumbai Mavericks'],
  ['Arjun Singh', 'DEMO-13', 'Pune Panthers'],
  ['Tanvi Bhatt', 'DEMO-14', 'Delhi Dynamos'],
  ['Nikhil Shetty', 'DEMO-15', 'Bangalore Blasters'],
  ['Isha Agarwal', 'DEMO-16', 'Chennai Chargers'],
  ['Rohan Chakraborty', 'DEMO-17', 'Mumbai Mavericks'],
  ['Divya Pillai', 'DEMO-18', 'Pune Panthers'],
  ['Yash Thakur', 'DEMO-19', 'Delhi Dynamos'],
  ['Aisha Khan', 'DEMO-20', 'Bangalore Blasters']
];

async function addPlayers() {
  let added = 0;
  for (let i = 0; i < DEMO_PLAYERS.length; i++) {
    const [name, role, base] = DEMO_PLAYERS[i];
    const res = await q(
      `INSERT INTO auction_players (name, role, base_lakh, position, status, created_at)
       SELECT $1, $2, $3, COALESCE((SELECT MAX(position) + 1 FROM auction_players), 1), 'queued', $4
       WHERE NOT EXISTS (SELECT 1 FROM auction_players WHERE lower(name) = lower($1))
       RETURNING id`,
      [name, role, base, Date.now()]
    );
    if (res.length) added++;
  }
  console.log(
    added
      ? `Added ${added} player(s) to the auction list — open /admin/players to see the bidding order.`
      : 'The auction list already has these players — nothing added.'
  );
}

async function clean() {
  const ids = DEMO_PEOPLE.map((p) => p[1]);
  const removed = await q(
    `DELETE FROM participants WHERE employee_id = ANY($1::text[]) RETURNING id`,
    [ids]
  );
  console.log(`Removed ${removed.length} demo participants (and their votes).`);
}

async function seed() {
  const now = Date.now();
  for (const [name, id, team] of DEMO_PEOPLE) {
    await q(
      `INSERT INTO participants (name, employee_id, team, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (LOWER(employee_id)) DO NOTHING`,
      [name, id, team, now - Math.floor(Math.random() * 3_600_000)]
    );
  }

  const people = await q("SELECT id FROM participants WHERE employee_id LIKE 'DEMO-%'");
  const polls = await q("SELECT * FROM polls WHERE status IN ('active','closed')");
  if (!polls.length) {
    console.log('No active/closed polls yet — start a poll first, then run this again.');
    return;
  }

  let votes = 0;
  for (const poll of polls) {
    const options = await q(
      'SELECT id FROM options WHERE poll_id = $1 ORDER BY position',
      [poll.id]
    );
    if (!options.length) continue;

    // Weighted distribution so the bars look natural, not uniform
    const weights = options.map((_, i) => Math.max(1, options.length - i + Math.round(Math.random() * 3)));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const shuffled = [...people].sort(() => Math.random() - 0.5).slice(0, Math.round(people.length * 0.85));

    for (const person of shuffled) {
      let r = Math.random() * totalWeight;
      let choice = options[0].id;
      for (let i = 0; i < options.length; i++) {
        r -= weights[i];
        if (r <= 0) {
          choice = options[i].id;
          break;
        }
      }
      const res = await q(
        `INSERT INTO votes (poll_id, option_id, participant_id, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (poll_id, participant_id) DO NOTHING
         RETURNING id`,
        [poll.id, choice, person.id, now - Math.floor(Math.random() * 600_000)]
      );
      votes += res.length;
    }
  }
  console.log(`Added ${DEMO_PEOPLE.length} demo participants and ${votes} votes across ${polls.length} poll(s).`);
  console.log('Remove them later with:  npm run demo-data -- --clean');
}

(async () => {
  await init();
  if (process.argv.includes('--clean')) await clean();
  else {
    await seed();
    await addPlayers();
  }
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
