'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { q, one, isTransient } = require('./db');

const ADMIN_COOKIE = 'cp_admin';
const PARTICIPANT_COOKIE = 'cp_participant';
const DAY = 24 * 60 * 60 * 1000;

const HOURS = Number(process.env.ADMIN_SESSION_HOURS || 12);
const P_DAYS = Number(process.env.PARTICIPANT_SESSION_DAYS || 7);

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  // Vercel serves HTTPS, so secure cookies work in production
  secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === '1'
};

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

/* ------------------------------ participants ----------------------------- */

async function createParticipantSession(participantId) {
  const token = newToken();
  const now = Date.now();
  await q(
    'INSERT INTO participant_sessions (token, participant_id, created_at, last_seen_at) VALUES ($1, $2, $3, $3)',
    [token, participantId, now]
  );
  return token;
}

async function getParticipantByToken(token) {
  if (!token || typeof token !== 'string') return null;
  const row = await one(
    `SELECT p.*, s.token AS session_token
       FROM participant_sessions s
       JOIN participants p ON p.id = s.participant_id
      WHERE s.token = $1`,
    [token]
  );
  if (!row) return null;
  const now = Date.now();
  // Presence + freshness (best effort — never block the request)
  Promise.all([
    q('UPDATE participants SET last_seen_at = $1 WHERE id = $2', [now, row.id]),
    q('UPDATE participant_sessions SET last_seen_at = $1 WHERE token = $2', [now, token])
  ]).catch(() => {});
  return row;
}

async function destroyParticipantSession(token) {
  if (!token) return;
  await q('DELETE FROM participant_sessions WHERE token = $1', [token]);
}

/* --------------------------------- admins -------------------------------- */

async function createAdminSession(adminId) {
  const token = newToken();
  const now = Date.now();
  await q(
    'INSERT INTO admin_sessions (token, admin_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
    [token, adminId, now, now + HOURS * 60 * 60 * 1000]
  );
  await q('UPDATE admins SET last_login_at = $1 WHERE id = $2', [now, adminId]);
  return token;
}

async function getAdminByToken(token) {
  if (!token || typeof token !== 'string') return null;
  const row = await one(
    `SELECT a.id, a.username, a.display_name, s.expires_at
       FROM admin_sessions s
       JOIN admins a ON a.id = s.admin_id
      WHERE s.token = $1`,
    [token]
  );
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    await q('DELETE FROM admin_sessions WHERE token = $1', [token]);
    return null;
  }
  return row;
}

async function verifyAdminCredentials(username, password) {
  if (!username || !password) return null;
  const admin = await one('SELECT * FROM admins WHERE LOWER(username) = LOWER($1)', [
    String(username).trim()
  ]);
  if (!admin) return null;
  if (!bcrypt.compareSync(String(password), admin.password_hash)) return null;
  return admin;
}

async function changeAdminPassword(adminId, currentPassword, newPassword) {
  const admin = await one('SELECT * FROM admins WHERE id = $1', [adminId]);
  if (!admin) return { ok: false, error: 'Account not found' };
  if (!bcrypt.compareSync(String(currentPassword || ''), admin.password_hash)) {
    return { ok: false, error: 'Current password is incorrect' };
  }
  if (!newPassword || String(newPassword).length < 6) {
    return { ok: false, error: 'New password must be at least 6 characters' };
  }
  await q('UPDATE admins SET password_hash = $1 WHERE id = $2', [
    bcrypt.hashSync(String(newPassword), 10),
    adminId
  ]);
  await q('DELETE FROM admin_sessions WHERE admin_id = $1', [adminId]);
  return { ok: true };
}

async function isDefaultPassword(adminId) {
  try {
    const admin = await one('SELECT password_hash FROM admins WHERE id = $1', [adminId]);
    if (!admin) return false;
    for (const candidate of ['admin123', 'admin', 'password', 'admin@123', 'cricket123']) {
      if (bcrypt.compareSync(candidate, admin.password_hash)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/* ------------------------------- middleware ------------------------------ */

async function attachIdentity(req, res, next) {
  // If the identity lookup itself fails (Neon waking up, connection limit, cold start),
  // we must NOT treat the user as "signed out" — that logs the admin out on a random
  // button click. Mark the request as "identity unknown" so routes can answer 503 + retry.
  req.identityUnknown = false;
  try {
    req.participant = await getParticipantByToken(req.cookies?.[PARTICIPANT_COOKIE]);
  } catch (err) {
    console.error('[auth] participant lookup failed:', err.message);
    if (isTransient(err)) req.identityUnknown = true;
  }
  try {
    req.admin = await getAdminByToken(req.cookies?.[ADMIN_COOKIE]);
  } catch (err) {
    console.error('[auth] admin lookup failed:', err.message);
    if (isTransient(err)) req.identityUnknown = true;
  }
  if (req.cookies?.[PARTICIPANT_COOKIE] && !req.participant && !req.identityUnknown) {
    res.clearCookie(PARTICIPANT_COOKIE, { path: '/' });
  }
  next();
}

/** 503 the client can safely retry — never a 401 (which means "you are logged out"). */
function retryable(res, what) {
  res.set('Retry-After', '2');
  return res.status(503).json({
    error: `Server is waking up the database (${what}). Retrying…`,
    retry: true
  });
}

function requireParticipant(req, res, next) {
  if (!req.participant && req.identityUnknown) return retryable(res, 'participant session');
  if (!req.participant) return res.status(401).json({ error: 'Please join the poll first' });
  if (Number(req.participant.blocked)) {
    return res.status(403).json({ error: 'Your participation has been disabled by the host' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.admin && req.identityUnknown) return retryable(res, 'admin session');
  if (!req.admin) return res.status(401).json({ error: 'Admin login required' });
  next();
}

module.exports = {
  ADMIN_COOKIE,
  PARTICIPANT_COOKIE,
  cookieOptions,
  createParticipantSession,
  getParticipantByToken,
  destroyParticipantSession,
  createAdminSession,
  getAdminByToken,
  verifyAdminCredentials,
  changeAdminPassword,
  isDefaultPassword,
  attachIdentity,
  retryable,
  requireParticipant,
  requireAdmin
};
