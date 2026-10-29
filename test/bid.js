'use strict';

/**
 * Bid-range round end-to-end test.
 *
 *  1. admin creates a bid round for a player (no options, seconds timer)
 *  2. participants drag the ladder and lock a guess
 *  3. guesses outside the ladder are rejected
 *  4. one guess per participant is enforced
 *  5. admin enters the hammer price → round closes, 3 winners are ranked correctly
 *  6. ties are broken by who locked in first
 *  7. the hammer price can be corrected and the ranking recomputes
 *  8. participants only see other guesses after the price is entered
 *
 *   npm run dev
 *   node test/bid.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const LADDER = (() => {
  const out = [20, 40, 60, 80];
  for (let l = 100; l <= 975; l += 25) out.push(l);
  for (let l = 1000; l <= 3000; l += 50) out.push(l);
  return out;
})();
const label = (lakh) => {
  if (lakh < 100) return `${lakh} L`;
  const cr = lakh / 100;
  if (Number.isInteger(cr)) return cr >= 10 ? `${cr.toFixed(1)} Cr` : `${cr.toFixed(2)} Cr`;
  return `${cr} Cr`;
};

let pass = 0;
let fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
};
const section = (t) => console.log(`\n▶ ${t}`);

class Client {
  constructor(label_) {
    this.label = label_;
    this.cookies = new Map();
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.cookies.size ? { cookie: this.header() } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  }
  get(p) {
    return this.req('GET', p);
  }
  post(p, b) {
    return this.req('POST', p, b || {});
  }
  put(p, b) {
    return this.req('PUT', p, b || {});
  }
  del(p) {
    return this.req('DELETE', p);
  }
}

async function main() {
  console.log(`\n🏏 Bid range round test → ${BASE}\n${'='.repeat(54)}`);
  const admin = new Client('admin');
  const login = await admin.post('/api/admin/login', {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123'
  });
  ok('admin signed in', login.status === 200, `status ${login.status}`);

  section('Ladder exposed to clients');
  const meta = (await admin.get('/api/meta')).data;
  ok('meta.bid exists', !!meta.bid);
  ok('ladder has 81 steps', meta.bid && meta.bid.ladder.length === 81, String(meta.bid && meta.bid.ladder.length));
  ok('ladder starts at 20 L', meta.bid.ladder[0].lakh === 20 && meta.bid.ladder[0].label === '20 L');
  ok('ladder ends at 30.00 Cr', meta.bid.ladder.at(-1).lakh === 3000, meta.bid.ladder.at(-1).label);
  ok('1.00 Cr is on the ladder', meta.bid.ladder.some((s) => s.lakh === 100 && s.label === '1.00 Cr'));

  section('Admin creates a bid round');
  const question = `What will be the bid range for TestPlayer${Date.now().toString().slice(-4)} player?`;
  const created = await admin.post('/api/admin/polls', {
    pollType: 'bid',
    playerName: 'TestPlayer',
    question,
    timerSeconds: 60,
    showResults: 'after'
  });
  ok('bid poll created', created.status === 201, JSON.stringify(created.data).slice(0, 120));
  const pollId = created.data.poll.id;
  ok('stored as a bid poll', created.data.poll.pollType === 'bid');
  ok('player name stored', created.data.poll.playerName === 'TestPlayer');
  ok('no answer options needed', (created.data.poll.options || []).length === 0);

  section('Validation');
  const noPlayer = await admin.post('/api/admin/polls', { pollType: 'bid', timerSeconds: 30 });
  ok('bid poll without a player is rejected', noPlayer.status === 400, `status ${noPlayer.status}`);

  await admin.post(`/api/admin/polls/${pollId}/action`, { action: 'start', timerSeconds: 60 });

  section('Participants guess');
  const people = [
    { key: 'a', name: 'Aarav', id: 'BID-A', guess: 100 }, // 1.00 Cr
    { key: 'b', name: 'Bhavna', id: 'BID-B', guess: 125 }, // 1.25 Cr
    { key: 'c', name: 'Chirag', id: 'BID-C', guess: 3000 }, // 30.00 Cr
    { key: 'd', name: 'Diya', id: 'BID-D', guess: 125 } // 1.25 Cr (tie, later)
  ];
  const clients = {};
  for (const p of people) {
    const c = new Client(p.key);
    const j = await c.post('/api/join', { name: p.name, employeeId: `${p.id}-${pollId}` });
    ok(`${p.name} joined`, j.status === 200, `status ${j.status}`);
    clients[p.key] = c;
  }

  const offLadder = await clients.a.post('/api/vote', { pollId, guessLakh: 130 });
  ok('a price that is not on the ladder is rejected', offLadder.status === 400, `status ${offLadder.status}`);
  const tooHigh = await clients.a.post('/api/vote', { pollId, guessLakh: 5000 });
  ok('a price above 30 Cr is rejected', tooHigh.status === 400, `status ${tooHigh.status}`);

  for (const p of people) {
    const r = await clients[p.key].post('/api/vote', { pollId, guessLakh: p.guess });
    ok(`${p.name} locked ${label(p.guess)}`, r.status === 200 && r.data.guessLakh === p.guess, `status ${r.status}`);
  }

  const dup = await clients.a.post('/api/vote', { pollId, guessLakh: 500 });
  ok('a second guess is refused', dup.status === 409 && dup.data.alreadyVoted === true, `status ${dup.status}`);

  section('Hidden until the host enters the price');
  const midState = (await clients.a.get('/api/state')).data.poll;
  ok('results stay hidden while guessing', midState.resultsVisible === false);
  ok('a participant sees their own guess', midState.viewer.guessLakh === 100, String(midState.viewer.guessLakh));
  ok('other guesses are not leaked', !JSON.stringify(midState).includes('Bhavna'));

  section('Admin enters the hammer price (1.10 Cr)');
  const actualLakh = 110;
  const setActual = await admin.post(`/api/admin/polls/${pollId}/actual`, { lakh: actualLakh });
  ok('price accepted', setActual.status === 200, `status ${setActual.status}`);
  ok('round closed automatically', (await admin.get('/api/admin/state')).data.polls.find((p) => p.id === pollId).status === 'closed');

  const st = (await admin.get('/api/admin/state')).data.polls.find((p) => p.id === pollId);
  const winners = st.results.winners;
  ok('exactly 3 winners declared', winners.length === 3, String(winners.length));
  ok('winner 1 is 1.00 Cr (10 L away)', winners[0].guessLakh === 100, JSON.stringify(winners[0]));
  ok('winner 1 distance is 10 L', winners[0].diffLakh === 10, String(winners[0].diffLakh));
  ok(
    'winners 2 and 3 are the two 1.25 Cr guesses',
    winners[1].guessLakh === 125 && winners[2].guessLakh === 125,
    JSON.stringify(winners.map((w) => w.guessLakh))
  );
  ok(
    'tie is broken by who guessed first',
    winners[1].name === 'Bhavna' && winners[2].name === 'Diya',
    `${winners[1].name} / ${winners[2].name}`
  );
  ok('ranks are 1,2,3', winners.map((w) => w.rank).join(',') === '1,2,3');

  section('Participant view after the reveal');
  const revealed = (await clients.a.get('/api/state')).data;
  const closedPoll = revealed.history.find((h) => h.id === pollId);
  ok('closed bid round appears in history', !!closedPoll);
  ok('results are visible now', closedPoll.resultsVisible === true);
  ok(
    'hammer price is shown exactly as entered',
    closedPoll.results.actualLakh === actualLakh && closedPoll.results.actualLabel === '1.10 Cr',
    `${closedPoll.results.actualLakh} / ${closedPoll.results.actualLabel}`
  );
  ok('viewer sees their own rank', closedPoll.results.viewer && closedPoll.results.viewer.rank === 1, JSON.stringify(closedPoll.results.viewer));
  ok('viewer is marked a winner', closedPoll.results.viewer.isWinner === true);
  const viewerD = (await clients.d.get('/api/state')).data.history.find((h) => h.id === pollId).results.viewer;
  ok('third place participant sees rank 3', viewerD && viewerD.rank === 3, JSON.stringify(viewerD));
  ok('distribution lists every guessed price', closedPoll.results.distribution.length === 3, String(closedPoll.results.distribution.length));

  section('Correcting the price re-ranks everyone');
  const fix = await admin.post(`/api/admin/polls/${pollId}/actual`, { lakh: 125 });
  ok('price can be corrected', fix.status === 200);
  const fixed = (await admin.get('/api/admin/state')).data.polls.find((p) => p.id === pollId);
  ok('exact guesses now win', fixed.results.winners[0].guessLakh === 125 && fixed.results.winners[0].diffLakh === 0);
  ok('exact guesses are flagged', fixed.results.winners[0].direction === 'exact');
  ok(
    'the 1.00 Cr guess drops to third',
    fixed.results.winners[2].guessLakh === 100,
    JSON.stringify(fixed.results.winners.map((w) => w.guessLakh))
  );

  section('Clearing the price hides results again');
  const cleared = await admin.del(`/api/admin/polls/${pollId}/actual`);
  ok('clear accepted', cleared.status === 200);
  const afterClear = (await clients.a.get('/api/state')).data;
  const hidden = (afterClear.history.find((h) => h.id === pollId) || {}).results;
  ok('price is gone', !hidden || hidden.actualLakh == null);

  section('Voting rules still hold');
  const late = await clients.a.post('/api/vote', { pollId, guessLakh: 500 });
  ok('no extra guesses after the round', late.status === 409, `status ${late.status}`);
  const choiceTry = await admin.post('/api/admin/polls', { pollType: 'choice', question: 'x', options: [] });
  ok('multiple-choice polls are refused (slider only)', choiceTry.status === 400, `status ${choiceTry.status}`);

  section('Cleanup');
  await admin.del(`/api/admin/polls/${pollId}`);
  for (const p of people) {
    const list = (await admin.get('/api/admin/participants')).data.participants;
    const row = list.find((x) => x.employeeId === `${p.id}-${pollId}`);
    if (row) await admin.del(`/api/admin/participants/${row.id}`);
  }
  ok('test data cleaned up', true);

  console.log(`\n${'='.repeat(54)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\n  Failures:');
    failures.forEach((f) => console.log(`   - ${f}`));
  }
  console.log(`${'='.repeat(54)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\nTest crashed:', err);
  process.exit(1);
});
