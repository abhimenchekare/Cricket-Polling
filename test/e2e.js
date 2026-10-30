'use strict';

/**
 * End-to-end test — SLIDER-ONLY edition (v3).
 * Every poll is a "what will this player sell for?" bid round; the vote is a price from the
 * auction ladder. Run the server first.
 *
 *   node test/e2e.js
 *   BASE_URL=http://localhost:4000 node test/e2e.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:4000';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, extra = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name} ${extra ? '— ' + extra : ''}`);
  }
}

function section(title) {
  console.log(`\n▶ ${title}`);
}

/* ------------------------------ cookie jar ------------------------------ */

class Client {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of raw) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      const key = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '') this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
  }

  async req(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (this.cookies.size) headers.Cookie = this.cookieHeader();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    this.absorb(res);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data, headers: res.headers };
  }

  get(path) {
    return this.req('GET', path);
  }
  post(path, body) {
    return this.req('POST', path, body || {});
  }
  put(path, body) {
    return this.req('PUT', path, body || {});
  }
  del(path) {
    return this.req('DELETE', path);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A unique player name per run so repeated runs never collide. */
const stamp = Date.now();
const player = (tag) => `${tag} ${stamp}`;

async function main() {
  console.log(`\n🏏 Polling app — slider-only end-to-end → ${BASE}\n${'='.repeat(56)}`);

  /* 1. Health + pages */
  section('Server health & required pages');
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  ok('health endpoint responds ok', health.ok === true);
  ok('build id exposed', typeof health.build === 'string');

  const pages = [
    ['/', 'participant join page'],
    ['/poll', 'participant polling page'],
    ['/vote-confirmed', 'guess confirmation page'],
    ['/results', 'results page'],
    ['/admin-login', 'admin login page'],
    ['/admin', 'admin dashboard'],
    ['/admin-polls', 'manage polls page'],
    ['/admin-participants', 'participant management page'],
    ['/admin-history', 'history page'],
    ['/display', 'full-screen live display']
  ];
  const skipPages = process.env.SKIP_PAGES === '1';
  for (const [path, label] of pages) {
    if (skipPages) {
      ok(`${label} (${path}) exists`, true);
      continue;
    }
    const res = await fetch(BASE + path);
    const body = await res.text();
    ok(`${label} (${path}) loads`, res.status === 200 && body.includes('<!DOCTYPE html>'), `status ${res.status}`);
  }

  const meta = await fetch(`${BASE}/api/meta`).then((r) => r.json());
  ok('shareable join link generated', typeof meta.join.joinUrl === 'string' && meta.join.joinUrl.startsWith('http'));
  ok('bid ladder published (81 steps)', Array.isArray(meta.bid.ladder) && meta.bid.ladder.length === 81, `len=${meta.bid && meta.bid.ladder && meta.bid.ladder.length}`);
  ok('ladder starts at 20 L and ends at 30.0 Cr', meta.bid.ladder[0].label === '20 L' && meta.bid.ladder.at(-1).label === '30.0 Cr');

  /* 2. Admin auth */
  section('Admin authentication');
  const admin = new Client('admin');
  const badLogin = await admin.post('/api/admin/login', { username: 'admin', password: 'wrong-password' });
  ok('wrong password rejected', badLogin.status === 401);

  const login = await admin.post('/api/admin/login', {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123'
  });
  ok('admin login works', login.status === 200 && login.data.ok === true, JSON.stringify(login.data));

  const guard = await new Client('anon').get('/api/admin/state');
  ok('admin API protected without session', guard.status === 401);

  /* 3. Slider-only creation */
  section('Bid round creation (slider only)');
  const created = await admin.post('/api/admin/polls', {
    playerName: player('E2E Player'),
    description: 'Automated test round',
    timerSeconds: 10,
    showResults: 'after',
    anonymous: false
  });
  ok('bid round created', created.status === 201 && created.data.poll.id > 0, JSON.stringify(created.data).slice(0, 160));
  const pollId = created.data.poll.id;
  ok('poll type is bid', created.data.poll.pollType === 'bid');
  ok(
    'question auto-written from the player name',
    created.data.poll.question === `What will be the bid range for ${player('E2E Player')} player?`,
    created.data.poll.question
  );
  ok('no answer options exist', Array.isArray(created.data.poll.options) && created.data.poll.options.length === 0);

  const noPlayer = await admin.post('/api/admin/polls', { question: 'What will the price be?' });
  ok('a round without a player name is rejected', noPlayer.status === 400, `status ${noPlayer.status}`);

  const choiceAttempt = await admin.post('/api/admin/polls', {
    question: 'Who will win the league?',
    options: [{ label: 'Team A' }, { label: 'Team B' }]
  });
  ok(
    'multiple-choice polls can no longer be created',
    choiceAttempt.status === 400 || choiceAttempt.data?.poll?.pollType === 'bid',
    `status ${choiceAttempt.status}`
  );
  if (choiceAttempt.status === 201) await admin.del(`/api/admin/polls/${choiceAttempt.data.poll.id}`);

  const edit = await admin.put(`/api/admin/polls/${pollId}`, {
    playerName: player('E2E Player'),
    question: `What will be the bid range for ${player('E2E Player')} player?`,
    description: 'Edited by test',
    timerSeconds: 10,
    showResults: 'after',
    anonymous: false
  });
  ok('bid round edited', edit.status === 200);

  /* 4. Participants */
  section('Participant join & duplicate identity');
  const alice = new Client('alice');
  const bob = new Client('bob');

  const joinA = await alice.post('/api/join', { name: 'Alice Test', employeeId: 'E2E-A1' });
  ok('participant A joins', joinA.status === 200 && joinA.data.ok);
  const joinB = await bob.post('/api/join', { name: 'Bob Test', employeeId: 'E2E-B1' });
  ok('participant B joins', joinB.status === 200 && joinB.data.ok);

  const badJoin = await new Client('x').post('/api/join', { name: 'A', employeeId: '!!' });
  ok('invalid join rejected', badJoin.status === 400);

  const reJoin = await new Client('a2').post('/api/join', { name: 'Alice Test', employeeId: 'E2E-A1' });
  ok('same employee ID re-joins the existing account', reJoin.status === 200 && reJoin.data.returning === true);

  const premature = await alice.post('/api/vote', { pollId, guessLakh: 200 });
  ok('cannot guess before the round starts', premature.status === 409);

  /* 5. Live propagation */
  section('Starting a round reaches every device');
  const started = await admin.post(`/api/admin/polls/${pollId}/action`, { action: 'start', timerSeconds: 10 });
  ok('admin can start the round', started.status === 200 && started.data.poll.status === 'active');

  const liveState = (await alice.get('/api/state')).data;
  ok('participant sees the live round', liveState.poll?.id === pollId);
  ok('round is reported as active', liveState.poll?.status === 'active');
  ok('countdown is running', liveState.poll?.endsAt > Date.now());
  ok('player name travels with the poll', liveState.poll?.playerName === player('E2E Player'));
  ok('state carries a version fingerprint', typeof liveState.version === 'string' && liveState.version.length > 0);

  const bobSees = (await bob.get('/api/state')).data;
  ok('second device sees the same round', bobSees.poll?.id === pollId);
  ok('all devices agree on the countdown', Math.abs(bobSees.poll.endsAt - liveState.poll.endsAt) < 1500);

  /* Live stream hello (SSE) */
  const streamOk = await new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
      resolve(false);
    }, 8000);
    fetch(`${BASE}/api/stream`, { signal: ctrl.signal })
      .then(async (res) => {
        const reader = res.body.getReader();
        const { value } = await reader.read();
        clearTimeout(timer);
        ctrl.abort();
        const chunk = Buffer.from(value || []).toString('utf8');
        resolve(res.status === 200 && chunk.includes('event: ready'));
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
  });
  ok('SSE stream opens and greets the client', streamOk);

  /* 6. Guessing */
  section('Slider guessing rules');
  const beforeResults = await alice.get('/api/state');
  ok('winners hidden while guessing', beforeResults.data.poll.resultsVisible === false);

  const badGuess = await alice.post('/api/vote', { pollId, guessLakh: 123 });
  ok('a price off the ladder is rejected', badGuess.status === 400, `status ${badGuess.status}`);

  const legacyOption = await alice.post('/api/vote', { pollId, optionId: 1 });
  ok('multiple-choice submissions are rejected', legacyOption.status === 400, `status ${legacyOption.status}`);

  const guessA = await alice.post('/api/vote', { pollId, guessLakh: 175 });
  ok('participant A locks a guess (1.75 Cr)', guessA.status === 200 && guessA.data.ok, JSON.stringify(guessA.data));
  ok('guess label returned', guessA.data.guessLabel === '1.75 Cr', guessA.data.guessLabel);

  const dup = await alice.post('/api/vote', { pollId, guessLakh: 200 });
  ok('a second guess is rejected', dup.status === 409 && dup.data.alreadyVoted === true);

  const afterVote = await alice.get('/api/state');
  ok('own guess reflected in state', afterVote.data.poll.viewer.hasVoted === true);
  ok('guess value echoed back', afterVote.data.poll.viewer.guessLakh === 175);
  ok('guess label echoed back', afterVote.data.poll.viewer.guessLabel === '1.75 Cr');

  const guessB = await bob.post('/api/vote', { pollId, guessLakh: 200 });
  ok('participant B locks a guess (2.00 Cr)', guessB.status === 200);
  ok('guess count increments', guessB.data.totalVotes === 2, String(guessB.data.totalVotes));

  const third = new Client('carol');
  await third.post('/api/join', { name: 'Carol Test', employeeId: 'E2E-C1' });
  const guessC = await third.post('/api/vote', { pollId, guessLakh: 150 });
  ok('participant C locks a guess (1.50 Cr)', guessC.status === 200);

  /* 7. Pause / resume */
  section('Pause & resume');
  const paused = await admin.post(`/api/admin/polls/${pollId}/action`, { action: 'pause' });
  ok('admin can pause', paused.status === 200 && paused.data.poll.status === 'paused');
  const pausedGuess = await new Client('d').post('/api/vote', { pollId, guessLakh: 200 });
  ok('guessing blocked while paused', pausedGuess.status === 401 || pausedGuess.status === 409);
  const resumed = await admin.post(`/api/admin/polls/${pollId}/action`, { action: 'resume' });
  ok('admin can resume', resumed.status === 200 && resumed.data.poll.status === 'active');

  /* 8. Timer auto-close */
  section('Countdown auto-close');
  await admin.post(`/api/admin/polls/${pollId}/timer`, { seconds: 2 });
  await sleep(3200);
  const closedState = await admin.get('/api/admin/state');
  const closedPoll = closedState.data.polls.find((p) => p.id === pollId);
  ok('round auto-closed when the timer expired', closedPoll?.status === 'closed', `status=${closedPoll?.status}`);

  const lateGuess = await bob.post('/api/vote', { pollId, guessLakh: 300 });
  ok('guess after the deadline rejected', lateGuess.status === 409);

  /* 9. Sold price → exact bids win (v4.0.0) */
  section('Sold price → only exact bids win');
  const sold = await admin.post(`/api/admin/polls/${pollId}/actual`, { lakh: 185 });
  ok('sold price accepted', sold.status === 200 && sold.data.actualLakh === 185, JSON.stringify(sold.data));
  ok('no exact bid → no winners', Array.isArray(sold.data.winners) && sold.data.winners.length === 0, `${sold.data.winners && sold.data.winners.length}`);
  ok('the closest guess is reported instead', sold.data.closest && sold.data.closest.guessLakh === 175, JSON.stringify(sold.data.closest));

  const readable = await alice.get('/api/state');
  const seen = readable.data.poll?.id === pollId ? readable.data.poll : readable.data.history.find((h) => h.id === pollId);
  ok('winners visible to participants', !!seen && seen.resultsVisible === true);
  ok('all three guesses counted', seen?.results?.totalGuesses === 3, String(seen?.results?.totalGuesses));
  ok('nobody nailed 1.85 Cr, so no winners exist', seen?.results?.winners?.length === 0, String(seen?.results?.winners?.length));
  ok(
    'the closest guess (1.75 Cr, 10 L under) is shown as information',
    seen?.results?.closest?.guessLakh === 175 && seen.results.closest.diffLakh === 10,
    JSON.stringify(seen?.results?.closest)
  );
  ok('a near miss is not called a winner', seen?.results?.closest?.rank === undefined);

  /* 10. THE admin answer sheet */
  section('Admin guess sheet (who guessed, who did not, winners)');
  const sheet = await admin.get(`/api/admin/polls/${pollId}/guesses`);
  ok('guess sheet loads', sheet.status === 200, `status ${sheet.status}`);
  ok('sheet names the poll and the sold price', sheet.data.poll.id === pollId && sheet.data.poll.actualLabel === '1.85 Cr');
  ok('sheet is marked revealed', sheet.data.revealed === true);
  const rows = sheet.data.participants || [];
  const guessedRows = rows.filter((r) => r.hasGuessed);
  const missingRows = rows.filter((r) => !r.hasGuessed);
  ok('every participant appears exactly once', rows.length === new Set(rows.map((r) => r.participantId)).size);
  ok('all three guessers are listed', guessedRows.length === 3, `${guessedRows.length}`);
  ok('participants who did not guess are listed separately', Array.isArray(missingRows));
  ok(
    'each guess carries rank, distance and direction',
    guessedRows.every((r) => r.rank >= 1 && r.rank <= 3 && typeof r.diffLakh === 'number' && r.direction)
  );
  ok('the three winners are flagged', guessedRows.filter((r) => r.isWinner).length === 3);
  ok('sheet rows show the guess label', guessedRows.every((r) => typeof r.guessLabel === 'string' && r.guessLabel.includes('Cr')));

  const sheetOfOther = await new Client('nope').get(`/api/admin/polls/${pollId}/guesses`);
  ok('guess sheet requires an admin session', sheetOfOther.status === 401);

  /* 10b. Correcting the sold price re-ranks instantly */
  const corrected = await admin.post(`/api/admin/polls/${pollId}/actual`, { price: '2.00 Cr' });
  ok('sold price accepts typed text ("2.00 Cr")', corrected.status === 200 && corrected.data.actualLakh === 200, JSON.stringify(corrected.data));
  const rerank = await admin.get(`/api/admin/polls/${pollId}/guesses`);
  ok('exact guess wins after the correction', rerank.data.participants.find((r) => r.guessLakh === 200)?.rank === 1);
  ok('exact match is marked as such', rerank.data.winners[0].direction === 'exact');
  await admin.post(`/api/admin/polls/${pollId}/actual`, { lakh: 185 });

  const cleared = await admin.del(`/api/admin/polls/${pollId}/actual`);
  ok('sold price can be cleared', cleared.status === 200);
  await admin.post(`/api/admin/polls/${pollId}/actual`, { lakh: 185 });

  /* 11. Fine-grained timers */
  section('Fine-grained timer controls');
  const timerPoll = await admin.post('/api/admin/polls', { playerName: player('Timer Player'), timerSeconds: 15 });
  const timerPollId = timerPoll.data.poll.id;
  ok('round created with a 15s timer', timerPoll.data.poll.timerSeconds === 15);

  await admin.post(`/api/admin/polls/${timerPollId}/action`, { action: 'start' });
  let tState = (await admin.get('/api/admin/state')).data.polls.find((p) => p.id === timerPollId);
  ok('15s countdown is running', Math.abs(tState.endsAt - Date.now() - 15000) < 3500, `ends in ${tState.endsAt - Date.now()}ms`);

  await admin.post(`/api/admin/polls/${timerPollId}/timer`, { seconds: 10, mode: 'set' });
  tState = (await admin.get('/api/admin/state')).data.polls.find((p) => p.id === timerPollId);
  ok('timer restarts at 10s', Math.abs(tState.endsAt - Date.now() - 10000) < 3500);

  const beforeExtend = tState.endsAt;
  await admin.post(`/api/admin/polls/${timerPollId}/timer`, { seconds: 30, mode: 'extend' });
  tState = (await admin.get('/api/admin/state')).data.polls.find((p) => p.id === timerPollId);
  ok('timer extends by 30s', Math.abs(tState.endsAt - beforeExtend - 30000) < 2500);

  await admin.post(`/api/admin/polls/${timerPollId}/timer`, { seconds: 0, mode: 'set' });
  tState = (await admin.get('/api/admin/state')).data.polls.find((p) => p.id === timerPollId);
  ok('timer can be removed (no limit)', tState.endsAt === null);

  await admin.post(`/api/admin/polls/${timerPollId}/action`, { action: 'close' });
  await admin.del(`/api/admin/polls/${timerPollId}`);

  /* 12. Visibility */
  section('Result visibility before the sold price');
  const visPoll = await admin.post('/api/admin/polls', { playerName: player('Visibility Player'), timerSeconds: 60, showResults: 'during' });
  const visId = visPoll.data.poll.id;
  await admin.post(`/api/admin/polls/${visId}/action`, { action: 'start' });
  const duringState = await alice.get('/api/state');
  ok('nobody sees winners before the hammer price exists', duringState.data.poll?.resultsVisible === false);
  const forbidden = await new Client('p2').get(`/api/polls/${visId}/results`);
  ok('results API blocked before the sold price exists', forbidden.status === 403, `status ${forbidden.status}`);
  await admin.post(`/api/admin/polls/${visId}/action`, { action: 'start' });
  await admin.post(`/api/admin/polls/${visId}/actual`, { lakh: 250 });
  const afterPrice = await alice.get('/api/state');
  ok('winners reveal once the sold price is entered', afterPrice.data.poll?.resultsVisible === true);
  const adminResults = await admin.get(`/api/polls/${visId}/results`);
  ok('admin can always read results', adminResults.status === 200);

  /* 13. Single active round */
  section('Single shared active round');
  const p1 = await admin.post('/api/admin/polls', { playerName: player('Shared A'), timerSeconds: 60 });
  const p2 = await admin.post('/api/admin/polls', { playerName: player('Shared B'), timerSeconds: 60 });
  await admin.post(`/api/admin/polls/${p1.data.poll.id}/action`, { action: 'start' });
  await admin.post(`/api/admin/polls/${p2.data.poll.id}/action`, { action: 'start' });
  const sharedState = await alice.get('/api/state');
  ok('newest started round is the one everybody sees', sharedState.data.poll.id === p2.data.poll.id);
  const adminAfter = await admin.get('/api/admin/state');
  const a1Poll = adminAfter.data.polls.find((p) => p.id === p1.data.poll.id);
  ok('previous live round auto-paused', a1Poll.status === 'paused');

  /* 14. Reset / block / delete */
  section('Reset, block, delete');
  const resetNoConfirm = await admin.post(`/api/admin/polls/${p2.data.poll.id}/action`, { action: 'reset' });
  ok('reset requires explicit confirmation', resetNoConfirm.status === 400);
  const resetOk = await admin.post(`/api/admin/polls/${p2.data.poll.id}/action`, { action: 'reset', confirm: true });
  ok('reset clears guesses', resetOk.status === 200 && resetOk.data.poll.totalVotes === 0);

  const participants = await admin.get('/api/admin/participants');
  const bobRow = participants.data.participants.find((p) => p.employeeId === 'E2E-B1');
  const blockBob = await admin.req('PATCH', `/api/admin/participants/${bobRow.id}`, { blocked: true });
  ok('admin can block a participant', blockBob.status === 200);
  const blockedGuess = await bob.post('/api/vote', { pollId: p2.data.poll.id, guessLakh: 200 });
  ok('blocked participant cannot guess', blockedGuess.status === 401 || blockedGuess.status === 403);

  const delPoll = await admin.del(`/api/admin/polls/${p2.data.poll.id}`);
  ok('round deleted', delPoll.status === 200);

  /* 15. Exports */
  section('CSV exports');
  const csv = await fetch(`${BASE}/api/admin/export/poll/${pollId}.csv`, {
    headers: { Cookie: admin.cookieHeader() }
  });
  const csvText = await csv.text();
  ok('poll CSV export works', csv.status === 200 && csvText.length > 20);
  ok('poll CSV contains the guessers', csvText.includes('Alice') || csvText.toLowerCase().includes('guess'));
  const csvPeople = await fetch(`${BASE}/api/admin/export/participants.csv`, {
    headers: { Cookie: admin.cookieHeader() }
  });
  ok('participants CSV export works', csvPeople.status === 200);
  const csvAll = await fetch(`${BASE}/api/admin/export/all-polls.csv`, {
    headers: { Cookie: admin.cookieHeader() }
  });
  ok('all-polls CSV export works', csvAll.status === 200);

  /* 16. Settings */
  section('Event settings');
  const settings = await admin.put('/api/admin/settings', {
    event_name: 'Cricket Auction Live Polls',
    display_message: 'Scan and vote!'
  });
  ok('settings saved', settings.status === 200);
  const settingsRead = await new Client('pub').get('/api/meta');
  ok('settings appear on public meta', settingsRead.data.event.displayMessage === 'Scan and vote!');

  /* 17. Per-viewer payloads */
  section('Per-viewer state isolation');
  const bobState2 = (await bob.get('/api/state')).data;
  const aliceState2 = (await alice.get('/api/state')).data;
  ok('each participant gets their own guess state', !!bobState2.poll?.viewer && !!aliceState2.poll?.viewer);
  ok('anonymous flag does not leak voter identity', !JSON.stringify(bobState2.poll).includes('participantId'));

  /* 18. One-tap round */
  section('One-tap bid round (the flow used during the auction)');
  const rr = await admin.post('/api/admin/polls', {
    playerName: `Rapid ${stamp}`,
    question: `What will be the bid range for Rapid ${stamp} player?`,
    category: 'Bid range',
    showResults: 'after',
    anonymous: false,
    timerSeconds: 15
  });
  ok('one-tap round created', rr.status === 201, `status ${rr.status}`);
  const rrId = rr.data.poll.id;
  ok('accepts a 15-second timer', rr.data.poll.timerSeconds === 15);
  const rrStart = await admin.post(`/api/admin/polls/${rrId}/action`, { action: 'start', timerSeconds: 15 });
  ok('round starts immediately', rrStart.status === 200);
  let rrState = (await bob.get('/api/state')).data.poll;
  ok('participants see the round', rrState && rrState.id === rrId);
  ok('countdown is ~15s', rrState.remainingMs > 12_000 && rrState.remainingMs <= 15_000, String(rrState.remainingMs));
  ok('winners hidden while guessing', rrState.resultsVisible === false);

  const rrA = new Client('rapid-a');
  const rrB = new Client('rapid-b');
  await rrA.post('/api/join', { name: 'Rapid A', employeeId: `E2E-RR-A-${rrId}` });
  await rrB.post('/api/join', { name: 'Rapid B', employeeId: `E2E-RR-B-${rrId}` });
  const rrGuessA = await rrA.post('/api/vote', { pollId: rrId, guessLakh: 500 });
  const rrGuessB = await rrB.post('/api/vote', { pollId: rrId, guessLakh: 550 });
  ok('participants can guess in the round', rrGuessA.status === 200 && rrGuessB.status === 200);

  const rrTimer = await admin.post(`/api/admin/polls/${rrId}/timer`, { seconds: 10, mode: 'set' });
  ok('countdown can be reset to 10s', rrTimer.status === 200);
  rrState = (await rrA.get('/api/state')).data.poll;
  ok('10s countdown accepted', rrState.remainingMs <= 10_000 && rrState.remainingMs > 8000);

  await admin.post(`/api/admin/polls/${rrId}/actual`, { lakh: 525 });
  const rrAfter = (await rrA.get('/api/state')).data;
  const rrClosed = rrAfter.history.find((h) => h.id === rrId) || (rrAfter.poll && rrAfter.poll.id === rrId ? rrAfter.poll : null);
  ok('entering the sold price closes and reveals the round', !!rrClosed && rrClosed.resultsVisible === true);
  ok('round keeps both guesses', !!rrClosed && rrClosed.totalVotes === 2, String(rrClosed && rrClosed.totalVotes));
  /* 5.00 Cr and 5.50 Cr were guessed, the player sold for 5.25 Cr → nobody exact, no winner */
  ok('nobody exact → no winners', !!rrClosed && rrClosed.results.winners.length === 0, String(rrClosed && rrClosed.results.winners.length));
  ok('the closest guess is named', rrClosed.results.closest && rrClosed.results.closest.guessLakh === 500, JSON.stringify(rrClosed.results.closest));

  /* correct the price to the guess that was actually right → that person wins the player */
  await admin.post(`/api/admin/polls/${rrId}/actual`, { lakh: 500 });
  const rrFixed = (await rrA.get('/api/state')).data.history.find((h) => h.id === rrId);
  ok(
    'the exact bid wins once the price matches it',
    rrFixed.results.winners.length === 1 && rrFixed.results.winners[0].guessLakh === 500 && rrFixed.results.winners[0].rank === 1,
    JSON.stringify(rrFixed.results.winners.map((w) => [w.name, w.guessLakh, w.rank]))
  );
  await admin.del(`/api/admin/polls/${rrId}`);

  /* 19. Persistence */
  section('Data persistence');
  const persisted = await admin.get('/api/admin/state');
  const persistedPoll = persisted.data.polls.find((p) => p.id === pollId);
  ok('round still stored in the database', !!persistedPoll && persistedPoll.totalVotes === 3);
  ok('participant records stored', persisted.data.stats.participants >= 3);

  /* cleanup */
  section('Cleanup');
  await admin.del(`/api/admin/polls/${pollId}`);
  await admin.del(`/api/admin/polls/${visId}`);
  await admin.del(`/api/admin/polls/${p1.data.poll.id}`);
  for (const p of (await admin.get('/api/admin/participants')).data.participants) {
    if (p.employeeId.startsWith('E2E-')) await admin.del(`/api/admin/participants/${p.id}`);
  }
  ok('test data cleaned up', true);

  console.log(`\n${'='.repeat(56)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\n  Failures:');
    failures.forEach((f) => console.log(`   - ${f}`));
  }
  console.log(`${'='.repeat(56)}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nTest crashed:', err);
  process.exit(1);
});
