'use strict';

/**
 * PostgreSQL access for the Vercel (serverless) edition.
 * Works with Neon, Vercel Postgres, Supabase or any hosted Postgres.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const CONNECTION_STRING =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.NEON_DATABASE_URL ||
  '';

if (!CONNECTION_STRING) {
  console.warn(
    '[db] No DATABASE_URL found. Set DATABASE_URL (Neon/Vercel Postgres/Supabase) in your environment.'
  );
}

const isLocal = /@(localhost|127\.0\.0\.1|::1)[:/]/.test(CONNECTION_STRING);

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  max: Number(process.env.PG_POOL_MAX || 3),
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  ssl: isLocal ? undefined : { rejectUnauthorized: false }
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

/**
 * Neon / serverless Postgres suspends idle databases and drops idle sockets.
 * The first query after a pause can fail with a connection error, which used to
 * surface as "not logged in" (a 401) and bounced the admin back to the login page.
 * Retry once on transient/connection errors before giving up.
 */
const TRANSIENT = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|terminated|timeout|Connection|EHOSTUNREACH|EPIPE|socket|Client has encountered a connection error|Can't reach database server|too many clients/i;

function isTransient(err) {
  if (!err) return false;
  const code = String(err.code || '');
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', '57P01', '57P03', '08006', '08003', '53300'].includes(code)) return true;
  return TRANSIENT.test(String(err.message || ''));
}

async function rawQuery(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    if (!isTransient(err)) throw err;
    console.warn('[db] transient error, retrying once:', err.message);
    await new Promise((r) => setTimeout(r, 250));
    return pool.query(text, params);
  }
}

/** Run a query and return the rows. */
async function q(text, params = []) {
  const res = await rawQuery(text, params);
  return res.rows;
}

/** Run a query and return the first row (or null). */
async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}

/** Run a query and return a single scalar value. */
async function scalar(text, params = []) {
  const row = await one(text, params);
  if (!row) return null;
  return Object.values(row)[0];
}

/* ------------------------------------------------------------------ */
/* Schema + first-run seed                                            */
/* ------------------------------------------------------------------ */

const SCHEMA_FILE = path.join(__dirname, '..', 'sql', 'schema.sql');

const DEFAULT_SETTINGS = {
  event_name: 'Cricket Auction Live Polls',
  event_tagline: 'Office Cricket Auction',
  venue_line: 'Live audience voting',
  join_requires_code: '0',
  access_code: 'AUCTION2026',
  allow_new_participants: '1',
  display_message: 'Grab your phone, pick your answer and watch the big screen!'
};

const SAMPLE_POLLS = [
  {
    question: 'Who will be the most expensive player tonight?',
    description: 'Pick the player you think will trigger the biggest bid.',
    category: 'Auction Predictions',
    options: [
      { label: 'Rohit Sharma', emoji: '🏏' },
      { label: 'Virat Kohli', emoji: '🔥' },
      { label: 'Hardik Pandya', emoji: '💪' },
      { label: 'Jasprit Bumrah', emoji: '🎯' },
      { label: 'Rishabh Pant', emoji: '⚡' }
    ]
  },
  {
    question: 'Which team will make the best picks?',
    description: 'Judge them on balance, bargains and big buys.',
    category: 'Team Battle',
    options: [
      { label: 'Mumbai Mavericks', emoji: '🌊' },
      { label: 'Pune Panthers', emoji: '🐆' },
      { label: 'Delhi Dynamos', emoji: '⚡' },
      { label: 'Bangalore Blasters', emoji: '💥' },
      { label: 'Chennai Chargers', emoji: '🦁' }
    ]
  },
  {
    question: 'Which team has the strongest squad right now?',
    description: 'One vote each — make it count.',
    category: 'Team Battle',
    options: [
      { label: 'Mumbai Mavericks', emoji: '🌊' },
      { label: 'Pune Panthers', emoji: '🐆' },
      { label: 'Delhi Dynamos', emoji: '⚡' },
      { label: 'Bangalore Blasters', emoji: '💥' }
    ]
  },
  {
    question: 'Who is the most exciting player to watch?',
    description: 'The crowd favourite — sixes, wickets or sheer drama.',
    category: 'Player Spotlight',
    options: [
      { label: 'Explosive opener', emoji: '🏏' },
      { label: 'Death-over specialist', emoji: '🎯' },
      { label: 'Finisher', emoji: '💥' },
      { label: 'Wicket-keeper batter', emoji: '🧤' },
      { label: 'Mystery spinner', emoji: '🌀' }
    ]
  },
  {
    question: 'Audience favourite player of the night?',
    description: 'Vote for the player who has the room buzzing.',
    category: 'Player Spotlight',
    options: [
      { label: 'Player of the Auction', emoji: '⭐' },
      { label: 'Best steal of the night', emoji: '💎' },
      { label: 'Most underrated pick', emoji: '🥷' },
      { label: 'Future star', emoji: '🌟' }
    ]
  },
  {
    question: 'Quick vote: how is the auction going so far?',
    description: 'Just for fun — keep the energy up!',
    category: 'Fun Poll',
    options: [
      { label: 'Absolutely electric ⚡', emoji: '⚡' },
      { label: 'Great fun 🔥', emoji: '🔥' },
      { label: 'Steady so far 🙂', emoji: '🙂' },
      { label: 'Needs more drama 🍿', emoji: '🍿' }
    ]
  }
];

let initPromise = null;

/** Creates the schema and seeds the defaults exactly once per process. */
function init() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // 1) Schema — skipped on later cold starts via a version marker (keeps cold starts fast)
    const CURRENT_SCHEMA_VERSION = '3';
    let schemaReady = false;
    try {
      const marker = await pool.query("SELECT value FROM settings WHERE key = 'schema_version' LIMIT 1");
      schemaReady = Boolean(marker.rows[0] && marker.rows[0].value === CURRENT_SCHEMA_VERSION);
    } catch {
      schemaReady = false; // table does not exist yet
    }

    if (!schemaReady) {
      const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
      await pool.query(schema);
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('schema_version', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [CURRENT_SCHEMA_VERSION]
      );
    }

    // 2) Seed — always checked (a few cheap queries) so a wiped database
    //    is repaired automatically instead of silently staying empty.
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        [key, String(value)]
      );
    }

    const adminCount = Number(await scalar('SELECT COUNT(*)::int AS c FROM admins'));
    if (adminCount === 0) {
      const bcrypt = require('bcryptjs');
      const username = process.env.ADMIN_USERNAME || 'admin';
      const password = process.env.ADMIN_PASSWORD || 'admin123';
      await pool.query(
        'INSERT INTO admins (username, password_hash, display_name, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO NOTHING',
        [username, bcrypt.hashSync(password, 10), process.env.ADMIN_DISPLAY_NAME || 'Auction Control Room', Date.now()]
      );
      console.log(`[db] Created admin account "${username}"`);
    }

    const pollCount = Number(await scalar('SELECT COUNT(*)::int AS c FROM polls'));
    if (pollCount === 0) {
      const now = Date.now();
      for (const poll of SAMPLE_POLLS) {
        const row = await one(
          `INSERT INTO polls (question, description, category, status, show_results, anonymous,
                              timer_seconds, remaining_ms, created_at, updated_at, created_by)
           VALUES ($1, $2, $3, 'draft', 'after', 0, 30, 30000, $4, $4, 'seed')
           RETURNING id`,
          [poll.question, poll.description, poll.category, now]
        );
        for (let i = 0; i < poll.options.length; i++) {
          await pool.query(
            'INSERT INTO options (poll_id, label, emoji, position) VALUES ($1, $2, $3, $4)',
            [row.id, poll.options[i].label, poll.options[i].emoji || null, i]
          );
        }
      }
      console.log(`[db] Seeded ${SAMPLE_POLLS.length} sample polls (drafts)`);
    }

    return true;
  })().catch((err) => {
    initPromise = null; // allow a retry on the next request
    throw err;
  });

  return initPromise;
}

/** Express middleware: guarantees the schema exists before handling a request. */
function ensureInit(req, res, next) {
  init()
    .then(() => next())
    .catch((err) => {
      console.error('[db] init failed', err);
      res.status(500).json({ error: 'Database not ready. Check DATABASE_URL on the server.' });
    });
}

/* ------------------------------------------------------------------ */
/* Activity log                                                        */
/* ------------------------------------------------------------------ */

async function logActivity(action, detail, actor = 'admin') {
  try {
    await pool.query(
      'INSERT INTO activity_log (actor, action, detail, created_at) VALUES ($1, $2, $3, $4)',
      [actor, action, detail || null, Date.now()]
    );
  } catch (err) {
    console.error('[log] failed', err.message);
  }
}

module.exports = {
  isTransient, pool, q, one, scalar, init, ensureInit, logActivity, DEFAULT_SETTINGS, SAMPLE_POLLS };
