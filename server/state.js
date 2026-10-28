'use strict';

const { q, one, scalar, logActivity } = require('./db');
const { allSettings } = require('./settings');

/* ------------------------------------------------------------------ */
/* Poll queries                                                       */
/* ------------------------------------------------------------------ */

const POLL_SELECT = `
  SELECT p.*,
         (SELECT COUNT(*)::int FROM votes v WHERE v.poll_id = p.id) AS total_votes,
         (SELECT COUNT(*)::int FROM options o WHERE o.poll_id = p.id) AS option_count
    FROM polls p
`;

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
  if (poll.show_results === 'never') return false;
  if (poll.status === 'closed') return true;
  if (poll.show_results === 'during' && (poll.status === 'active' || poll.status === 'paused')) {
    return true;
  }
  return false;
}

async function serializePoll(poll, { includeResults = false, participantId = null } = {}) {
  if (!poll) return null;
  const [options, votedOptionId] = await Promise.all([
    getOptions(poll.id),
    getVotedOptionId(poll.id, participantId)
  ]);
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
    options: options.map((o) => ({ id: o.id, label: o.label, emoji: o.emoji })),
    viewer: { hasVoted: !!votedOptionId, votedOptionId }
  };

  if (includeResults) {
    payload.results = await getResults(poll.id);
    payload.resultsVisible = true;
  } else {
    payload.results = null;
    payload.resultsVisible = false;
  }
  return payload;
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

async function buildPublicState(participantId = null) {
  await sweepExpiredPolls();

  const [settings, { poll, kind }] = await Promise.all([allSettings(), currentPollRow()]);
  const visible = resultsVisibleToParticipants(poll);

  const [serialized, historyRows, participants, online] = await Promise.all([
    serializePoll(poll, { includeResults: visible, participantId }),
    q(
      `${POLL_SELECT} WHERE p.status = 'closed' AND p.show_results <> 'never'
        ORDER BY COALESCE(p.closed_at, 0) DESC, p.id DESC LIMIT 12`
    ),
    getParticipantCount(),
    getOnlineCount()
  ]);

  const history = [];
  for (const h of historyRows) {
    history.push(await serializePoll(h, { includeResults: true, participantId }));
  }

  return {
    serverTime: Date.now(),
    event: {
      name: settings.event_name,
      tagline: settings.event_tagline,
      venueLine: settings.venue_line,
      displayMessage: settings.display_message,
      joinRequiresCode: settings.join_requires_code === '1'
    },
    stats: {
      participants,
      online,
      votesOnCurrent: serialized ? serialized.totalVotes : 0
    },
    poll: serialized,
    pollContext: serialized ? kind : 'none',
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

  const [pollRows, settings, participants, online, blocked, totalVotes] = await Promise.all([
    q(`${POLL_SELECT} ORDER BY p.id DESC`),
    allSettings(),
    getParticipantCount(),
    getOnlineCount(),
    scalar('SELECT COUNT(*)::int AS c FROM participants WHERE blocked = 1'),
    scalar('SELECT COUNT(*)::int AS c FROM votes')
  ]);

  const polls = [];
  for (const p of pollRows) {
    const [options, results] = await Promise.all([getOptions(p.id), getResults(p.id)]);
    polls.push({
      id: p.id,
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
      results
    });
  }

  const activity = await q(
    'SELECT id, actor, action, detail, created_at FROM activity_log ORDER BY id DESC LIMIT 25'
  );

  return {
    serverTime: Date.now(),
    polls,
    settings,
    // fingerprint so the admin panel can skip redundant re-renders
    version: [
      polls.map((p) => `${p.id}.${p.status}.${p.revision || 0}.${p.totalVotes}.${p.showResults}`).join('|'),
      participants,
      online,
      polls.length
    ].join('~'),
    stats: {
      participants: Number(participants),
      blocked: Number(blocked),
      totalVotes: Number(totalVotes),
      onlineParticipants: Number(online),
      activePolls: polls.filter((p) => p.status === 'active').length,
      closedPolls: polls.filter((p) => p.status === 'closed').length,
      draftPolls: polls.filter((p) => p.status === 'draft').length
    },
    recentActivity: activity.map((a) => ({ ...a, created_at: Number(a.created_at) }))
  };
}

module.exports = {
  POLL_SELECT,
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
