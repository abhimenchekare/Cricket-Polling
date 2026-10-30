'use strict';

const { q, one, scalar, logActivity } = require('./db');
const { allSettings } = require('./settings');
const ladder = require('./bidladder');
const { exactWinners, closestGuess } = require('./ranking');

/* ------------------------------------------------------------------ */
/* Poll queries                                                       */
/* ------------------------------------------------------------------ */

const POLL_SELECT = `
  SELECT p.*,
         (SELECT COUNT(*)::int FROM votes v WHERE v.poll_id = p.id) AS total_votes,
         (SELECT COUNT(*)::int FROM options o WHERE o.poll_id = p.id) AS option_count
    FROM polls p
`;

/* ------------------------------------------------------------------ */
/* Batched reads.                                                     */
/*                                                                    */
/* Neon answers in ~230 ms per round-trip, so anything that loops over */
/* polls (history, admin list) MUST NOT issue one query per poll —    */
/* 12 history polls x 4 queries was a 9-second page load. These        */
/* helpers collapse that into two parallel round-trips instead.        */
/* ------------------------------------------------------------------ */

/** ids that make up the participant's world: the live poll + recent closed ones. */
const VISIBLE_IDS = `(SELECT id FROM (
    (SELECT id FROM polls WHERE status IN ('active','paused')
      ORDER BY COALESCE(started_at, 0) DESC, id DESC LIMIT 1)
    UNION
    (SELECT id FROM polls WHERE status = 'closed' ORDER BY COALESCE(closed_at, 0) DESC, id DESC LIMIT 12)
  ) _ids)`;

const ALL_IDS = '(SELECT id FROM polls)';

const LIVE_POLL_COLS = `
  SELECT p.*,
         (SELECT COUNT(*)::int FROM votes v WHERE v.poll_id = p.id) AS total_votes,
         (SELECT COUNT(*)::int FROM options o WHERE o.poll_id = p.id) AS option_count
    FROM polls p`;

/** Live poll + history in ONE round-trip, tagged with a slot column. */
const LIVE_AND_HISTORY = `
  SELECT 'live'::text AS slot, t.* FROM (
    ${LIVE_POLL_COLS}
     WHERE p.status IN ('active','paused')
     ORDER BY COALESCE(p.started_at, 0) DESC, p.id DESC LIMIT 1
  ) t
  UNION ALL
  SELECT 'latest_closed'::text AS slot, t.* FROM (
    ${LIVE_POLL_COLS}
     WHERE p.status = 'closed'
     ORDER BY COALESCE(p.closed_at, 0) DESC, p.id DESC LIMIT 1
  ) t
  UNION ALL
  SELECT 'history'::text AS slot, t.* FROM (
    ${LIVE_POLL_COLS}
     WHERE p.status = 'closed' AND p.show_results <> 'never'
     ORDER BY COALESCE(p.closed_at, 0) DESC, p.id DESC LIMIT 12
  ) t`;

/**
 * Options, vote counts, "my votes" and every bid guess for a set of polls, as four JSON
 * arrays in a single round-trip. "mine" is empty when nobody is signed in.
 */
function bulkSql(ids, viewerParam = '$1') {
  return `
  SELECT
    COALESCE((SELECT json_agg(x) FROM (
      SELECT poll_id, id, label, emoji, position FROM options
       WHERE poll_id IN ${ids} ORDER BY position, id) x), '[]'::json) AS options,
    COALESCE((SELECT json_agg(x) FROM (
      SELECT poll_id, option_id, COUNT(*)::int AS votes FROM votes
       WHERE poll_id IN ${ids} GROUP BY poll_id, option_id) x), '[]'::json) AS counts,
    COALESCE((SELECT json_agg(x) FROM (
      SELECT poll_id, option_id, guess_lakh FROM votes
       WHERE participant_id = ${viewerParam} AND poll_id IN ${ids}) x), '[]'::json) AS mine,
    COALESCE((SELECT json_agg(x) FROM (
      SELECT v.poll_id, v.guess_lakh, v.created_at,
             p.id AS participant_id, p.name, p.employee_id
        FROM votes v JOIN participants p ON p.id = v.participant_id
       WHERE v.poll_id IN ${ids} AND v.guess_lakh IS NOT NULL
       ORDER BY v.created_at ASC, v.id ASC) x), '[]'::json) AS guesses`;
}

/** Group bulk rows by poll id so assembling a poll is pure in-memory work. */
function indexBulk(bulk) {
  const options = new Map();
  const counts = new Map();
  const mine = new Map();
  const guesses = new Map();

  for (const o of (bulk && bulk.options) || []) {
    if (!options.has(o.poll_id)) options.set(o.poll_id, []);
    options.get(o.poll_id).push({ id: o.id, label: o.label, emoji: o.emoji, position: o.position });
  }
  for (const c of (bulk && bulk.counts) || []) {
    if (!counts.has(c.poll_id)) counts.set(c.poll_id, []);
    counts.get(c.poll_id).push({ option_id: c.option_id, votes: Number(c.votes) });
  }
  for (const m of (bulk && bulk.mine) || []) mine.set(m.poll_id, m);
  for (const g of (bulk && bulk.guesses) || []) {
    if (!guesses.has(g.poll_id)) guesses.set(g.poll_id, []);
    guesses.get(g.poll_id).push(g);
  }
  return {
    optionsOf: (id) => options.get(id) || [],
    countsOf: (id) => counts.get(id) || [],
    mineOf: (id) => mine.get(id) || null,
    guessesOf: (id) => guesses.get(id) || []
  };
}

async function getPoll(id) {
  return one(`${POLL_SELECT} WHERE p.id = $1`, [id]);
}

async function getOptions(pollId) {
  return q(
    'SELECT id, label, emoji, position FROM options WHERE poll_id = $1 ORDER BY position, id',
    [pollId]
  );
}

async function getVotedOptionId(pollId, participantId) {
  if (!participantId) return null;
  const row = await one(
    'SELECT option_id FROM votes WHERE poll_id = $1 AND participant_id = $2',
    [pollId, participantId]
  );
  return row ? row.option_id : null;
}

async function getResults(pollId) {
  const [options, counts] = await Promise.all([
    getOptions(pollId),
    q('SELECT option_id, COUNT(*)::int AS votes FROM votes WHERE poll_id = $1 GROUP BY option_id', [
      pollId
    ])
  ]);
  return buildResults(options, counts);
}

/** Pure: turn option rows + per-option counts into the results payload. */
function buildResults(options, counts) {
  const map = new Map(counts.map((c) => [c.option_id, Number(c.votes)]));
  const total = counts.reduce((sum, c) => sum + Number(c.votes), 0);
  const rows = options.map((o) => {
    const votes = map.get(o.id) || 0;
    return {
      optionId: o.id,
      label: o.label,
      emoji: o.emoji,
      votes,
      percent: total ? Math.round((votes / total) * 1000) / 10 : 0
    };
  });
  const sorted = [...rows].sort((a, b) => b.votes - a.votes);
  let leadingOptionId = null;
  if (total > 0 && sorted[0] && sorted[0].votes > 0) {
    const tie = sorted.length > 1 && sorted[1].votes === sorted[0].votes;
    leadingOptionId = tie ? null : sorted[0].optionId;
  }
  return { totalVotes: total, rows, leadingOptionId };
}

/* ------------------------------------------------------------------ */
/* Bid-range polls                                                    */
/* ------------------------------------------------------------------ */

/** Every guess with the participant behind it, ordered nearest-first (ties: earliest). */
async function getBidGuesses(pollId) {
  return q(
    `SELECT v.id, v.guess_lakh, v.created_at, p.id AS participant_id, p.name, p.employee_id
       FROM votes v
       JOIN participants p ON p.id = v.participant_id
      WHERE v.poll_id = $1 AND v.guess_lakh IS NOT NULL
      ORDER BY v.created_at ASC, v.id ASC`,
    [pollId]
  );
}

/**
 * Rank everyone against the price the player actually sold for.
 *   - closest guess wins; ties (same distance) go to whoever locked it in first
 *   - only the top 3 are winners, but every guesser gets their own rank + distance
 */
function rankBidGuesses(guesses, actualLakh) {
  const actual = Number(actualLakh);
  const ranked = guesses.map((g) => {
    const guess = Number(g.guess_lakh);
    return {
      participantId: g.participant_id,
      name: g.name,
      employeeId: g.employee_id,
      guessLakh: guess,
      guessLabel: ladder.label(guess),
      diffLakh: Math.abs(guess - actual),
      diffLabel: ladder.label(Math.abs(guess - actual)),
      direction: guess === actual ? 'exact' : guess > actual ? 'over' : 'under',
      at: Number(g.created_at)
    };
  });
  ranked.sort((a, b) => a.diffLakh - b.diffLakh || a.at - b.at || a.participantId - b.participantId);

  // Ordinal ranking: equal distances are separated by who locked their guess in first (the sort
  // above) rather than sharing a rank. Note this rank is information — only an exact bid wins.
  ranked.forEach((row, i) => {
    row.rank = i + 1;
    row.tiedOnDistance = ranked.some((o) => o !== row && o.diffLakh === row.diffLakh);
  });
  return ranked;
}

/** Distribution of guesses across the ladder (only values somebody picked). */
function buildBidDistribution(guesses, actualLakh) {
  const buckets = new Map();
  for (const g of guesses) {
    const v = Number(g.guess_lakh);
    buckets.set(v, (buckets.get(v) || 0) + 1);
  }
  const total = guesses.length;
  return [...buckets.entries()]
    .map(([lakh, count]) => ({
      lakh,
      label: ladder.label(lakh),
      count,
      percent: total ? Math.round((count / total) * 1000) / 10 : 0,
      isActual: actualLakh != null && Number(actualLakh) === lakh
    }))
    .sort((a, b) => a.lakh - b.lakh);
}

async function getBidResults(poll, participantId = null) {
  const guesses = await getBidGuesses(poll.id);
  return buildBidResults(poll, guesses, participantId);
}

/** Pure: rank a known list of guesses against the sold price. */
function buildBidResults(poll, guesses, participantId = null) {
  const actualLakh = poll.actual_lakh == null ? null : Number(poll.actual_lakh);
  const ranked = actualLakh == null ? [] : rankBidGuesses(guesses, actualLakh);
  /* Only right-on-the-price bids win a player. Nobody exact -> no winners, just the closest. */
  const winners = exactWinners(ranked);
  const closest = winners.length ? null : closestGuess(ranked);

  let viewer = null;
  if (participantId) {
    const me = ranked.find((r) => r.participantId === Number(participantId));
    if (me) {
      viewer = {
        guessLakh: me.guessLakh,
        guessLabel: me.guessLabel,
        diffLakh: me.diffLakh,
        diffLabel: me.diffLabel,
        direction: me.direction,
        rank: me.rank,
        isWinner: me.diffLakh === 0
      };
    }
  }

  return {
    kind: 'bid',
    actualLakh,
    actualLabel: actualLakh == null ? null : ladder.label(actualLakh),
    totalGuesses: guesses.length,
    exactCount: winners.length,
    closest,
    winners: winners.map((w) => ({
      rank: w.rank,
      name: w.name,
      guessLakh: w.guessLakh,
      guessLabel: w.guessLabel,
      diffLakh: w.diffLakh,
      diffLabel: w.diffLabel,
      direction: w.direction
    })),
    distribution: buildBidDistribution(guesses, actualLakh),
    viewer
  };
}

async function getParticipantCount() {
  return Number(await scalar('SELECT COUNT(*)::int AS c FROM participants'));
}

/** "Online" = seen in the last 2 minutes (works on serverless, no sockets). */
async function getOnlineCount() {
  const since = Date.now() - 2 * 60 * 1000;
  return Number(await scalar('SELECT COUNT(*)::int AS c FROM participants WHERE last_seen_at > $1', [since]));
}

/* ------------------------------------------------------------------ */
/* Lazy timer expiry — there is no background loop on Vercel, so any   */
/* read or write first closes polls whose countdown has finished.      */
/* ------------------------------------------------------------------ */

async function sweepExpiredPolls() {
  const now = Date.now();
  const expired = await q(
    `UPDATE polls
        SET status = 'closed', closed_at = $1, ends_at = COALESCE(ends_at, $1),
            remaining_ms = 0, updated_at = $1, revision = revision + 1
      WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= $1
      RETURNING id, question`,
    [now]
  );
  for (const p of expired) {
    await logActivity('poll.auto_closed', `Poll #${p.id} closed when the timer ended`, 'system');
    console.log(`[timer] auto-closed poll #${p.id}`);
  }
  return expired.length > 0;
}

/* ------------------------------------------------------------------ */
/* Visibility                                                         */
/* ------------------------------------------------------------------ */

function resultsVisibleToParticipants(poll) {
  if (!poll) return false;
  // Bid rounds reveal the moment the host enters the hammer price (that IS the result).
  if (poll.poll_type === 'bid') return poll.actual_lakh != null;
  if (poll.show_results === 'never') return false;
  if (poll.status === 'closed') return true;
  if (poll.show_results === 'during' && (poll.status === 'active' || poll.status === 'paused')) {
    return true;
  }
  return false;
}

/**
 * Assemble one poll's payload. `ctx` comes from indexBulk() so this is pure memory work —
 * no queries. When ctx is omitted (single-poll callers) the data is fetched, which costs a
 * round-trip or two but is only used on one-poll paths.
 */
function assemblePoll(poll, ctx, { includeResults = false, participantId = null } = {}) {
  if (!poll) return null;
  const isBid = poll.poll_type === 'bid';
  const options = ctx.optionsOf(poll.id);
  const voteRow = participantId ? ctx.mineOf(poll.id) : null;
  const votedOptionId = voteRow ? voteRow.option_id : null;
  const totalVotes = Number(poll.total_votes || 0);
  const endsAt = poll.ends_at ? Number(poll.ends_at) : null;
  const remainingMs =
    poll.status === 'active' && endsAt
      ? Math.max(0, endsAt - Date.now())
      : poll.status === 'paused'
        ? Number(poll.remaining_ms || 0)
        : 0;

  const payload = {
    id: poll.id,
    question: poll.question,
    description: poll.description,
    category: poll.category,
    status: poll.status,
    showResults: poll.show_results,
    anonymous: Number(poll.anonymous) === 1,
    timerSeconds: Number(poll.timer_seconds),
    startedAt: poll.started_at ? Number(poll.started_at) : null,
    endsAt,
    closedAt: poll.closed_at ? Number(poll.closed_at) : null,
    remainingMs,
    revision: Number(poll.revision || 0),
    totalVotes,
    voterCount: totalVotes,
    pollType: isBid ? 'bid' : 'choice',
    playerName: poll.player_name || null,
    actualLakh: poll.actual_lakh == null ? null : Number(poll.actual_lakh),
    options: options.map((o) => ({ id: o.id, label: o.label, emoji: o.emoji })),
    viewer: {
      hasVoted: isBid ? Boolean(voteRow && voteRow.guess_lakh != null) : !!votedOptionId,
      votedOptionId,
      guessLakh: voteRow && voteRow.guess_lakh != null ? Number(voteRow.guess_lakh) : null,
      guessLabel: voteRow && voteRow.guess_lakh != null ? ladder.label(voteRow.guess_lakh) : null
    }
  };

  if (includeResults) {
    payload.results = isBid
      ? buildBidResults(poll, ctx.guessesOf(poll.id), participantId)
      : buildResults(options, ctx.countsOf(poll.id));
    payload.resultsVisible = true;
  } else {
    payload.results = null;
    payload.resultsVisible = false;
    // Before the reveal, a bid poll still tells you YOUR own guess (nobody else's).
    if (isBid && participantId && voteRow && voteRow.guess_lakh != null) {
      payload.myGuess = {
        lakh: Number(voteRow.guess_lakh),
        label: ladder.label(voteRow.guess_lakh)
      };
    }
  }
  return payload;
}

/** Single-poll convenience wrapper (fetch then assemble). */
async function serializePoll(poll, opts = {}) {
  if (!poll) return null;
  const bulk = await one(bulkSql(`(${Number(poll.id)})`), [opts.participantId || null]);
  return assemblePoll(poll, indexBulk(bulk), opts);
}

async function currentPollRow() {
  const live = await one(
    `${POLL_SELECT} WHERE p.status IN ('active','paused')
      ORDER BY COALESCE(p.started_at, 0) DESC, p.id DESC LIMIT 1`
  );
  if (live) return { poll: live, kind: 'live' };
  const closed = await one(
    `${POLL_SELECT} WHERE p.status = 'closed'
      ORDER BY COALESCE(p.closed_at, 0) DESC, p.id DESC LIMIT 1`
  );
  if (closed) return { poll: closed, kind: 'closed' };
  return { poll: null, kind: 'none' };
}

/* ------------------------------------------------------------------ */
/* Public state                                                       */
/* ------------------------------------------------------------------ */

/** One statement that returns everything the public state needs (rows + counts + bulk). */
const PUBLIC_STATE_SQL = `
  WITH core AS (
    SELECT (SELECT COALESCE(json_object_agg(key, value), '{}'::json) FROM settings) AS settings,
           (SELECT COUNT(*)::int FROM participants) AS participants,
           (SELECT COUNT(*)::int FROM participants WHERE last_seen_at > $1) AS online,
           (SELECT COUNT(*)::int FROM auction_players) AS roster_total,
           (SELECT COUNT(*)::int FROM auction_players WHERE status = 'sold') AS roster_sold,
           (SELECT COALESCE(SUM(sold_lakh), 0)::int FROM auction_players WHERE status = 'sold') AS roster_spent,
           (SELECT name FROM auction_players WHERE status = 'queued'
             ORDER BY position ASC, id ASC LIMIT 1) AS up_next
  )
  SELECT (SELECT row_to_json(core) FROM core) AS core,
         (SELECT COALESCE(json_agg(r), '[]'::json) FROM (${LIVE_AND_HISTORY}) r) AS rows,
         (SELECT row_to_json(b) FROM (${bulkSql(VISIBLE_IDS, '$2')}) b) AS bulk`;

/**
 * Fingerprint of everything a viewer can see. One cheap query; the live stream compares it on a
 * timer and pushes the full state the instant it changes.
 */
const FINGERPRINT_SQL = `
  SELECT md5(concat_ws('~',
    (SELECT COALESCE(sum(revision), 0)::text FROM polls),
    (SELECT COUNT(*)::text FROM votes),
    (SELECT COUNT(*)::text FROM participants),
    (SELECT COALESCE(sum(COALESCE(actual_lakh, 0)), 0)::text FROM polls),
    (SELECT COALESCE(string_agg(key || '=' || value, ',' ORDER BY key), '') FROM settings),
    (SELECT COALESCE(max(last_seen_at), 0)::text FROM participants),
    (SELECT COALESCE(string_agg(status, '' ORDER BY position, id), '') FROM auction_players)
  )) AS fingerprint`;

async function stateFingerprint() {
  const row = await one(FINGERPRINT_SQL);
  return row ? row.fingerprint : null;
}

async function buildPublicState(participantId = null) {
  // The sweep and the read run in PARALLEL (one round-trip's worth of waiting, not two).
  // The read may still see a poll that just expired, so rows are normalised below.
  const [, row] = await Promise.all([
    sweepExpiredPolls(),
    one(PUBLIC_STATE_SQL, [Date.now() - 2 * 60 * 1000, participantId])
  ]);

  return assemblePublicState(row, participantId);
}

/** Pure: turn the single PUBLIC_STATE_SQL row into the public payload. */
function assemblePublicState(row, participantId = null) {
  const core = (row && row.core) || {};
  const settings = core.settings || {};
  const ctx = indexBulk((row && row.bulk) || {});
  const now = Date.now();
  const allRows = ((row && row.rows) || []).map((r) => {
    // a countdown that ran out between the sweep and this read, or in another lambda:
    if (r.status === 'active' && r.ends_at && Number(r.ends_at) <= now) {
      return { ...r, status: 'closed', closed_at: Number(r.ends_at) };
    }
    return r;
  });

  const liveRow = allRows.find((r) => r.slot === 'live' && r.status !== 'closed') || null;
  const latestClosed = allRows.find((r) => r.slot === 'latest_closed') || null;
  const historyRows = allRows
    .filter((r) => r.slot === 'history')
    .sort((a, b) => Number(b.closed_at || 0) - Number(a.closed_at || 0) || b.id - a.id);

  const poll = liveRow || latestClosed || null;
  const kind = liveRow ? 'live' : poll ? 'closed' : 'none';
  const visible = resultsVisibleToParticipants(poll);
  const serialized = assemblePoll(poll, ctx, { includeResults: visible, participantId });
  const history = historyRows.map((h) =>
    assemblePoll(h, ctx, { includeResults: true, participantId })
  );

  return {
    serverTime: now,
    event: {
      name: settings.event_name,
      tagline: settings.event_tagline,
      venueLine: settings.venue_line,
      displayMessage: settings.display_message,
      joinRequiresCode: settings.join_requires_code === '1'
    },
    stats: {
      participants: Number(core.participants || 0),
      online: Number(core.online || 0),
      votesOnCurrent: serialized ? serialized.totalVotes : 0
    },
    auction: {
      rosterTotal: Number(core.roster_total || 0),
      sold: Number(core.roster_sold || 0),
      spentLakh: Number(core.roster_spent || 0),
      spentLabel: core.roster_spent ? ladder.label(Number(core.roster_spent)) : null,
      upNext: core.up_next || null
    },
    poll: serialized,
    pollContext: kind,
    history
  };
}

/** Compact fingerprint so clients can skip re-rendering unchanged state. */
function publicVersion(state) {
  const p = state.poll;
  return [
    p ? p.id : 0,
    p ? p.status : '-',
    p ? p.revision : 0,
    p ? p.totalVotes : 0,
    p && p.resultsVisible ? 1 : 0,
    p && p.viewer.hasVoted ? 1 : 0,
    state.stats.participants,
    state.history.length
  ].join(':');
}

/* ------------------------------------------------------------------ */
/* Admin state                                                        */
/* ------------------------------------------------------------------ */

async function buildAdminState() {
  await sweepExpiredPolls();

  // One parallel round-trip for everything (was one query per poll, ~40 round-trips).
  const [pollRows, core, bulk, activity, roster] = await Promise.all([
    q(`${POLL_SELECT} ORDER BY p.id DESC`),
    one(`SELECT (SELECT COALESCE(json_object_agg(key, value), '{}'::json) FROM settings) AS settings,
                (SELECT COUNT(*)::int FROM participants) AS participants,
                (SELECT COUNT(*)::int FROM participants WHERE last_seen_at > $1) AS online,
                (SELECT COUNT(*)::int FROM participants WHERE blocked = 1) AS blocked,
                (SELECT COUNT(*)::int FROM votes) AS total_votes`,
      [Date.now() - 2 * 60 * 1000]),
    one(bulkSql(ALL_IDS), [null]),
    q('SELECT id, actor, action, detail, created_at FROM activity_log ORDER BY id DESC LIMIT 25'),
    q(
      `SELECT p.*, (SELECT COUNT(*)::int FROM votes v WHERE v.poll_id = p.poll_id) AS guess_count
         FROM auction_players p ORDER BY p.position ASC, p.id ASC`
    )
  ]);

  const ctx = indexBulk(bulk);
  const settings = (core && core.settings) || {};
  const participants = Number(core ? core.participants : 0);
  const online = Number(core ? core.online : 0);

  const polls = pollRows.map((p) => {
    const isBid = p.poll_type === 'bid';
    const options = isBid ? [] : ctx.optionsOf(p.id).map((o) => ({
      id: o.id,
      label: o.label,
      emoji: o.emoji
    }));
    return {
      id: p.id,
      pollType: isBid ? 'bid' : 'choice',
      playerName: p.player_name || null,
      actualLakh: p.actual_lakh == null ? null : Number(p.actual_lakh),
      actualLabel: p.actual_lakh == null ? null : ladder.label(p.actual_lakh),
      question: p.question,
      description: p.description,
      category: p.category,
      status: p.status,
      showResults: p.show_results,
      anonymous: Number(p.anonymous) === 1,
      timerSeconds: Number(p.timer_seconds),
      remainingMs:
        p.status === 'active' && p.ends_at
          ? Math.max(0, Number(p.ends_at) - Date.now())
          : Number(p.remaining_ms || 0),
      startedAt: p.started_at ? Number(p.started_at) : null,
      endsAt: p.ends_at ? Number(p.ends_at) : null,
      closedAt: p.closed_at ? Number(p.closed_at) : null,
      createdAt: Number(p.created_at),
      totalVotes: Number(p.total_votes || 0),
      optionCount: Number(p.option_count || 0),
      options,
      results: isBid
        ? buildBidResults(p, ctx.guessesOf(p.id))
        : buildResults(options, ctx.countsOf(p.id))
    };
  });

  return {
    serverTime: Date.now(),
    polls,
    settings,
    // fingerprint so the admin panel can skip redundant re-renders
    version: [
      polls
        .map(
          (p) =>
            `${p.id}.${p.status}.${p.revision || 0}.${p.totalVotes}.${p.showResults}.${p.actualLakh ?? '-'}`
        )
        .join('|'),
      participants,
      online,
      polls.length
    ].join('~'),
    stats: {
      participants: Number(participants),
      blocked: Number(core ? core.blocked : 0),
      totalVotes: Number(core ? core.total_votes : 0),
      onlineParticipants: Number(online),
      activePolls: polls.filter((p) => p.status === 'active').length,
      closedPolls: polls.filter((p) => p.status === 'closed').length,
      draftPolls: polls.filter((p) => p.status === 'draft').length
    },
    recentActivity: activity.map((a) => ({ ...a, created_at: Number(a.created_at) })),
    auction: {
      players: roster.map((r) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        baseLakh: r.base_lakh == null ? null : Number(r.base_lakh),
        baseLabel: r.base_lakh == null ? null : ladder.label(Number(r.base_lakh)),
        position: Number(r.position),
        status: r.status,
        pollId: r.poll_id,
        soldLakh: r.sold_lakh == null ? null : Number(r.sold_lakh),
        soldLabel: r.sold_lakh == null ? null : ladder.label(Number(r.sold_lakh)),
        guessCount: Number(r.guess_count || 0)
      })),
      onBlock: roster.find((r) => r.status === 'on_block') || null,
      upNext: roster.filter((r) => r.status === 'queued').slice(0, 5),
      counts: {
        total: roster.length,
        queued: roster.filter((r) => r.status === 'queued').length,
        onBlock: roster.filter((r) => r.status === 'on_block').length,
        sold: roster.filter((r) => r.status === 'sold').length,
        unsold: roster.filter((r) => r.status === 'unsold').length
      }
    }
  };
}

module.exports = {
  POLL_SELECT,
  assemblePublicState,
  stateFingerprint,
  assemblePoll,
  indexBulk,
  getBidResults,
  getBidGuesses,
  rankBidGuesses,
  sweepExpiredPolls,
  getPoll,
  getOptions,
  getResults,
  getVotedOptionId,
  getParticipantCount,
  getOnlineCount,
  resultsVisibleToParticipants,
  serializePoll,
  currentPollRow,
  buildPublicState,
  buildAdminState,
  publicVersion
};
