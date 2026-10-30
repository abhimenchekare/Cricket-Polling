'use strict';

/**
 * Pure scoring rules — no database, no framework, so they can be reasoned about (and tested)
 * on their own. This file decides who wins the auction; everything else just displays it.
 *
 *   Per player:  closest guess to the sold price = 1st, next = 2nd, next = 3rd
 *                equal distance  ->  whoever locked their guess in first
 *   Overall:     the participant with the MOST accurate guesses wins — how many players they
 *                called closest of everyone (an exact hit counts here too).
 *                tie  ->  more exact hits (nailed the price to the lakh)
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
      // "accurate guesses" = how many players this person called closest of everyone (rank 1)
      nearest: entry.firsts,
      accurate: entry.firsts,
      top3: entry.firsts + entry.seconds + entry.thirds,
      points: entry.firsts * 3 + entry.seconds * 2 + entry.thirds * 1,
      wins: entry.firsts + entry.seconds + entry.thirds,
      avgDiffLakh: entry.rounds ? Math.round(entry.totalDiffLakh / entry.rounds) : 0
    }))
    .map((entry) => ({
      ...entry,
      avgDiffLabel: entry.avgDiffLakh ? ladder.label(entry.avgDiffLakh) : null
    }))
    /* The rule the host asked for: whoever has the MOST accurate guesses wins.
       Guess 2.00 Cr on a player who sells for 2.00 Cr and that is one accurate guess;
       the person with the most of them in the whole auction is 1st, then 2nd, then 3rd.
       Points are still shown, but they never decide anything. */
    .sort(
      (a, b) =>
        b.nearest - a.nearest ||
        b.exact - a.exact ||
        b.top3 - a.top3 ||
        b.seconds - a.seconds ||
        b.thirds - a.thirds ||
        a.totalDiffLakh - b.totalDiffLakh ||
        a.name.localeCompare(b.name)
    )
    .map((entry, i) => ({ ...entry, rank: i + 1 }));
}

module.exports = { rankGuesses, buildStandings };
