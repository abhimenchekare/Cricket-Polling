'use strict';

/**
 * 🧮 Scoring rules — pure tests, no database, no browser.
 *
 *   node test/ranking.js
 *
 * v4.0.0 rule, chosen by the host:
 *   - a player is won ONLY by an exact bid (right on the price). Nobody exact → no winner.
 *   - overall 1st/2nd/3rd go to the most right bids; closest calls only break the tie.
 *
 * This file is the referee for the whole auction, so every branch is pinned here.
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

console.log('\n🧮 Scoring rules (v4.0.0 — exact bids win)\n' + '='.repeat(58));

/* ------------------------------------------------------------------ */
/* 1. One player: everyone is ranked, but only the exact bid wins      */
/* ------------------------------------------------------------------ */
console.log('\n1️⃣  One player sells at 3.00 Cr');

const guesses = [
  { participant_id: 1, name: 'Priya', employee_id: 'E1', guess_lakh: 300, created_at: 5 }, // exact
  { participant_id: 2, name: 'Rahul', employee_id: 'E2', guess_lakh: 325, created_at: 3 }, // 25 off
  { participant_id: 3, name: 'Amit', employee_id: 'E3', guess_lakh: 275, created_at: 4 }, // 25 off
  { participant_id: 4, name: 'Neha', employee_id: 'E4', guess_lakh: 350, created_at: 2 }, // 50 off
  { participant_id: 5, name: 'Vik', employee_id: 'E5', guess_lakh: 500, created_at: 1 } // 200 off
];
const ranked = ranking.rankGuesses(guesses, 300);

ok('the list is still ordered nearest-first', ranked[0].name === 'Priya' && ranked[1].diffLakh === 25);
ok('everyone still gets a rank', ranked.length === 5 && ranked[4].rank === 5);
ok('equal distance goes to whoever locked in first', ranked[1].name === 'Rahul' && ranked[2].name === 'Amit');

const exact = ranking.exactWinners(ranked);
ok('only the exact bid wins this player', exact.length === 1 && exact[0].name === 'Priya', `${exact.length} winner(s)`);
ok('the winner is flagged rank 1 and spot on', exact[0].rank === 1 && exact[0].diffLakh === 0);
ok('the 25 L miss is not a "win"', !exact.some((w) => w.name === 'Rahul'));

/* ------------------------------------------------------------------ */
/* 2. Nobody exact → the player has no winners at all                  */
/* ------------------------------------------------------------------ */
console.log('\n2️⃣  Nobody nails the price');
const offByALittle = ranking.rankGuesses(
  [
    { participant_id: 7, name: 'Close', employee_id: 'C', guess_lakh: 325, created_at: 1 },
    { participant_id: 8, name: 'Closer', employee_id: 'D', guess_lakh: 300 + 25, created_at: 2 },
    { participant_id: 9, name: 'Far', employee_id: 'F', guess_lakh: 500, created_at: 3 }
  ],
  300
);
ok('no exact bid → no winners', ranking.exactWinners(offByALittle).length === 0);
const consolation = ranking.closestGuess(offByALittle);
ok('the nearest guess is still reported as information', consolation && consolation.name === 'Close' && consolation.diffLakh === 25, JSON.stringify(consolation && consolation.name));
ok('and it is not dressed up as a win', !consolation.rank);

/* ------------------------------------------------------------------ */
/* 3. More than three exact bids → earliest three, ranks 1/2/3         */
/* ------------------------------------------------------------------ */
console.log('\n3️⃣  Five people are all spot on');
const fiveExact = ranking.rankGuesses(
  [9, 4, 6, 1, 2].map((at, i) => ({
    participant_id: i + 1,
    name: `P${i + 1}`,
    employee_id: `E${i + 1}`,
    guess_lakh: 250,
    created_at: at
  })),
  250
);
const fiveWinners = ranking.exactWinners(fiveExact);
ok('at most three winners are declared', fiveWinners.length === 3, `${fiveWinners.length}`);
ok('ranks are 1,2,3', fiveWinners.map((w) => w.rank).join(',') === '1,2,3');
ok('the earliest lock-ins take the podium', fiveWinners.map((w) => w.at).join(',') === '1,2,4', fiveWinners.map((w) => w.at).join(','));

/* ------------------------------------------------------------------ */
/* 4. THE HOST'S CASE: 1 right bid but closest in 4 rounds             */
/* ------------------------------------------------------------------ */
console.log('\n4️⃣  Four phones: 1 right bid, closest in every round');

const A = { id: 1, name: 'Asha', eid: 'A1' };
const B = { id: 2, name: 'Bilal', eid: 'B2' };
const C = { id: 3, name: 'Chetan', eid: 'C3' };
const D = { id: 4, name: 'Divya', eid: 'D4' };

/** one round: [participant, distance from the sold price] in guess order */
const round = (pairs) => ({
  settled: true,
  name: 'player',
  ranked: pairs.map(([who, diff], i) => ({
    participantId: who.id,
    name: who.name,
    employeeId: who.eid,
    guessLakh: 1000,
    guessLabel: '10.0 Cr',
    diffLakh: diff,
    diffLabel: diff === 0 ? '0' : `${diff} L`,
    direction: diff === 0 ? 'exact' : 'over',
    rank: i + 1
  }))
});

const hostCase = [
  round([
    [A, 0],
    [B, 25],
    [C, 50],
    [D, 100]
  ]), // Asha exact
  round([
    [A, 40],
    [B, 140],
    [C, 190]
  ]),
  round([
    [A, 60],
    [B, 160]
  ]),
  round([
    [A, 100],
    [B, 200]
  ])
];
const hostTable = ranking.buildStandings(hostCase);
const asha = hostTable.find((x) => x.name === 'Asha');
const bilal = hostTable.find((x) => x.name === 'Bilal');

console.log(`     Asha : right bids ${asha.exact} · closest ${asha.closest} · top-3 ${asha.top3}`);
console.log(`     Bilal: right bids ${bilal.exact} · closest ${bilal.closest} · top-3 ${bilal.top3}`);
ok('Asha really has 1 right bid', asha.exact === 1);
ok('but 4 closest calls', asha.closest === 4);
ok('the two numbers are separate fields', asha.exact !== asha.closest);
ok('Asha leads the board', hostTable[0].name === 'Asha');
ok('Bilal has 0 right bids even though he was top-3 four times', bilal.exact === 0 && bilal.top3 === 4);

/* ------------------------------------------------------------------ */
/* 5. Right bids beat closest calls                                    */
/* ------------------------------------------------------------------ */
console.log('\n5️⃣  One right bid beats five near misses');
const rightBeatsClose = ranking.buildStandings([
  round([
    [A, 5],
    [B, 25]
  ]),
  round([
    [A, 10],
    [B, 25]
  ]),
  round([
    [A, 15],
    [B, 25]
  ]),
  round([
    [B, 0],
    [A, 25]
  ])
]);
const tableA = rightBeatsClose.find((x) => x.name === 'Asha');
const tableB = rightBeatsClose.find((x) => x.name === 'Bilal');
ok('the single exact bid ranks above three closest calls', rightBeatsClose[0].name === 'Bilal', `${rightBeatsClose[0].name} first`);
ok('closest calls are still counted for the tie-break', tableA.closest === 3 && tableB.closest === 1);
ok('the ranking is exact desc, then closest desc', rightBeatsClose[0].exact === 1 && tableA.exact === 0);

/* ------------------------------------------------------------------ */
/* 6. Ties: equal right bids → closest calls, then total distance      */
/* ------------------------------------------------------------------ */
console.log('\n6️⃣  Same number of right bids');
const sameExact = ranking.buildStandings([
  round([
    [A, 0],
    [B, 0]
  ]), // both spot on: one right bid each
  round([
    [B, 10],
    [A, 20]
  ]),
  round([
    [B, 10],
    [A, 20]
  ])
]);
const sameA = sameExact.find((x) => x.name === 'Asha');
const sameB = sameExact.find((x) => x.name === 'Bilal');
ok('both have one right bid', sameA.exact === 1 && sameB.exact === 1);
ok('more closest calls breaks the tie', sameExact[0].name === 'Bilal' && sameB.closest > sameA.closest, `${sameB.closest} vs ${sameA.closest}`);
ok('total distance is the next tie-break and is exposed', typeof sameExact[0].totalDiffLakh === 'number');

const deadTie = ranking.buildStandings([
  round([
    [A, 10],
    [B, 10]
  ])
]);
ok('a perfect dead heat falls back to alphabetical', deadTie[0].name === 'Asha', deadTie.map((x) => x.name).join(' / '));

/* ------------------------------------------------------------------ */
/* 7. Only sold players count                                          */
/* ------------------------------------------------------------------ */
console.log('\n7️⃣  Unsold players never count');
const withUnsold = ranking.buildStandings([
  round([[A, 0]]),
  { settled: false, name: 'No price yet', ranked: [] }
]);
ok('an unpriced player adds nothing', withUnsold.length === 1 && withUnsold[0].exact === 1);

/* ------------------------------------------------------------------ */
/* 8. Fields the screens rely on                                       */
/* ------------------------------------------------------------------ */
console.log('\n8️⃣  What the big screen reads');
const shape = hostTable[0];
ok('rank', shape.rank === 1);
ok('right bids (the big number)', shape.exact === 1);
ok('closest calls (the small line)', shape.closest === 4);
ok('legacy "nearest" still equals closest calls', shape.nearest === shape.closest);
ok('rounds played', shape.rounds === 4);
ok('average miss is a ladder label', typeof shape.avgDiffLabel === 'string', String(shape.avgDiffLabel));

console.log('\n' + '='.repeat(58));
console.log(`  Scoring rules: ${pass} passed, ${fail} failed`);
console.log('='.repeat(58) + '\n');
process.exit(fail ? 1 : 0);
