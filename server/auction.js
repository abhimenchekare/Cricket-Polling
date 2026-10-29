'use strict';

/**
 * The auction roster: the ordered list of players the host shouts from.
 *
 *   queued   → waiting to be called
 *   on_block → shouted, the bid round for this player is running
 *   sold     → host entered the hammer price
 *   unsold   → skipped / no bids
 *   skipped  → deliberately passed over
 *
 * Shouting is one action: take the next queued player, create the price-guess round for them,
 * start it, and mark them on_block. Every phone gets it through the live stream.
 */

const { q, one, scalar, logActivity } = require('./db');

const STATUS = {
  QUEUED: 'queued',
  ON_BLOCK: 'on_block',
  SOLD: 'sold',
  UNSOLD: 'unsold',
  SKIPPED: 'skipped'
};

function cleanName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** "Rohit Sharma" -> the question the audience reads. */
function questionFor(playerName) {
  return `What will be the bid range for ${playerName} player?`;
}

async function list() {
  return q(
    `SELECT p.*,
            (SELECT COUNT(*)::int FROM votes v WHERE v.poll_id = p.poll_id) AS guess_count
       FROM auction_players p
      ORDER BY p.position ASC, p.id ASC`
  );
}

/** The player currently on the block (there is at most one). */
async function onBlock() {
  return one(
    `SELECT * FROM auction_players
      WHERE status = 'on_block'
      ORDER BY shouted_at DESC NULLS LAST, id DESC LIMIT 1`
  );
}

/** Everyone still waiting, in shout order. */
async function queue(limit) {
  const rows = await q(
    `SELECT * FROM auction_players WHERE status = 'queued' ORDER BY position ASC, id ASC
      ${limit ? 'LIMIT ' + Number(limit) : ''}`
  );
  return rows;
}

async function counts() {
  const row = await one(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'queued')::int   AS queued,
            COUNT(*) FILTER (WHERE status = 'on_block')::int AS on_block,
            COUNT(*) FILTER (WHERE status = 'sold')::int     AS sold,
            COUNT(*) FILTER (WHERE status = 'unsold')::int   AS unsold,
            COUNT(*) FILTER (WHERE status = 'skipped')::int  AS skipped
       FROM auction_players`
  );
  return {
    total: Number(row.total || 0),
    queued: Number(row.queued || 0),
    onBlock: Number(row.on_block || 0),
    sold: Number(row.sold || 0),
    unsold: Number(row.unsold || 0),
    skipped: Number(row.skipped || 0)
  };
}

/** Highest position in the roster, so new names land at the end. */
async function maxPosition() {
  const value = await scalar('SELECT COALESCE(MAX(position), 0)::int AS c FROM auction_players');
  return Number(value || 0);
}

/**
 * Add players from a pasted list ("one per line" or "Name, Role, 20 L").
 * Duplicate names already in the roster are ignored, so re-pasting is harmless.
 */
async function addMany(rawEntries) {
  const existing = new Set(
    (await q('SELECT LOWER(name) AS n FROM auction_players')).map((r) => r.n)
  );
  let position = await maxPosition();
  const now = Date.now();
  const added = [];
  const skipped = [];

  for (const entry of rawEntries) {
    const parts = String(entry)
      .split(/[,;\t|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const name = cleanName(parts[0]);
    if (!name) continue;
    if (existing.has(name.toLowerCase())) {
      skipped.push(name);
      continue;
    }
    const role = parts[1] ? cleanName(parts[1]).slice(0, 40) : null;
    const base = parts[2] ? require('./bidladder').parsePrice(parts[2]) : null;
    position += 1;
    const row = await one(
      `INSERT INTO auction_players (name, role, base_lakh, position, status, created_at)
       VALUES ($1, $2, $3, $4, 'queued', $5) RETURNING *`,
      [name, role, base, position, now]
    );
    existing.add(name.toLowerCase());
    added.push(row);
  }

  if (added.length) {
    await logActivity(
      'auction.players_added',
      `Added ${added.length} player${added.length === 1 ? '' : 's'} to the auction list`,
      'admin'
    );
  }
  return { added, skipped };
}

async function rename(id, { name, role }) {
  const row = await one(
    `UPDATE auction_players SET name = COALESCE($1, name), role = COALESCE($2, role) WHERE id = $3 RETURNING *`,
    [name ? cleanName(name) : null, role ? cleanName(role).slice(0, 40) : null, id]
  );
  return row;
}

async function removePlayer(id) {
  return one('DELETE FROM auction_players WHERE id = $1 RETURNING id', [id]);
}

/** Apply an explicit order (array of ids in shout order). */
async function reorder(ids) {
  const now = Date.now();
  for (let i = 0; i < ids.length; i++) {
    await q('UPDATE auction_players SET position = $1 WHERE id = $2', [i + 1, Number(ids[i])]);
  }
  await logActivity('auction.reordered', 'Reordered the auction list', 'admin');
  return list();
}

/**
 * Move one player up (-1) or down (+1) in the shout order. Used by the small ↑↓ buttons so the
 * host can fix the sequence without re-pasting the whole list.
 */
async function nudge(id, delta) {
  const rows = await q('SELECT id, position FROM auction_players ORDER BY position ASC, id ASC');
  const index = rows.findIndex((r) => Number(r.id) === Number(id));
  if (index < 0) return null;
  const target = index + (delta < 0 ? -1 : 1);
  if (target < 0 || target >= rows.length) return null;
  const ordered = rows.slice();
  const [moved] = ordered.splice(index, 1);
  ordered.splice(target, 0, moved);
  return reorder(ordered.map((r) => r.id));
}

/** Put a player back in the queue (used by skip / undo). */
async function requeue(id) {
  return one("UPDATE auction_players SET status = 'queued', poll_id = NULL, shouted_at = NULL WHERE id = $1 RETURNING *", [id]);
}

/** Mark the player attached to a poll as sold for a price. */
async function markSoldForPoll(pollId, lakh) {
  const row = await one('SELECT * FROM auction_players WHERE poll_id = $1', [pollId]);
  if (!row) return null;
  return one(
    `UPDATE auction_players SET status = 'sold', sold_lakh = $1, sold_at = $2 WHERE id = $3 RETURNING *`,
    [lakh, Date.now(), row.id]
  );
}

async function markUnsoldForPoll(pollId) {
  const row = await one('SELECT * FROM auction_players WHERE poll_id = $1', [pollId]);
  if (!row) return null;
  return one("UPDATE auction_players SET status = 'unsold', sold_at = $1 WHERE id = $2 RETURNING *", [
    Date.now(),
    row.id
  ]);
}

/** Reset a whole roster run: everything back to queued, nothing sold. */
async function resetAll() {
  await q("UPDATE auction_players SET status = 'queued', poll_id = NULL, sold_lakh = NULL, sold_at = NULL, shouted_at = NULL");
  await logActivity('auction.reset', 'Reset the auction queue', 'admin');
}

module.exports = {
  STATUS,
  cleanName,
  questionFor,
  list,
  onBlock,
  queue,
  counts,
  addMany,
  rename,
  removePlayer,
  reorder,
  nudge,
  requeue,
  markSoldForPoll,
  markUnsoldForPoll,
  resetAll
};
