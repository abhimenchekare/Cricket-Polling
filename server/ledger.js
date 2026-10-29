'use strict';

/**
 * 🏆 Results ledger.
 *
 * With 70 players going under the hammer one by one, the host needs one place that answers:
 *
 *   - what each player actually sold for, and who called it (1st / 2nd / 3rd closest)
 *   - which players are still waiting for a price
 *   - who is leading the room overall after N players
 *
 * Everything here is derived from votes + polls.actual_lakh, so a result is never "recomputed
 * from memory" — it is stored, and re-ranking after a price correction is automatic.
 */

const { q } = require('./db');
const ladder = require('./bidladder');

/** Rank guesses for one round: closest = 1st, then 2nd, 3rd. Ties go to whoever locked first. */
function rankGuesses(guesses, actualLakh) {
  const actual = Number(actualLakh);
  return guesses
    .map((g) => {
      const guess = Number(g.guess_lakh);
      return {
        participantId: Number(g.participant_id),
        name: g.name,
        employeeId: g.employee_id,
        guessLakh: guess,
        guessLabel: ladder.label(guess),
        diffLakh: Math.abs(guess - actual),
        diffLabel: ladder.label(Math.abs(guess - actual)),
        direction: guess === actual ? 'exact' : guess > actual ? 'over' : 'under',
        at: Number(g.created_at)
      };
    })
    .sort((a, b) => a.diffLakh - b.diffLakh || a.at - b.at || a.participantId - b.participantId)
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

/** Every player on the auction list, with their stored result and their three winners. */
async function buildLedger() {
  const players = await q(
    `SELECT ap.id, ap.name, ap.role, ap.base_lakh, ap.position, ap.status, ap.poll_id,
            ap.sold_lakh, ap.sold_at,
            p.status        AS poll_status,
            p.actual_lakh   AS actual_lakh,
            p.player_name   AS poll_player,
            (SELECT COUNT(*)::int FROM votes v WHERE v.poll_id = ap.poll_id) AS guess_count
       FROM auction_players ap
       LEFT JOIN polls p ON p.id = ap.poll_id
      ORDER BY ap.position, ap.id`
  );

  const pollIds = players.map((p) => p.poll_id).filter((x) => x != null);
  let guesses = [];
  if (pollIds.length) {
    guesses = await q(
      `SELECT v.poll_id, v.participant_id, v.guess_lakh, v.created_at, pt.name, pt.employee_id
         FROM votes v
         JOIN participants pt ON pt.id = v.participant_id
        WHERE v.poll_id = ANY($1::int[])`,
      [pollIds]
    );
  }

  const byPoll = new Map();
  for (const g of guesses) {
    if (!byPoll.has(g.poll_id)) byPoll.set(g.poll_id, []);
    byPoll.get(g.poll_id).push(g);
  }

  const rows = players.map((p) => {
    const sold = p.actual_lakh == null ? (p.sold_lakh == null ? null : Number(p.sold_lakh)) : Number(p.actual_lakh);
    const list = p.poll_id == null ? [] : byPoll.get(p.poll_id) || [];
    const ranked = sold == null ? [] : rankGuesses(list, sold);
    return {
      playerId: p.id,
      position: Number(p.position),
      name: p.name,
      role: p.role || null,
      baseLakh: p.base_lakh == null ? null : Number(p.base_lakh),
      baseLabel: p.base_lakh == null ? null : ladder.label(Number(p.base_lakh)),
      status: p.status,
      pollId: p.poll_id == null ? null : Number(p.poll_id),
      pollStatus: p.poll_status || null,
      guessCount: Number(p.guess_count || 0),
      soldLakh: sold,
      soldLabel: sold == null ? null : ladder.label(sold),
      settled: sold != null,
      winners: ranked.slice(0, 3).map((w) => ({
        rank: w.rank,
        name: w.name,
        guessLakh: w.guessLakh,
        guessLabel: w.guessLabel,
        diffLakh: w.diffLakh,
        diffLabel: w.diffLabel,
        direction: w.direction
      })),
      ranked
    };
  });

  const settledRows = rows.filter((r) => r.settled);
  const summary = {
    total: rows.length,
    settled: settledRows.length,
    awaitingPrice: rows.filter((r) => !r.settled && r.pollId != null).length,
    notShouted: rows.filter((r) => r.pollId == null && r.status === 'queued').length,
    unsold: rows.filter((r) => r.status === 'unsold').length,
    totalGuesses: rows.reduce((n, r) => n + r.guessCount, 0),
    spentLakh: settledRows.reduce((n, r) => n + (r.soldLakh || 0), 0),
    spentLabel: ladder.label(settledRows.reduce((n, r) => n + (r.soldLakh || 0), 0)),
    guessesPerRound: settledRows.length
      ? Math.round((rows.reduce((n, r) => n + r.guessCount, 0) / settledRows.length) * 10) / 10
      : 0
  };

  return { rows, summary, standings: buildStandings(rows) };
}

/**
 * Overall standings: a 1st place is worth 3 points, 2nd 2, 3rd 1 — the "closest to the bid" rule
 * applied across every player sold so far. Ties break on 1st places, then on total distance.
 */
function buildStandings(rows) {
  const table = new Map();

  for (const row of rows) {
    if (!row.settled || !row.ranked || !row.ranked.length) continue;
    for (const w of row.ranked.slice(0, 3)) {
      const key = w.participantId;
      if (!table.has(key)) {
        table.set(key, {
          participantId: key,
          name: w.name,
          employeeId: w.employeeId,
          firsts: 0,
          seconds: 0,
          thirds: 0,
          rounds: 0,
          exact: 0,
          totalDiffLakh: 0
        });
      }
      const entry = table.get(key);
      entry.rounds += 1;
      entry.totalDiffLakh += w.diffLakh;
      if (w.direction === 'exact') entry.exact += 1;
      if (w.rank === 1) entry.firsts += 1;
      else if (w.rank === 2) entry.seconds += 1;
      else entry.thirds += 1;
    }
  }

  return [...table.values()]
    .map((entry) => ({
      ...entry,
      points: entry.firsts * 3 + entry.seconds * 2 + entry.thirds * 1,
      wins: entry.firsts + entry.seconds + entry.thirds,
      avgDiffLakh: entry.rounds ? Math.round(entry.totalDiffLakh / entry.rounds) : 0
    }))
    .map((entry) => ({
      ...entry,
      avgDiffLabel: entry.avgDiffLakh ? ladder.label(entry.avgDiffLakh) : null
    }))
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.firsts - a.firsts ||
        a.totalDiffLakh - b.totalDiffLakh ||
        a.name.localeCompare(b.name)
    )
    .map((entry, i) => ({ ...entry, rank: i + 1 }));
}

module.exports = { buildLedger, buildStandings, rankGuesses };
