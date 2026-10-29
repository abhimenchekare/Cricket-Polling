'use strict';

const express = require('express');
const { q, one, logActivity } = require('../db');
const { allSettings, setSetting } = require('../settings');
const auth = require('../auth');
const state = require('../state');
const config = require('../config');
const ladder = require('../bidladder');

const router = express.Router();

/* --------------------------------- login --------------------------------- */

const attempts = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 10;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
}

router.post('/login', async (req, res, next) => {
  try {
    if (!loginAllowed(clientIp(req))) {
      return res.status(429).json({ error: 'Too many login attempts. Try again in a minute.' });
    }
    const { username, password } = req.body || {};
    const admin = await auth.verifyAdminCredentials(username, password);
    if (!admin) return res.status(401).json({ error: 'Invalid username or password' });

    const token = await auth.createAdminSession(admin.id);
    res.cookie(auth.ADMIN_COOKIE, token, {
      ...auth.cookieOptions,
      maxAge: Number(process.env.ADMIN_SESSION_HOURS || 12) * 60 * 60 * 1000
    });
    await logActivity('admin.login', `${admin.username} signed in`, admin.username);
    res.json({
      ok: true,
      token, // the panel stores this and sends it as x-admin-token (cookie fallback)
      admin: { id: admin.id, username: admin.username, displayName: admin.display_name }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const token = req.cookies?.[auth.ADMIN_COOKIE];
    if (token) await q('DELETE FROM admin_sessions WHERE token = $1', [token]);
    res.clearCookie(auth.ADMIN_COOKIE, { path: '/' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', async (req, res) => {
  if (!req.admin) return res.status(401).json({ error: 'Not signed in' });
  if (req.adminTokenSource === 'header') res.set('X-Admin-Auth', 'header');
  res.json({
    admin: {
      id: req.admin.id,
      username: req.admin.username,
      displayName: req.admin.display_name
    },
    defaultPasswordInUse: await auth.isDefaultPassword(req.admin.id)
  });
});

router.post('/password', auth.requireAdmin, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const result = await auth.changeAdminPassword(req.admin.id, currentPassword, newPassword);
    if (!result.ok) return res.status(400).json({ error: result.error });

    const token = await auth.createAdminSession(req.admin.id);
    res.cookie(auth.ADMIN_COOKIE, token, {
      ...auth.cookieOptions,
      maxAge: Number(process.env.ADMIN_SESSION_HOURS || 12) * 60 * 60 * 1000
    });
    await logActivity('admin.password_changed', 'Admin password updated', req.admin.username);
    res.json({ ok: true, token });
  } catch (err) {
    next(err);
  }
});

/* Every route below needs an admin session */
router.use(auth.requireAdmin);

router.get('/state', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store, max-age=0');
    res.json(await state.buildAdminState());
  } catch (err) {
    next(err);
  }
});

/* ---------------------------- poll validation ---------------------------- */

function parsePollPayload(body) {
  /* Slider-only application: every poll is a bid-range guess. The `poll_type` column stays so
     old rows keep working, but nothing can create a multiple-choice poll any more. */
  const playerName = String(body?.playerName || '').trim().slice(0, 80) || null;
  let question = String(body?.question || '').trim().slice(0, 200);
  const description = String(body?.description || '').trim().slice(0, 400) || null;
  const category = String(body?.category || '').trim().slice(0, 60) || null;
  const showResults = ['never', 'during', 'after'].includes(body?.showResults)
    ? body.showResults
    : 'after';
  const anonymous = body?.anonymous ? 1 : 0;

  let timerSeconds = Number(body?.timerSeconds);
  if (!Number.isFinite(timerSeconds) || timerSeconds < 0) timerSeconds = config.defaultTimerSeconds;
  timerSeconds = Math.min(Math.round(timerSeconds), 3600);

  const errors = [];
  if (!playerName) errors.push('Player name is required');
  if (!question) question = `What will be the bid range for ${playerName} player?`;
  if (question.length < 5) errors.push('Question must be at least 5 characters');

  return {
    pollType: 'bid',
    playerName,
    question,
    description,
    category: category || 'Bid range',
    showResults,
    anonymous,
    timerSeconds,
    options: [],
    errors
  };
}

async function replaceOptions(pollId, options) {
  await q('DELETE FROM options WHERE poll_id = $1', [pollId]);
  for (let i = 0; i < options.length; i++) {
    await q('INSERT INTO options (poll_id, label, emoji, position) VALUES ($1, $2, $3, $4)', [
      pollId,
      options[i].label,
      options[i].emoji,
      i
    ]);
  }
}

/** Keeps option IDs stable when editing a poll that has no votes yet. */
async function syncOptions(pollId, options) {
  const existing = await q(
    'SELECT * FROM options WHERE poll_id = $1 ORDER BY position, id',
    [pollId]
  );
  const used = new Set();
  for (let index = 0; index < options.length; index++) {
    const o = options[index];
    const labelMatch = existing.find((e) => !used.has(e.id) && e.label.trim() === o.label);
    const spare = existing.find((e) => !used.has(e.id));
    const target = labelMatch || spare;
    if (target) {
      used.add(target.id);
      await q('UPDATE options SET label = $1, emoji = $2, position = $3 WHERE id = $4', [
        o.label,
        o.emoji,
        index,
        target.id
      ]);
    } else {
      await q('INSERT INTO options (poll_id, label, emoji, position) VALUES ($1, $2, $3, $4)', [
        pollId,
        o.label,
        o.emoji,
        index
      ]);
    }
  }
  for (const e of existing) {
    if (!used.has(e.id)) await q('DELETE FROM options WHERE id = $1', [e.id]);
  }
}

/* -------------------------------- polls CRUD ----------------------------- */

router.get('/polls', async (req, res, next) => {
  try {
    res.json((await state.buildAdminState()).polls);
  } catch (err) {
    next(err);
  }
});

router.post('/polls', async (req, res, next) => {
  try {
    const data = parsePollPayload(req.body);
    if (data.errors.length) return res.status(400).json({ error: data.errors.join('. ') });
    const now = Date.now();
    const poll = await one(
      `INSERT INTO polls (question, description, category, status, show_results, anonymous,
                          timer_seconds, remaining_ms, poll_type, player_name,
                          created_at, updated_at, created_by)
       VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10, $10, $11) RETURNING *`,
      [
        data.question,
        data.description,
        data.category,
        data.showResults,
        data.anonymous,
        data.timerSeconds,
        data.timerSeconds * 1000,
        data.pollType,
        data.playerName,
        now,
        req.admin.username
      ]
    );
    await logActivity('poll.created', `Created poll "${data.question}"`, req.admin.username);
    const full = await state.getPoll(poll.id);
    res.status(201).json({ ok: true, poll: await state.serializePoll(full) });
  } catch (err) {
    next(err);
  }
});

router.put('/polls/:id', async (req, res, next) => {
  try {
    const poll = await one('SELECT * FROM polls WHERE id = $1', [Number(req.params.id)]);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });

    const data = parsePollPayload(req.body);
    if (data.errors.length) return res.status(400).json({ error: data.errors.join('. ') });

    const voteCount = Number(
      (await one('SELECT COUNT(*)::int AS c FROM votes WHERE poll_id = $1', [poll.id])).c
    );
    // Slider-only: a poll's question/price rules can change while it has guesses; only the
    // sold price and the countdown are separate actions, so nothing here is blocked by votes.
    if (voteCount > 0) {
      await logActivity('poll.updated_with_guesses', `Updated poll #${poll.id}`, req.admin.username);
    }

    await q(
      `UPDATE polls SET question = $1, description = $2, category = $3, show_results = $4,
                        anonymous = $5, timer_seconds = $6, poll_type = $9, player_name = $10,
                        updated_at = $7, revision = revision + 1
        WHERE id = $8`,
      [
        data.question,
        data.description,
        data.category,
        data.showResults,
        data.anonymous,
        data.timerSeconds,
        Date.now(),
        poll.id,
        data.pollType,
        data.playerName
      ]
    );
    await logActivity('poll.updated', `Updated poll #${poll.id}`, req.admin.username);
    const full = await state.getPoll(poll.id);
    res.json({ ok: true, poll: await state.serializePoll(full) });
  } catch (err) {
    next(err);
  }
});

/* Clear a wrongly entered hammer price (round stays as it is otherwise). */
router.delete('/polls/:id/actual', async (req, res, next) => {
  try {
    const poll = await one('SELECT * FROM polls WHERE id = $1', [Number(req.params.id)]);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    await q(
      `UPDATE polls SET actual_lakh = NULL, actual_set_at = NULL, actual_set_by = NULL,
                        updated_at = $1, revision = revision + 1 WHERE id = $2`,
      [Date.now(), poll.id]
    );
    await logActivity('poll.actual_price_cleared', `Cleared hammer price on #${poll.id}`, req.admin.username);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/polls/:id', async (req, res, next) => {
  try {
    const poll = await one('SELECT * FROM polls WHERE id = $1', [Number(req.params.id)]);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    await q('DELETE FROM polls WHERE id = $1', [poll.id]);
    await logActivity('poll.deleted', `Deleted poll #${poll.id} "${poll.question}"`, req.admin.username);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/polls/:id/duplicate', async (req, res, next) => {
  try {
    const poll = await one('SELECT * FROM polls WHERE id = $1', [Number(req.params.id)]);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    const now = Date.now();
    const copy = await one(
      `INSERT INTO polls (question, description, category, status, show_results, anonymous,
                          timer_seconds, remaining_ms, poll_type, player_name,
                          created_at, updated_at, created_by)
       VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, 'bid', $8, $9, $9, $10) RETURNING id`,
      [
        poll.player_name ? `Bid range: ${poll.player_name}` : `${poll.question} (copy)`,
        poll.description,
        poll.category,
        poll.show_results,
        poll.anonymous,
        poll.timer_seconds,
        Number(poll.timer_seconds) * 1000,
        poll.player_name,
        now,
        req.admin.username
      ]
    );
    await logActivity('poll.duplicated', `Duplicated poll #${poll.id}`, req.admin.username);
    res.status(201).json({ ok: true, id: copy.id });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ poll lifecycle --------------------------- */

router.post('/polls/:id/action', async (req, res, next) => {
  try {
    const poll = await one('SELECT * FROM polls WHERE id = $1', [Number(req.params.id)]);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    const action = String(req.body?.action || '');
    const now = Date.now();
    const timerMs = Math.max(0, Number(req.body?.timerSeconds ?? poll.timer_seconds) || 0) * 1000;

    switch (action) {
      case 'start':
      case 'reopen': {
        // Pause every other live poll so all devices show one poll
        await q(
          `UPDATE polls
              SET status = 'paused',
                  remaining_ms = CASE WHEN status = 'active' AND ends_at IS NOT NULL
                                      THEN GREATEST(0, ends_at - $1) ELSE remaining_ms END,
                  ends_at = NULL, updated_at = $1, revision = revision + 1
            WHERE status IN ('active','paused') AND id <> $2`,
          [now, poll.id]
        );
        const endsAt = timerMs > 0 ? now + timerMs : null;
        const timerSecondsOverride =
          req.body?.timerSeconds === undefined ? null : Math.round(timerMs / 1000);
        await q(
          `UPDATE polls SET status = 'active', started_at = $1, ends_at = $2, closed_at = NULL,
                            remaining_ms = $3, updated_at = $1, revision = revision + 1,
                            timer_seconds = COALESCE($4, timer_seconds)
            WHERE id = $5`,
          [now, endsAt, timerMs, timerSecondsOverride, poll.id]
        );
        await logActivity(
          action === 'reopen' ? 'poll.reopened' : 'poll.started',
          `Poll #${poll.id} "${poll.question}" is live`,
          req.admin.username
        );
        break;
      }
      case 'pause': {
        if (poll.status !== 'active') {
          return res.status(409).json({ error: 'Only a live poll can be paused' });
        }
        const remaining = poll.ends_at ? Math.max(0, Number(poll.ends_at) - now) : Number(poll.remaining_ms || 0);
        await q(
          `UPDATE polls SET status = 'paused', ends_at = NULL, remaining_ms = $1,
                            updated_at = $2, revision = revision + 1 WHERE id = $3`,
          [remaining, now, poll.id]
        );
        await logActivity('poll.paused', `Poll #${poll.id} paused`, req.admin.username);
        break;
      }
      case 'resume': {
        if (poll.status !== 'paused') {
          return res.status(409).json({ error: 'Only a paused poll can be resumed' });
        }
        const remaining = Number(poll.remaining_ms) > 0 ? Number(poll.remaining_ms) : timerMs;
        const endsAt = remaining > 0 ? now + remaining : null;
        await q(
          `UPDATE polls SET status = 'active', started_at = COALESCE(started_at, $1), ends_at = $2,
                            remaining_ms = $3, updated_at = $1, revision = revision + 1 WHERE id = $4`,
          [now, endsAt, remaining, poll.id]
        );
        await logActivity('poll.resumed', `Poll #${poll.id} resumed`, req.admin.username);
        break;
      }
      case 'close': {
        if (!['active', 'paused'].includes(poll.status)) {
          return res.status(409).json({ error: 'Only a live or paused poll can be closed' });
        }
        await q(
          `UPDATE polls SET status = 'closed', closed_at = $1, remaining_ms = 0,
                            updated_at = $1, revision = revision + 1 WHERE id = $2`,
          [now, poll.id]
        );
        await logActivity('poll.closed', `Poll #${poll.id} closed`, req.admin.username);
        break;
      }
      case 'reset': {
        if (req.body?.confirm !== true) {
          return res.status(400).json({ error: 'Reset needs explicit confirmation' });
        }
        await q('DELETE FROM votes WHERE poll_id = $1', [poll.id]);
        await q(
          `UPDATE polls SET status = 'draft', started_at = NULL, ends_at = NULL, closed_at = NULL,
                            remaining_ms = timer_seconds * 1000, updated_at = $1,
                            revision = revision + 1 WHERE id = $2`,
          [now, poll.id]
        );
        await logActivity('poll.reset', `Poll #${poll.id} reset (all votes cleared)`, req.admin.username);
        break;
      }
      case 'extend': {
        const extra = Math.max(0, Number(req.body?.seconds || 0)) * 1000;
        if (poll.status !== 'active') {
          return res.status(409).json({ error: 'Only a live poll can be extended' });
        }
        const base = poll.ends_at ? Math.max(now, Number(poll.ends_at)) : now;
        await q(
          `UPDATE polls SET ends_at = $1, started_at = COALESCE(started_at, $2),
                            updated_at = $2, revision = revision + 1 WHERE id = $3`,
          [base + extra, now, poll.id]
        );
        await logActivity(
          'poll.extended',
          `Poll #${poll.id} timer +${Math.round(extra / 1000)}s`,
          req.admin.username
        );
        break;
      }
      case 'visibility': {
        const mode = ['never', 'during', 'after'].includes(req.body?.showResults)
          ? req.body.showResults
          : 'after';
        await q(
          'UPDATE polls SET show_results = $1, updated_at = $2, revision = revision + 1 WHERE id = $3',
          [mode, now, poll.id]
        );
        await logActivity(
          'poll.visibility',
          `Poll #${poll.id} results visibility = ${mode}`,
          req.admin.username
        );
        break;
      }
      default:
        return res.status(400).json({ error: 'Unknown action' });
    }

    const full = await state.getPoll(poll.id);
    res.json({ ok: true, poll: await state.serializePoll(full) });
  } catch (err) {
    next(err);
  }
});

/**
 * Timer control.
 *   { seconds: 15, mode: 'set' }    → countdown restarts from now with 15s
 *   { seconds: 30, mode: 'extend' } → adds 30s to the current countdown
 * Works on draft (just stores the length) and active polls (applies immediately).
 */
router.post('/polls/:id/timer', async (req, res, next) => {
  try {
    const poll = await one('SELECT * FROM polls WHERE id = $1', [Number(req.params.id)]);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });

    const seconds = Math.max(0, Math.min(3600, Math.round(Number(req.body?.seconds) || 0)));
    const mode = req.body?.mode === 'extend' ? 'extend' : 'set';
    const now = Date.now();

    if (mode === 'extend' && poll.status === 'active') {
      const base = poll.ends_at ? Math.max(now, Number(poll.ends_at)) : now;
      await q(
        'UPDATE polls SET ends_at = $1, updated_at = $2, revision = revision + 1 WHERE id = $3',
        [base + seconds * 1000, now, poll.id]
      );
      await logActivity('poll.timer', `Poll #${poll.id} +${seconds}s`, req.admin.username);
      return res.json({ ok: true, mode, seconds, poll: await state.serializePoll(await state.getPoll(poll.id)) });
    }

    const endsAt = poll.status === 'active' && seconds > 0 ? now + seconds * 1000 : null;
    await q(
      `UPDATE polls SET timer_seconds = $1, remaining_ms = $2, ends_at = $3,
                        updated_at = $4, revision = revision + 1 WHERE id = $5`,
      [seconds, seconds * 1000, endsAt, now, poll.id]
    );
    await logActivity(
      'poll.timer',
      `Poll #${poll.id} timer set to ${seconds ? seconds + 's' : 'no limit'}`,
      req.admin.username
    );
    res.json({
      ok: true,
      mode: 'set',
      seconds,
      poll: await state.serializePoll(await state.getPoll(poll.id))
    });
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- votes --------------------------------- */

/* --------------------- bid round: enter the hammer price -------------------- */

/**
 * The host types what the player ACTUALLY sold for. That single number is the result:
 * it closes the round (if still open) and rankBidGuesses() names the 3 closest guesses.
 * Can be called again to correct a typo — everything is recomputed on read.
 */
router.post('/polls/:id/actual', async (req, res, next) => {
  try {
    const poll = await one('SELECT * FROM polls WHERE id = $1', [Number(req.params.id)]);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    if (poll.poll_type !== 'bid') {
      return res.status(400).json({ error: 'This poll is not a bid range poll' });
    }

    // The sold price is whatever the auction ended at — 1.10 Cr is a real result and is NOT on
    // the guess ladder, so accept any whole-lakh value (the ladder only constrains guesses).
    // The host may also type it as text ("1.85 Cr", "185 L", "1.85"), so parse that too.
    const raw =
      req.body?.lakh != null ? Number(req.body.lakh) : ladder.parsePrice(req.body?.price);
    if (!Number.isFinite(raw) || raw <= 0) {
      return res.status(400).json({ error: 'Enter the price the player actually sold for' });
    }
    const lakhValue = Math.round(raw);
    if (lakhValue > 10000) {
      return res.status(400).json({ error: 'That price looks too high (max 100 Cr)' });
    }

    const now = Date.now();
    await q(
      `UPDATE polls
          SET actual_lakh = $1, actual_set_at = $2, actual_set_by = $3,
              status = CASE WHEN status IN ('active','paused') THEN 'closed' ELSE status END,
              closed_at = CASE WHEN status IN ('active','paused') THEN $2 ELSE closed_at END,
              ends_at = CASE WHEN status IN ('active','paused') THEN NULL ELSE ends_at END,
              updated_at = $2, revision = revision + 1
        WHERE id = $4`,
      [lakhValue, now, req.admin.username, poll.id]
    );

    await logActivity(
      'poll.actual_price',
      `${poll.player_name || poll.question} sold for ${ladder.label(lakhValue)}`,
      req.admin.username
    );

    const fresh = await state.getPoll(poll.id);
    const results = await state.getBidResults(fresh);
    res.json({
      ok: true,
      actualLakh: lakhValue,
      actualLabel: ladder.label(lakhValue),
      winners: results.winners,
      totalGuesses: results.totalGuesses
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The complete guess sheet for ONE poll: every participant, what they guessed, how far off it is
 * and their rank — plus everyone who has not guessed yet. This is what the host reads out.
 */
router.get('/polls/:id/guesses', async (req, res, next) => {
  try {
    const poll = await one('SELECT * FROM polls WHERE id = $1', [Number(req.params.id)]);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });

    const [guesses, everyone, results] = await Promise.all([
      state.getBidGuesses(poll.id),
      q('SELECT id, name, employee_id, created_at FROM participants ORDER BY name ASC, id ASC'),
      state.getBidResults(poll)
    ]);

    const ranked = state.rankBidGuesses(guesses, poll.actual_lakh == null ? 0 : Number(poll.actual_lakh));
    const byParticipant = new Map(ranked.map((r) => [Number(r.participantId), r]));
    const anonymous = Number(poll.anonymous) === 1;
    const sold = poll.actual_lakh == null ? null : Number(poll.actual_lakh);
    const ladder = require('../bidladder');

    res.json({
      poll: {
        id: poll.id,
        question: poll.question,
        playerName: poll.player_name || null,
        status: poll.status,
        anonymous,
        actualLakh: sold,
        actualLabel: sold == null ? null : ladder.label(sold),
        showResults: poll.show_results,
        totalGuesses: guesses.length
      },
      revealed: sold != null,
      winners: results.winners,
      // guessers first (rank order), then everyone still missing — that is the order the host reads
      participants: everyone
        .map((p) => {
        const row = byParticipant.get(Number(p.id));
        return {
          participantId: p.id,
          name: anonymous ? `Player ${String(p.id).padStart(2, '0')}` : p.name,
          employeeId: anonymous ? '—' : p.employee_id,
          hasGuessed: Boolean(row),
          guessLakh: row ? row.guessLakh : null,
          guessLabel: row ? row.guessLabel : null,
          diffLakh: row && sold != null ? row.diffLakh : null,
          diffLabel: row && sold != null ? row.diffLabel : null,
          direction: row && sold != null ? row.direction : null,
          rank: row && sold != null ? row.rank : null,
            isWinner: Boolean(row && sold != null && row.rank <= 3)
          };
        })
        .sort((a, b) => {
          if (a.hasGuessed !== b.hasGuessed) return a.hasGuessed ? -1 : 1;
          if (a.hasGuessed && b.hasGuessed && a.rank && b.rank) return a.rank - b.rank;
          return String(a.name).localeCompare(String(b.name));
        })
    });
  } catch (err) {
    next(err);
  }
});

router.get('/polls/:id/votes', async (req, res, next) => {
  try {
    const poll = await one('SELECT * FROM polls WHERE id = $1', [Number(req.params.id)]);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    const rows = await q(
      `SELECT v.id, v.created_at, v.option_id, o.label AS option_label, p.name, p.employee_id
         FROM votes v
         JOIN options o ON o.id = v.option_id
         LEFT JOIN participants p ON p.id = v.participant_id
        WHERE v.poll_id = $1
        ORDER BY v.created_at DESC`,
      [poll.id]
    );
    const anonymous = Number(poll.anonymous) === 1;
    res.json({
      anonymous,
      votes: rows.map((r) => ({
        id: r.id,
        optionLabel: r.option_label,
        createdAt: Number(r.created_at),
        participant: anonymous ? 'Anonymous' : r.name || 'Unknown',
        employeeId: anonymous ? '—' : r.employee_id || '—'
      }))
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ participants ----------------------------- */

router.get('/participants', async (req, res, next) => {
  try {
    const term = String(req.query.q || '').trim();
    const like = `%${term}%`;
    const rows = await q(
      `SELECT p.*,
              (SELECT COUNT(*)::int FROM votes v WHERE v.participant_id = p.id) AS vote_count,
              (SELECT MAX(v.created_at) FROM votes v WHERE v.participant_id = p.id) AS last_vote_at
         FROM participants p
        WHERE $1 = '' OR p.name ILIKE $2 OR p.employee_id ILIKE $2 OR COALESCE(p.team,'') ILIKE $2
        ORDER BY p.created_at DESC`,
      [term, like]
    );
    res.json({
      participants: rows.map((r) => ({
        id: r.id,
        name: r.name,
        employeeId: r.employee_id,
        team: r.team,
        blocked: Number(r.blocked) === 1,
        voteCount: Number(r.vote_count),
        lastVoteAt: r.last_vote_at ? Number(r.last_vote_at) : null,
        createdAt: Number(r.created_at),
        lastSeenAt: Number(r.last_seen_at)
      }))
    });
  } catch (err) {
    next(err);
  }
});

router.post('/participants', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const employeeId = String(req.body?.employeeId || '').trim().slice(0, 24);
    const team = String(req.body?.team || '').trim().slice(0, 40) || null;
    if (name.length < 2) return res.status(400).json({ error: 'Name is too short' });
    if (!/^[A-Za-z0-9._/-]{2,24}$/.test(employeeId)) {
      return res.status(400).json({ error: 'Employee ID must be 2-24 letters/numbers' });
    }
    const exists = await one('SELECT id FROM participants WHERE LOWER(employee_id) = LOWER($1)', [
      employeeId
    ]);
    if (exists) return res.status(409).json({ error: 'That employee ID already exists' });

    const now = Date.now();
    await q(
      'INSERT INTO participants (name, employee_id, team, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $4)',
      [name, employeeId, team, now]
    );
    await logActivity('participant.added', `Added ${name} (${employeeId})`, req.admin.username);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.patch('/participants/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await one('SELECT * FROM participants WHERE id = $1', [id]);
    if (!existing) return res.status(404).json({ error: 'Participant not found' });

    const name = String(req.body?.name ?? existing.name).replace(/\s+/g, ' ').trim().slice(0, 40);
    const team = String(req.body?.team ?? existing.team ?? '').trim().slice(0, 40) || null;
    const blocked = req.body?.blocked === undefined ? existing.blocked : req.body.blocked ? 1 : 0;

    await q('UPDATE participants SET name = $1, team = $2, blocked = $3 WHERE id = $4', [
      name,
      team,
      blocked,
      id
    ]);
    if (blocked) await q('DELETE FROM participant_sessions WHERE participant_id = $1', [id]);

    await logActivity(
      'participant.updated',
      `${name} ${blocked ? 'blocked' : 'updated'}`,
      req.admin.username
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/participants/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await one('SELECT * FROM participants WHERE id = $1', [id]);
    if (!existing) return res.status(404).json({ error: 'Participant not found' });
    await q('DELETE FROM participants WHERE id = $1', [id]);
    await logActivity('participant.deleted', `Removed ${existing.name}`, req.admin.username);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/participants/:id/votes', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pollId = Number(req.query.pollId);
    if (Number.isInteger(pollId) && pollId > 0) {
      await q('DELETE FROM votes WHERE participant_id = $1 AND poll_id = $2', [id, pollId]);
    } else {
      await q('DELETE FROM votes WHERE participant_id = $1', [id]);
    }
    await logActivity('participant.votes_cleared', `Cleared votes for participant #${id}`, req.admin.username);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- settings ------------------------------- */

router.get('/settings', async (req, res, next) => {
  try {
    res.json({ settings: await allSettings({ fresh: true }) });
  } catch (err) {
    next(err);
  }
});

router.put('/settings', async (req, res, next) => {
  try {
    const allowed = [
      'event_name',
      'event_tagline',
      'venue_line',
      'join_requires_code',
      'access_code',
      'allow_new_participants',
      'display_message'
    ];
    const body = req.body || {};
    for (const key of allowed) {
      if (body[key] === undefined) continue;
      let value = String(body[key]).slice(0, 300);
      if (key === 'join_requires_code' || key === 'allow_new_participants') {
        value = body[key] === true || body[key] === '1' || body[key] === 'true' ? '1' : '0';
      }
      await setSetting(key, value);
    }
    await logActivity('settings.updated', 'Event settings updated', req.admin.username);
    res.json({ ok: true, settings: await allSettings({ fresh: true }) });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------- CSV ---------------------------------- */

function csvCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function csvResponse(res, filename, rows) {
  const body = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + body);
}

router.get('/export/poll/:id.csv', async (req, res, next) => {
  try {
    const poll = await one('SELECT * FROM polls WHERE id = $1', [Number(req.params.id)]);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    const settings = await allSettings();

    /* Bid round: export the guesses, the hammer price and the ranked winners. */
    if (poll.poll_type === 'bid') {
      const bidResults = await state.getBidResults(poll);
      const guesses = await state.getBidGuesses(poll.id);
      const ranked = poll.actual_lakh == null ? [] : state.rankBidGuesses(guesses, poll.actual_lakh);
      const rows = [
        ['Bid Range Round'],
        ['Event', settings.event_name],
        ['Player', poll.player_name || ''],
        ['Question', poll.question],
        ['Status', poll.status],
        ['Sold for', bidResults.actualLabel || 'not entered yet'],
        ['Total guesses', bidResults.totalGuesses],
        ['Exported at', new Date().toISOString()],
        [],
        ['Rank', 'Winner', 'Participant', 'Employee ID', 'Guess', 'Difference', 'Direction', 'Submitted at']
      ];
      for (const g of ranked) {
        rows.push([
          g.rank,
          g.rank <= 3 ? 'YES' : '',
          g.name,
          g.employeeId,
          g.guessLabel,
          g.diffLabel,
          g.direction,
          new Date(g.at).toISOString()
        ]);
      }
      rows.push([], ['Guess distribution'], ['Price', 'Guesses', 'Percent']);
      for (const d of bidResults.distribution) {
        rows.push([d.label, d.count, `${d.percent}%`]);
      }
      return csvResponse(res, `bid-${poll.id}-results.csv`, rows);
    }

    const results = await state.getResults(poll.id);

    const rows = [
      ['Poll Report'],
      ['Event', settings.event_name],
      ['Question', poll.question],
      ['Category', poll.category || ''],
      ['Status', poll.status],
      ['Anonymous', Number(poll.anonymous) ? 'Yes' : 'No'],
      ['Results visibility', poll.show_results],
      ['Total votes', results.totalVotes],
      ['Exported at', new Date().toISOString()],
      [],
      ['Option', 'Votes', 'Percent']
    ];
    for (const r of results.rows) rows.push([r.label, r.votes, `${r.percent}%`]);

    if (!Number(poll.anonymous)) {
      const votes = await q(
        `SELECT v.created_at, p.name, p.employee_id, o.label
           FROM votes v
           JOIN options o ON o.id = v.option_id
           LEFT JOIN participants p ON p.id = v.participant_id
          WHERE v.poll_id = $1
          ORDER BY v.created_at ASC`,
        [poll.id]
      );
      rows.push([], ['Vote log (chronological)'], ['Time', 'Participant', 'Employee ID', 'Option']);
      for (const v of votes) {
        rows.push([
          new Date(Number(v.created_at)).toISOString(),
          v.name || '',
          v.employee_id || '',
          v.label
        ]);
      }
    }
    csvResponse(res, `poll-${poll.id}-results.csv`, rows);
  } catch (err) {
    next(err);
  }
});

router.get('/export/participants.csv', async (req, res, next) => {
  try {
    const rows = [['Name', 'Employee ID', 'Team', 'Blocked', 'Votes cast', 'Joined at']];
    const list = await q(
      `SELECT p.*, (SELECT COUNT(*)::int FROM votes v WHERE v.participant_id = p.id) AS vote_count
         FROM participants p ORDER BY p.created_at ASC`
    );
    for (const p of list) {
      rows.push([
        p.name,
        p.employee_id,
        p.team || '',
        Number(p.blocked) ? 'Yes' : 'No',
        p.vote_count,
        new Date(Number(p.created_at)).toISOString()
      ]);
    }
    csvResponse(res, 'participants.csv', rows);
  } catch (err) {
    next(err);
  }
});

router.get('/export/all-polls.csv', async (req, res, next) => {
  try {
    const settings = await allSettings();
    const rows = [['Event', settings.event_name], [], ['Poll ID', 'Question', 'Status', 'Total votes']];
    const polls = await q('SELECT * FROM polls ORDER BY id ASC');
    const summaries = [];
    for (const p of polls) {
      const results = await state.getResults(p.id);
      summaries.push({ poll: p, results });
      rows.push([p.id, p.question, p.status, results.totalVotes]);
    }
    rows.push([], ['Poll', 'Option', 'Votes', 'Percent']);
    for (const s of summaries) {
      for (const r of s.results.rows) {
        rows.push([`#${s.poll.id} ${s.poll.question}`, r.label, r.votes, `${r.percent}%`]);
      }
    }
    csvResponse(res, 'all-polls-report.csv', rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
