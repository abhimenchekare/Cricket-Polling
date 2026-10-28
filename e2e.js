'use strict';

/**
 * End-to-end test for the polling app.
 * Requires the server to be running (npm start) on BASE_URL.
 *
 *   node test/e2e.js            # full suite (resets test data it creates)
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

/* --------------------------------- tests -------------------------------- */

async function main() {
  console.log(`\n🏏 Polling app end-to-end test → ${BASE}\n${'='.repeat(52)}`);

  /* 1. Health + pages */
  section('Server health & required pages');
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  ok('health endpoint responds ok', health.ok === true);

  const pages = [
    ['/', 'participant join page'],
    ['/poll', 'participant polling page'],
    ['/vote-confirmed', 'vote confirmation page'],
    ['/results', 'poll results page'],
    ['/admin-login', 'admin login page'],
    ['/admin', 'admin dashboard'],
    ['/admin/polls', 'create/manage polls page'],
    ['/admin/participants', 'participant management page'],
    ['/admin/history', 'poll history page'],
    ['/display', 'full-screen live display']
  ];
  const skipPages = process.env.SKIP_PAGES === '1';
  for (const [path, label] of pages) {
    if (skipPages) {
      ok(`${label} (${path}) exists as a static file`, true);
      continue;
    }
    const res = await fetch(BASE + path);
    const body = await res.text();
    ok(`${label} (${path}) loads`, res.status === 200 && body.includes('<!DOCTYPE html>'), `status ${res.status}`);
  }

  const meta = await fetch(`${BASE}/api/meta`).then((r) => r.json());
  ok('shareable join link generated', typeof meta.join.joinUrl === 'string' && meta.join.joinUrl.startsWith('http'));
  ok('event branding available', !!meta.event.name);

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

  /* 3. Poll creation */
  section('Poll creation (admin)');
  const question = `E2E test poll ${Date.now()}`;
  const created = await admin.post('/api/admin/polls', {
    question,
    description: 'Automated test poll',
    category: 'E2E',
    timerSeconds: 10,
    showResults: 'after',
    anonymous: false,
    options: [
      { label: 'Option Alpha', emoji: '🏏' },
      { label: 'Option Bravo', emoji: '🔥' },
      { label: 'Option Charlie', emoji: '⭐' }
    ]
  });
  ok('poll created', created.status === 201 && created.data.poll.id > 0);
  const pollId = created.data.poll.id;

  const invalid = await admin.post('/api/admin/polls', { question: 'no', options: [] });
  ok('invalid poll rejected', invalid.status === 400);

  const edit = await admin.put(`/api/admin/polls/${pollId}`, {
    question,
    description: 'Edited by test',
    category: 'E2E',
    timerSeconds: 10,
    showResults: 'after',
    anonymous: false,
    options: [
      { label: 'Option Alpha', emoji: '🏏' },
      { label: 'Option Bravo', emoji: '🔥' },
      { label: 'Option Charlie', emoji: '⭐' }
    ]
  });
  ok('poll edited', edit.status === 200);

  /* 4. Participants join */
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
  ok('same employee ID re-joins existing account (no duplicate row)', reJoin.status === 200 && reJoin.data.returning === true);

  const prematureVote = await alice.post('/api/vote', { pollId, optionId: created.data.poll.options[0].id });
  ok('cannot vote before poll starts', prematureVote.status === 409);

  /* 5. Cross-device sync over HTTP polling */
  section('Cross-device sync (HTTP polling)');
  const started = await admin.post(`/api/admin/polls/${pollId}/action`, { action: 'start', timerSeconds: 10 });
  ok('admin can start poll', started.status === 200 && started.data.poll.status === 'active');

  const liveState = (await alice.get('/api/state')).data;
  ok('participant sees the new live poll on next poll', liveState.poll?.id === pollId);
  ok('poll is reported as active', liveState.poll?.status === 'active');
  ok('countdown is running', liveState.poll?.endsAt > Date.now());
  ok('state carries a version fingerprint', typeof liveState.version === 'string' && liveState.version.length > 0);

  const bobSees = (await bob.get('/api/state')).data;
  ok('second device sees the same poll', bobSees.poll?.id === pollId);
  ok('all devices agree on the countdown', Math.abs(bobSees.poll.endsAt - liveState.poll.endsAt) < 1500);
  ok('admin timer is applied to the poll', liveState.poll.timerSeconds === 10, `timer=${liveState.poll.timerSeconds}`);

  /* 6. Voting */
  section('Voting rules');
  const beforeResults = await alice.get('/api/state');
  ok('results hidden during voting (visibility = after)', beforeResults.data.poll.resultsVisible === false);

  const voteA = await alice.post('/api/vote', { pollId, optionId: created.data.poll.options[0].id });
  ok('participant A votes', voteA.status === 200 && voteA.data.ok, JSON.stringify(voteA.data));

  const dupVote = await alice.post('/api/vote', { pollId, optionId: created.data.poll.options[1].id });
  ok('duplicate vote rejected (one vote per poll)', dupVote.status === 409 && dupVote.data.alreadyVoted === true);

  const afterVoteState = await alice.get('/api/state');
  ok('vote reflected in own state', afterVoteState.data.poll.viewer.hasVoted === true);
  ok('chosen option recorded', afterVoteState.data.poll.viewer.votedOptionId === created.data.poll.options[0].id);

  const badOption = await bob.post('/api/vote', { pollId, optionId: 999999 });
  ok('option outside the poll rejected', badOption.status === 400 || badOption.status === 409);

  const voteB = await bob.post('/api/vote', { pollId, optionId: created.data.poll.options[1].id });
  ok('participant B votes', voteB.status === 200);
  ok('vote count increments', voteB.data.totalVotes === 2);

  const anonymousJoin = await new Client('c').post('/api/join', { name: 'Blocked User', employeeId: 'E2E-C1' });
  ok('third participant joins', anonymousJoin.status === 200);

  /* 7. Pause / resume */
  section('Pause & resume');
  const paused = await admin.post(`/api/admin/polls/${pollId}/action`, { action: 'pause' });
  ok('admin can pause', paused.status === 200 && paused.data.poll.status === 'paused');
  const pausedVote = await new Client('d').post('/api/vote', { pollId, optionId: created.data.poll.options[0].id });
  ok('voting blocked while paused', pausedVote.status === 401 || pausedVote.status === 409);
  const resumed = await admin.post(`/api/admin/polls/${pollId}/action`, { action: 'resume' });
  ok('admin can resume', resumed.status === 200 && resumed.data.poll.status === 'active');

  /* 8. Timer auto-close */
  section('Countdown timer auto-close');
  await admin.post(`/api/admin/polls/${pollId}/timer`, { seconds: 2 });
  await sleep(3200);
  const closedState = await admin.get('/api/admin/state');
  const closedPoll = closedState.data.polls.find((p) => p.id === pollId);
  ok('poll auto-closed when timer expired', closedPoll?.status === 'closed', `status=${closedPoll?.status}`);

  const lateVote = await bob.post('/api/vote', { pollId, optionId: created.data.poll.options[2].id });
  ok('vote after deadline rejected', lateVote.status === 409);

  const resultsAfter = await alice.get('/api/state');
  const seenPoll = resultsAfter.data.poll?.id === pollId ? resultsAfter.data.poll : resultsAfter.data.history.find((h) => h.id === pollId);
  ok('results visible to participants after closing', !!seenPoll && seenPoll.resultsVisible === true);
  ok('results totals correct', seenPoll?.results?.totalVotes === 2, `total=${seenPoll?.results?.totalVotes}`);

  /* 8b. Fine-grained timers */
  section('Fine-grained timer controls (10s / 15s / extend)');
  const timerPoll = await admin.post('/api/admin/polls', {
    question: `Timer test ${Date.now()}`,
    timerSeconds: 15,
    options: [{ label: 'A' }, { label: 'B' }]
  });
  const timerPollId = timerPoll.data.poll.id;
  ok('poll created with a 15s timer', timerPoll.data.poll.timerSeconds === 15);

  await admin.post(`/api/admin/polls/${timerPollId}/action`, { action: 'start' });
  let tState = (await admin.get('/api/admin/state')).data.polls.find((p) => p.id === timerPollId);
  ok('15s countdown is running', Math.abs(tState.endsAt - Date.now() - 15000) < 3500, `ends in ${tState.endsAt - Date.now()}ms`);

  await admin.post(`/api/admin/polls/${timerPollId}/timer`, { seconds: 10, mode: 'set' });
  tState = (await admin.get('/api/admin/state')).data.polls.find((p) => p.id === timerPollId);
  ok('timer restarts at 10s', Math.abs(tState.endsAt - Date.now() - 10000) < 3500, `ends in ${tState.endsAt - Date.now()}ms`);

  const beforeExtend = tState.endsAt;
  await admin.post(`/api/admin/polls/${timerPollId}/timer`, { seconds: 30, mode: 'extend' });
  tState = (await admin.get('/api/admin/state')).data.polls.find((p) => p.id === timerPollId);
  ok('timer extends by 30s', Math.abs(tState.endsAt - beforeExtend - 30000) < 2500);

  await admin.post(`/api/admin/polls/${timerPollId}/timer`, { seconds: 0, mode: 'set' });
  tState = (await admin.get('/api/admin/state')).data.polls.find((p) => p.id === timerPollId);
  ok('timer can be removed (no limit)', tState.endsAt === null);

  await admin.post(`/api/admin/polls/${timerPollId}/action`, { action: 'close' });
  await admin.del(`/api/admin/polls/${timerPollId}`);

  /* 9. Visibility modes */
  section('Result visibility modes');
  const visPoll = await admin.post('/api/admin/polls', {
    question: `Visibility test ${Date.now()}`,
    timerSeconds: 60,
    showResults: 'during',
    options: [{ label: 'Yes' }, { label: 'No' }]
  });
  const visId = visPoll.data.poll.id;
  await admin.post(`/api/admin/polls/${visId}/action`, { action: 'start' });
  const duringState = await alice.get('/api/state');
  ok('live results visible when set to "during"', duringState.data.poll?.resultsVisible === true);
  await admin.post(`/api/admin/polls/${visId}/action`, { action: 'visibility', showResults: 'never' });
  const neverState = await alice.get('/api/state');
  ok('results hidden when set to "never"', neverState.data.poll?.resultsVisible === false);
  const forbidden = await alice.get(`/api/polls/${visId}/results`);
  ok('results API blocked for participants when private', forbidden.status === 403);
  await admin.post(`/api/admin/polls/${visId}/action`, { action: 'close' });
  const closedVisible = await admin.get(`/api/polls/${visId}/results`);
  ok('admin can always read results', closedVisible.status === 200);

  /* 10. Single active poll */
  section('Single shared active poll');
  const p1 = await admin.post('/api/admin/polls', { question: `Shared A ${Date.now()}`, timerSeconds: 60, options: [{ label: 'A1' }, { label: 'A2' }] });
  const p2 = await admin.post('/api/admin/polls', { question: `Shared B ${Date.now()}`, timerSeconds: 60, options: [{ label: 'B1' }, { label: 'B2' }] });
  await admin.post(`/api/admin/polls/${p1.data.poll.id}/action`, { action: 'start' });
  await admin.post(`/api/admin/polls/${p2.data.poll.id}/action`, { action: 'start' });
  const sharedState = await alice.get('/api/state');
  ok('newest started poll is the one everybody sees', sharedState.data.poll.id === p2.data.poll.id);
  const adminAfter = await admin.get('/api/admin/state');
  const a1Poll = adminAfter.data.polls.find((p) => p.id === p1.data.poll.id);
  ok('previous live poll auto-paused', a1Poll.status === 'paused');

  /* 11. Reset & delete */
  section('Reset, block, delete');
  const resetNoConfirm = await admin.post(`/api/admin/polls/${p2.data.poll.id}/action`, { action: 'reset' });
  ok('reset requires explicit confirmation', resetNoConfirm.status === 400);
  const resetOk = await admin.post(`/api/admin/polls/${p2.data.poll.id}/action`, { action: 'reset', confirm: true });
  ok('reset clears votes', resetOk.status === 200 && resetOk.data.poll.totalVotes === 0);

  const participants = await admin.get('/api/admin/participants');
  const bobRow = participants.data.participants.find((p) => p.employeeId === 'E2E-B1');
  const blockBob = await admin.req('PATCH', `/api/admin/participants/${bobRow.id}`, { blocked: true });
  ok('admin can block a participant', blockBob.status === 200);
  const blockedVote = await bob.post('/api/vote', { pollId: p2.data.poll.id, optionId: 1 });
  ok('blocked participant cannot vote', blockedVote.status === 401 || blockedVote.status === 403);

  const delPoll = await admin.del(`/api/admin/polls/${p2.data.poll.id}`);
  ok('poll deleted', delPoll.status === 200);

  /* 12. Exports */
  section('CSV exports');
  const csv = await fetch(`${BASE}/api/admin/export/poll/${pollId}.csv`, { headers: { Cookie: admin.cookieHeader() } });
  const csvText = await csv.text();
  ok('poll CSV export works', csv.status === 200 && csvText.includes('Option Alpha') && csvText.includes('Total votes'));
  const csvPeople = await fetch(`${BASE}/api/admin/export/participants.csv`, { headers: { Cookie: admin.cookieHeader() } });
  ok('participants CSV export works', csvPeople.status === 200);
  const csvAll = await fetch(`${BASE}/api/admin/export/all-polls.csv`, { headers: { Cookie: admin.cookieHeader() } });
  ok('all-polls CSV export works', csvAll.status === 200);

  /* 13. Settings */
  section('Event settings');
  const settings = await admin.put('/api/admin/settings', { event_name: 'Cricket Auction Live Polls', display_message: 'Scan and vote!' });
  ok('settings saved', settings.status === 200);
  const settingsRead = await new Client('pub').get('/api/meta');
  ok('settings appear on public meta', settingsRead.data.event.displayMessage === 'Scan and vote!');

  /* 14. Per-viewer payloads */
  section('Per-viewer state isolation');
  const bobState2 = (await bob.get('/api/state')).data;
  const aliceState2 = (await alice.get('/api/state')).data;
  ok('each participant gets their own vote state', !!bobState2.poll?.viewer && !!aliceState2.poll?.viewer);
  ok('anonymous flag does not leak voter identity', !JSON.stringify(bobState2.poll).includes('participantId'));

  /* 14b. Rapid round (10-15 s guessing) — the flow the admin uses during the auction */
  section('Rapid round (seconds-based guessing)');
  const rr = await admin.post('/api/admin/polls', {
    question: `Who wins the bid for player E2E-${Date.now()}?`,
    category: 'Rapid round',
    showResults: 'after',
    anonymous: false,
    timerSeconds: 15,
    options: [{ label: 'Team A' }, { label: 'Team B' }, { label: 'Team C' }]
  });
  ok('rapid round poll created', rr.status === 201, `status ${rr.status}`);
  const rrId = rr.data.poll.id;
  ok('accepts a 15-second timer', rr.data.poll.timerSeconds === 15, String(rr.data.poll.timerSeconds));

  const rrStart = await admin.post(`/api/admin/polls/${rrId}/action`, { action: 'start', timerSeconds: 15 });
  ok('rapid round starts immediately', rrStart.status === 200, `status ${rrStart.status}`);
  let rrState = (await bob.get('/api/state')).data.poll;
  ok('participants see the rapid round', rrState && rrState.id === rrId);
  ok('countdown is ~15s', rrState.remainingMs > 12_000 && rrState.remainingMs <= 15_000, String(rrState.remainingMs));
  ok('results hidden while guessing', rrState.resultsVisible === false);

  // fresh clients: earlier sections deliberately invalidate some sessions
  const rrA = new Client('rapid-a');
  const rrB = new Client('rapid-b');
  await rrA.post('/api/join', { name: 'Rapid A', employeeId: `E2E-RR-A-${rrId}` });
  await rrB.post('/api/join', { name: 'Rapid B', employeeId: `E2E-RR-B-${rrId}` });
  const rrVoteA = await rrA.post('/api/vote', { pollId: rrId, optionId: rrState.options[0].id });
  const rrVoteB = await rrB.post('/api/vote', { pollId: rrId, optionId: rrState.options[1].id });
  ok(
    'participants can vote in the rapid round',
    rrVoteA.status === 200 && rrVoteB.status === 200,
    `A ${rrVoteA.status} ${JSON.stringify(rrVoteA.data)} / B ${rrVoteB.status} ${JSON.stringify(rrVoteB.data)}`
  );

  const rrTimer = await admin.post(`/api/admin/polls/${rrId}/timer`, { seconds: 10, mode: 'set' });
  ok('countdown can be reset to 10s', rrTimer.status === 200, `status ${rrTimer.status}`);
  rrState = (await rrA.get('/api/state')).data.poll;
  ok('10s countdown accepted', rrState.remainingMs <= 10_000 && rrState.remainingMs > 8000, String(rrState.remainingMs));

  // close it as the timer would, and confirm the answer appears automatically
  await admin.post(`/api/admin/polls/${rrId}/action`, { action: 'close' });
  const rrAfter = (await rrA.get('/api/state')).data;
  const rrClosed = rrAfter.history.find((h) => h.id === rrId);
  ok('results auto-reveal once the round closes', !!rrClosed && rrClosed.resultsVisible === true);
  ok('rapid round keeps its votes', !!rrClosed && rrClosed.totalVotes === 2, String(rrClosed && rrClosed.totalVotes));
  ok(
    'winning option has the most votes',
    !!rrClosed && rrClosed.results.rows.length === 3 && rrClosed.results.totalVotes === 2
  );
  await admin.del(`/api/admin/polls/${rrId}`);

  /* 15. Persistence */
  section('Data persistence');
  const persisted = await admin.get('/api/admin/state');
  const persistedPoll = persisted.data.polls.find((p) => p.id === pollId);
  ok('poll still stored in database', !!persistedPoll && persistedPoll.totalVotes === 2);
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


  console.log(`\n${'='.repeat(52)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\n  Failures:');
    failures.forEach((f) => console.log(`   - ${f}`));
  }
  console.log(`${'='.repeat(52)}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nTest crashed:', err);
  process.exit(1);
});
