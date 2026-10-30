'use strict';

/**
 * 🧮 Scoring rules — pure tests, no database, no browser.
 *
 *   node test/ranking.js
 *
 * This is the file that decides who wins the auction, so it is tested on its own, with the exact
 * scenario the host described: 70 players, one participant nearest on 65 of them, another on 60.
 */

const ranking = require('../server/ranking');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
};

console.log('\n🧮 Scoring rules\n' + '='.repeat(58));

/* ---------------------------------------------------------------- */
/* 1. Per player: is "closest to the sold price" ranked correctly?  */
/* ---------------------------------------------------------------- */
console.log('\n1️⃣  One player sells — who is 1st, 2nd, 3rd');
const guesses = [
  { participant_id: 1, name: 'Priya', employee_id: 'E1', guess_lakh: 300, created_at: 5 }, // exact
  { participant_id: 2, name: 'Rahul', employee_id: 'E2', guess_lakh: 325, created_at: 3 }, // 25 off
  { participant_id: 3, name: 'Amit', employee_id: 'E3', guess_lakh: 275, created_at: 4 }, // 25 off
  { participant_id: 4, name: 'Neha', employee_id: 'E4', guess_lakh: 350, created_at: 2 }, // 50 off
  { participant_id: 5, name: 'Vik', employee_id: 'E5', guess_lakh: 500, created_at: 1 } // 200 off
];
const ranked = ranking.rankGuesses(guesses, 300);
ok('1st is the exact guess', ranked[0].name === 'Priya' && ranked[0].diffLakh === 0);
ok('2nd is 25 L away', ranked[1].name === 'Rahul' && ranked[1].diffLakh === 25);
ok('equal distance goes to whoever locked in first', ranked[2].name === 'Amit' && ranked[2].diffLakh === 25);
ok('4th and 5th follow distance', ranked[3].name === 'Neha' && ranked[4].name === 'Vik');
ok('everyone gets a rank, not just the winners', ranked.length === 5 && ranked[4].rank === 5);

/* ---------------------------------------------------------------- */
/* 2. THE QUESTION: 65 nearest vs 60 nearest over 70 players        */
/* ---------------------------------------------------------------- */
console.log('\n2️⃣  70 players — 65 nearest vs 60 nearest');

/** Build 70 fake rounds where the winner list is chosen by name. */
function buildRounds(winnersByRound) {
  return winnersByRound.map((names, i) => ({
    settled: true,
    name: `Player ${i + 1}`,
    ranked: names.map((n, idx) => ({
      participantId: n.id,
      name: n.name,
      employeeId: n.eid,
      guessLakh: 1000,
      guessLabel: '10.0 Cr',
      diffLakh: idx === 0 ? 10 : idx === 1 ? 25 : 40,
      diffLabel: idx === 0 ? '10 L' : idx === 1 ? '25 L' : '40 L',
      direction: 'over',
      rank: idx + 1
    }))
  }));
}

const A = { id: 1, name: 'Audience 1', eid: 'A1' };
const B = { id: 2, name: 'Audience 2', eid: 'A2' };
const C = { id: 3, name: 'Audience 3', eid: 'A3' };

const rounds = [];
for (let i = 0; i < 70; i++) {
  if (i < 65) rounds.push([A, B, C]); // A is nearest on the first 65
  else if (i < 70) rounds.push([B, A, C]); // B is nearest on the last 5
  else rounds.push([C, B, A]);
}

const table = ranking.buildStandings(buildRounds(rounds));
const a = table.find((t) => t.name === 'Audience 1');
const b = table.find((t) => t.name === 'Audience 2');

console.log(`     Audience 1: nearest ${a.nearest} of 70 · top-3 ${a.top3} · ${a.points} pts`);
console.log(`     Audience 2: nearest ${b.nearest} of 70 · top-3 ${b.top3} · ${b.points} pts`);

ok('nearest counts are right', a.nearest === 65 && b.nearest === 5, `${a.nearest} vs ${b.nearest}`);
ok('Audience 1 wins on nearest bids', table[0].name === 'Audience 1', table[0].name);
ok('Audience 1 is ranked #1', a.rank === 1 && b.rank === 2);

/* the old points rule would also have picked A here — so test a case where they disagree */
console.log('\n3️⃣  Where the two rules disagree');
const mixed = [];
for (let i = 0; i < 60; i++) mixed.push([A, B, C]); // A nearest 60 times
for (let i = 0; i < 10; i++) mixed.push([B, C, A]); // B nearest 10 times
const t2 = ranking.buildStandings(buildRounds(mixed));
const a2 = t2.find((t) => t.name === 'Audience 1');
const b2 = t2.find((t) => t.name === 'Audience 2');
console.log(`     Audience 1: nearest ${a2.nearest} · top-3 ${a2.top3} · ${a2.points} pts`);
console.log(`     Audience 2: nearest ${b2.nearest} · top-3 ${b2.top3} · ${b2.points} pts`);
ok('most nearest bids decides', t2[0].name === 'Audience 1');
ok('count, not points, is the deciding number', a2.nearest > b2.nearest);

/* ties: same nearest count -> fewest total distance */
console.log('\n4️⃣  Ties');
const tie = ranking.buildStandings([
  {
    settled: true,
    name: 'P1',
    ranked: [
      { participantId: 1, name: 'Close', employeeId: 'x', diffLakh: 10, rank: 1, direction: 'over' },
      { participantId: 2, name: 'Far', employeeId: 'y', diffLakh: 60, rank: 2, direction: 'over' }
    ]
  },
  {
    settled: true,
    name: 'P2',
    ranked: [
      { participantId: 1, name: 'Close', employeeId: 'x', diffLakh: 200, rank: 2, direction: 'over' },
      { participantId: 2, name: 'Far', employeeId: 'y', diffLakh: 5, rank: 1, direction: 'over' }
    ]
  }
]);
ok('same number of nearest bids → smaller total miss wins', tie[0].name === 'Far', tie[0].name);
ok('tie-break detail is exposed', tie[0].totalDiffLakh === 65 && tie[1].totalDiffLakh === 210);

/* exact hits: the host's "guess 2 Cr on a 2 Cr player" case */
console.log('\n4b️⃣  Exact hits break a tie on accurate guesses');
const exactTie = ranking.buildStandings([
  {
    settled: true,
    name: 'P1',
    ranked: [
      { participantId: 1, name: 'SpotOn', employeeId: 'e', guessLakh: 200, diffLakh: 0, rank: 1, direction: 'exact' },
      { participantId: 2, name: 'NearMiss', employeeId: 'f', guessLakh: 225, diffLakh: 25, rank: 2, direction: 'over' }
    ]
  },
  {
    settled: true,
    name: 'P2',
    ranked: [
      { participantId: 1, name: 'SpotOn', employeeId: 'e', guessLakh: 210, diffLakh: 10, rank: 2, direction: 'over' },
      { participantId: 2, name: 'NearMiss', employeeId: 'f', guessLakh: 205, diffLakh: 5, rank: 1, direction: 'over' }
    ]
  }
]);
const spot = exactTie.find((x) => x.name === 'SpotOn');
const near = exactTie.find((x) => x.name === 'NearMiss');
ok('both have one accurate guess', spot.nearest === 1 && near.nearest === 1);
ok('the exact hit wins the tie', exactTie[0].name === 'SpotOn', exactTie[0].name);
ok('exact hits are counted', spot.exact === 1 && near.exact === 0);

/* unsold players must never count */
console.log('\n5️⃣  Only sold players count');
const withUnsold = ranking.buildStandings([
  {
    settled: true,
    name: 'Sold',
    ranked: [{ participantId: 9, name: 'Someone', employeeId: 'z', diffLakh: 5, rank: 1, direction: 'over' }]
  },
  { settled: false, name: 'No price yet', ranked: [] }
]);
ok('an unpriced player adds nothing', withUnsold.length === 1 && withUnsold[0].nearest === 1);

console.log('\n' + '='.repeat(58));
console.log(`  Scoring rules: ${pass} passed, ${fail} failed`);
console.log('='.repeat(58) + '\n');
process.exit(fail ? 1 : 0);
