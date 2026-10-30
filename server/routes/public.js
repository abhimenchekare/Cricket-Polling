'use strict';

const express = require('express');
const { q, one } = require('../db');
const { allSettings } = require('../settings');
const auth = require('../auth');
const state = require('../state');
const ladder = require('../bidladder');
const ledger = require('../ledger');
const config = require('../config');

const router = express.Router();

/* --------------------------- simple rate limiting ------------------------ */

const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || now > entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count += 1;
  return true;
}
function clientKey(req, scope) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
  return `${ip}:${scope}`;
}

/* --------------------------------- helpers ------------------------------- */

const cleanName = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 40);
const cleanEmployeeId = (v) => String(v || '').trim().slice(0, 24);

/* ---------------------------------- meta --------------------------------- */

router.get('/meta', async (req, res, next) => {
  try {
    const s = await allSettings();
    const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    res.json({
      event: {
        name: s.event_name,
        tagline: s.event_tagline,
        venueLine: s.venue_line,
        displayMessage: s.display_message
      },
      join: {
        requiresCode: s.join_requires_code === '1',
        allowNewParticipants: s.allow_new_participants === '1',
        joinUrl: `${base.replace(/\/$/, '')}/`,
        hostedOn: 'vercel'
      },
      polling: {
        activeMs: config.pollIntervalActiveMs,
        idleMs: config.pollIntervalIdleMs
      },
      // One shared price ladder so phone, admin and projector always agree.
      bid: {
        ladder: ladder.LADDER_LAKH.map((lakh) => ({ lakh, label: ladder.label(lakh) })),
        min: ladder.LADDER_LAKH[0],
        max: ladder.LADDER_LAKH[ladder.LADDER_LAKH.length - 1],
        steps: ladder.LADDER_LAKH.length
      },
      viewer: req.participant
        ? {
            joined: true,
            id: req.participant.id,
            name: req.participant.name,
            employeeId: req.participant.employee_id
          }
        : { joined: false },
      isAdmin: !!req.admin
    });
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- state --------------------------------- */

router.get('/state', async (req, res, next) => {
  try {
    const payload = await state.buildPublicState(req.participant?.id || null);
    payload.version = state.publicVersion(payload);
    // Serverless state is always fresh — never let a CDN or browser cache it
    res.set('Cache-Control', 'no-store, max-age=0');
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- stream --------------------------------- */
/*
  Server-Sent Events: the audience screens hold ONE open response and the server pushes the
  new state the instant anything changes. That is what makes "admin hits Start" appear on every
  phone without anyone refreshing.

  Serverless has no shared memory, so the function watches the database fingerprint on a short
  timer. The connection is closed after ~45 s and the browser reconnects automatically (that is
  built into EventSource), which stays well inside Vercel's function duration cap.
*/

router.get('/stream', async (req, res) => {
  const viewerId = req.participant?.id || null;

  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Connection: 'keep-alive',
    // stop nginx/CDN style proxies from buffering the stream
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  let closed = false;
  let timer = null;
  let lastFingerprint = null;
  let lastSentAt = 0;
  const startedAt = Date.now();
  const MAX_MS = 45_000;

  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const pushState = async (reason) => {
    const payload = await state.buildPublicState(viewerId);
    payload.version = state.publicVersion(payload);
    lastFingerprint = await state.stateFingerprint().catch(() => null);
    lastSentAt = Date.now();
    send('state', { reason, ...payload });
  };

  req.on('close', () => {
    closed = true;
  });

  try {
    // Say hello immediately so the client switches off polling without waiting for a change.
    send('ready', { serverTime: Date.now(), intervalMs: 400 });
    await pushState('connect');
  } catch (err) {
    send('stream-error', { error: 'Could not load state' });
    return res.end();
  }

  // Heartbeat keeps proxies from dropping an idle stream.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15_000);

  const tick = async () => {
    if (closed) return;
    if (Date.now() - startedAt > MAX_MS) {
      cleanup();
      if (!closed) res.write('event: bye\ndata: {}\n\n');
      return res.end();
    }
    try {
      const fp = await state.stateFingerprint();
      if (fp && fp !== lastFingerprint) {
        await pushState('change');
      }
    } catch {
      /* transient DB hiccup — keep the connection, retry on the next tick */
    }
    // Fast while people are voting, calmer when the room is idle.
    const idleFor = Date.now() - lastSentAt;
    const delay = idleFor > 20_000 ? 900 : 300;
    timer = setTimeout(tick, delay);
  };

  timer = setTimeout(tick, 300);

  function cleanup() {
    clearInterval(heartbeat);
    clearTimeout(timer);
  }
  res.on('close', cleanup);
  res.on('finish', cleanup);
});

/* ---------------------------------- join --------------------------------- */

router.post('/join', async (req, res, next) => {
  try {
    if (!rateLimit(clientKey(req, 'join'), 30, 60_000)) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a moment.' });
    }
    const s = await allSettings();
    if (s.allow_new_participants !== '1') {
      return res.status(403).json({ error: 'Joining is currently closed by the host' });
    }

    const name = cleanName(req.body?.name);
    const employeeId = cleanEmployeeId(req.body?.employeeId);
    const code = String(req.body?.code || '').trim();

    if (name.length < 2) return res.status(400).json({ error: 'Please enter your full name' });
    if (employeeId.length < 2) {
      return res.status(400).json({ error: 'Please enter your employee ID or access code' });
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(employeeId)) {
      return res.status(400).json({ error: 'Employee ID can contain letters, numbers, . _ / - only' });
    }
    if (
      s.join_requires_code === '1' &&
      code.toUpperCase() !== String(s.access_code || '').toUpperCase()
    ) {
      return res.status(403).json({ error: 'That event access code is not valid' });
    }

    let existing = await one('SELECT * FROM participants WHERE LOWER(employee_id) = LOWER($1)', [
      employeeId
    ]);
    if (existing && Number(existing.blocked)) {
      return res.status(403).json({ error: 'This employee ID has been blocked by the host' });
    }

    const now = Date.now();
    let participant = existing;
    if (existing) {
      const updated = await one(
        'UPDATE participants SET name = $1, last_seen_at = $2 WHERE id = $3 RETURNING *',
        [name, now, existing.id]
      );
      participant = updated;
    } else {
      participant = await one(
        `INSERT INTO participants (name, employee_id, created_at, last_seen_at)
         VALUES ($1, $2, $3, $3) RETURNING *`,
        [name, employeeId, now]
      );
    }

    const oldToken = req.cookies?.[auth.PARTICIPANT_COOKIE];
    if (oldToken) await auth.destroyParticipantSession(oldToken);

    const token = await auth.createParticipantSession(participant.id);
    res.cookie(auth.PARTICIPANT_COOKIE, token, {
      ...auth.cookieOptions,
      maxAge: Number(process.env.PARTICIPANT_SESSION_DAYS || 7) * 24 * 60 * 60 * 1000
    });

    res.json({
      ok: true,
      participant: {
        id: participant.id,
        name: participant.name,
        employeeId: participant.employee_id
      },
      returning: !!existing
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    await auth.destroyParticipantSession(req.cookies?.[auth.PARTICIPANT_COOKIE]);
    res.clearCookie(auth.PARTICIPANT_COOKIE, { path: '/' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------- vote --------------------------------- */

router.post('/vote', async (req, res, next) => {
  try {
    if (!rateLimit(clientKey(req, 'vote'), 40, 60_000)) {
      return res.status(429).json({ error: 'Too many requests. Slow down a little.' });
    }
    if (!req.participant) return res.status(401).json({ error: 'Please join the poll first' });
    if (Number(req.participant.blocked)) {
      return res.status(403).json({ error: 'Your participation has been disabled by the host' });
    }

    const pollId = Number(req.body?.pollId);
    const rawGuess = req.body?.guessLakh;
    if (req.body?.optionId !== undefined) {
      return res.status(400).json({
        error: 'Multiple-choice polls have been removed — pick a price with the slider'
      });
    }
    if (!Number.isInteger(pollId)) {
      return res.status(400).json({ error: 'Invalid vote request' });
    }

    /* One round trip on the hot path: read the poll, and only sweep when its timer actually ran out. */
    const poll = await one('SELECT * FROM polls WHERE id = $1', [pollId]);
    if (!poll) return res.status(404).json({ error: 'That poll no longer exists' });
    if (poll.status !== 'active') {
      return res.status(409).json({
        error:
          poll.status === 'paused'
            ? 'Voting is paused right now'
            : poll.status === 'closed'
              ? 'This poll is already closed'
              : 'This poll has not started yet'
      });
    }
    if (poll.ends_at && Date.now() >= Number(poll.ends_at)) {
      await state.sweepExpiredPolls();
      return res.status(409).json({ error: 'Time is up for this poll' });
    }

    /* Slider-only: a submission is always a price from the auction ladder. */
    const guessLakh = Number(rawGuess);
    if (!ladder.isValidGuess(guessLakh)) {
      return res.status(400).json({
        error: 'Pick a price from the ladder (20 L up to 30.00 Cr)',
        ladder: true
      });
    }

    /* A guess is one INSERT ... ON CONFLICT DO NOTHING, then one statement that bumps the poll
       revision and counts the guesses. Two round trips instead of four — this is the button the
       audience presses 100 times an hour. */
    const inserted = await one(
      `INSERT INTO votes (poll_id, option_id, participant_id, guess_lakh, created_at)
       VALUES ($1, NULL, $2, $3, $4)
       ON CONFLICT ON CONSTRAINT votes_one_per_participant DO NOTHING
       RETURNING id`,
      [pollId, req.participant.id, guessLakh, Date.now()]
    );
    if (!inserted) {
      const already = await one(
        'SELECT guess_lakh FROM votes WHERE poll_id = $1 AND participant_id = $2',
        [pollId, req.participant.id]
      );
      return res.status(409).json({
        error: 'You already locked a guess for this player',
        alreadyVoted: true,
        optionId: null,
        optionLabel: null,
        guessLakh: already && already.guess_lakh != null ? Number(already.guess_lakh) : null,
        guessLabel: already && already.guess_lakh != null ? ladder.label(already.guess_lakh) : null
      });
    }

    let total = 1;
    try {
      const bumped = await one(
        `UPDATE polls SET updated_at = $2, revision = revision + 1
          WHERE id = $1
          RETURNING (SELECT COUNT(*)::int FROM votes WHERE poll_id = $1) AS total`,
        [pollId, Date.now()]
      );
      if (bumped && bumped.total != null) total = Number(bumped.total);
    } catch {
      /* the guess is already stored — a counter failure must never fail the submission */
    }

    res.json({
      ok: true,
      pollId,
      pollType: 'bid',
      optionId: null,
      optionLabel: ladder.label(guessLakh),
      guessLakh,
      guessLabel: ladder.label(guessLakh),
      totalVotes: total,
      question: poll.question
    });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- results -------------------------------- */

router.get('/polls/:id/results', async (req, res, next) => {
  try {
    const poll = await one('SELECT * FROM polls WHERE id = $1', [Number(req.params.id)]);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    const visible = state.resultsVisibleToParticipants(poll);
    if (!visible && !req.admin) {
      return res.status(403).json({ error: 'Results are not published yet', visible: false });
    }
    res.json({
      poll: {
        id: poll.id,
        question: poll.question,
        status: poll.status,
        anonymous: Number(poll.anonymous) === 1
      },
      results: await state.getResults(poll.id),
      visible: true
    });
  } catch (err) {
    next(err);
  }
});

router.get('/history', async (req, res, next) => {
  try {
    const polls = await q(
      `SELECT * FROM polls WHERE status = 'closed' AND show_results <> 'never'
        ORDER BY COALESCE(closed_at, 0) DESC, id DESC LIMIT 30`
    );
    const out = [];
    for (const p of polls) {
      const results = await state.getResults(p.id);
      out.push({
        id: p.id,
        question: p.question,
        category: p.category,
        closedAt: p.closed_at ? Number(p.closed_at) : null,
        totalVotes: results.totalVotes,
        results
      });
    }
    res.json({ polls: out });
  } catch (err) {
    next(err);
  }
});

/**
 * 🏆 Leaderboard for the audience: the same 3/2/1 rule the admin ledger uses, published only once
 * at least one player has actually been sold (a guess is only "right" against a real hammer price).
 */
router.get('/standings', async (req, res, next) => {
  try {
    const { rows, summary, standings } = await ledger.buildLedger();
    res.json({
      rounds: summary.settled,
      players: summary.total,
      standings: standings.slice(0, 20).map((s) => ({
        rank: s.rank,
        name: s.name,
        firsts: s.firsts,
        nearest: s.nearest,
        closest: s.closest,
        top3: s.top3,
        rounds: s.rounds,
        seconds: s.seconds,
        thirds: s.thirds,
        points: s.points,
        exact: s.exact,
        rightBids: s.exact
      })),
      latest: rows
        .filter((r) => r.settled)
        .slice(-5)
        .reverse()
        .map((r) => ({
          player: r.name,
          soldLabel: r.soldLabel,
          winners: r.winners.map((w) => ({ rank: w.rank, name: w.name, guessLabel: w.guessLabel }))
        }))
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
