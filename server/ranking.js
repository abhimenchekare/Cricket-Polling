'use strict';

/**
 * Pure scoring rules — no database, no framework, so they can be reasoned about (and tested)
 * on their own. This file decides who wins the auction; everything else just displays it.
 *
 * THE RULE (v4.0.0, chosen by the host after the "4 accurate answers" confusion):
 *
 *   Per player:  ONLY an exact bid wins. Guess the price the player actually sold for and you
 *                win that player. Nobody exact -> that player has no winners at all (the
 *                ledger still shows who came closest, as information, not as a prize).
 *                If more than three people are exact on the same player, the earliest three
 *                lock-ins take 1st/2nd/3rd.
 *
 *   Overall:     most exact bids ("right on the price") wins.
 *                tie  ->  more closest calls (how often they were nearest, exact or not)
 *                tie  ->  more top-3 finishes (then more 2nds, then more 3rds)
 *                tie  ->  smaller total distance across every round played
 *                tie  ->  alphabetical
 */

const ladder = require('./bidladder');

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

/** Winners of ONE player: the exact bids only, never "the least wrong". */
function exactWinners(ranked, limit = 3) {
  return ranked
    .filter((r) => Number(r.diffLakh) === 0)
    .slice(0, limit)
    .map((w, i) => ({ ...w, rank: i + 1 }));
}

/** The nearest guess of the round — used as information when nobody was exact. */
function closestGuess(ranked) {
  const best = ranked && ranked[0];
  if (!best) return null;
  return {
    name: best.name,
    participantId: best.participantId,
    guessLakh: best.guessLakh,
    guessLabel: best.guessLabel,
    diffLakh: best.diffLakh,
    diffLabel: best.diffLabel,
    direction: best.direction
  };
}

function buildStandings(rows) {
  const table = new Map();

  const touch = (w) => {
    const key = w.participantId;
    if (!table.has(key)) {
      table.set(key, {
        participantId: key,
        name: w.name,
        employeeId: w.employeeId,
        exact: 0,
        closest: 0,
        firsts: 0,
        seconds: 0,
        thirds: 0,
        top3: 0,
        rounds: 0,
        totalDiffLakh: 0
      });
    }
    return table.get(key);
  };

  for (const row of rows) {
    if (!row.settled || !row.ranked || !row.ranked.length) continue;

    /* Every guesser counts — a person with right bids but no "closest call" still belongs on
       the board, and so does everyone chasing them. */
    for (const g of row.ranked) {
      const entry = touch(g);
      entry.rounds += 1;
      entry.totalDiffLakh += g.diffLakh;
      if (Number(g.diffLakh) === 0) entry.exact += 1;
      if (g.rank === 1) entry.closest += 1;
      if (g.rank === 1) entry.firsts += 1;
      else if (g.rank === 2) entry.seconds += 1;
      else if (g.rank === 3) entry.thirds += 1;
      if (g.rank <= 3) entry.top3 += 1;
    }
  }

  return [...table.values()]
    .map((entry) => ({
      ...entry,
      // the number the projector shows: exact bids
      rightBids: entry.exact,
      // the tie-break, shown smaller underneath
      nearest: entry.closest,
      accurate: entry.closest,
      points: entry.exact * 5 + entry.closest * 2 + entry.top3,
      wins: entry.exact,
      avgDiffLakh: entry.rounds ? Math.round(entry.totalDiffLakh / entry.rounds) : 0
    }))
    .map((entry) => ({
      ...entry,
      avgDiffLabel: entry.avgDiffLakh ? ladder.label(entry.avgDiffLakh) : null
    }))
    /* THE RULE: most right-on-the-price bids wins; closest calls only break the tie. */
    .sort(
      (a, b) =>
        b.exact - a.exact ||
        b.closest - a.closest ||
        b.top3 - a.top3 ||
        b.seconds - a.seconds ||
        b.thirds - a.thirds ||
        a.totalDiffLakh - b.totalDiffLakh ||
        a.name.localeCompare(b.name)
    )
    .map((entry, i) => ({ ...entry, rank: i + 1 }));
}

module.exports = { rankGuesses, buildStandings, exactWinners, closestGuess };
