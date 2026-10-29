'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { ensureInit } = require('./db');
const auth = require('./auth');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // Vercel sits behind a proxy — needed for secure cookies + client IP
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

/* Health check (no DB needed, handy while setting up env vars) */
const PKG = require('../package.json');
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA
  ? `${PKG.version}+${String(process.env.VERCEL_GIT_COMMIT_SHA).slice(0, 7)}`
  : `${PKG.version}+local`;

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.json({
    ok: true,
    service: 'cricket-polling',
    platform: 'vercel',
    build: BUILD_ID,
    features: {
      adminTokenHeader: true, // panel survives blocked cookies
      diagnostics: true, //            /api/diag
      rapidRound: true,
      sessionRetry: true
    },
    hasDatabase: Boolean(
      process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL
    ),
    serverTime: Date.now()
  });
});

/* ------------------------------------------------------------------ */
/* Diagnostics — open /api/diag in the browser to see what THIS          */
/* deployment sees. No secrets, only booleans and counts.                */
/* ------------------------------------------------------------------ */
app.get('/api/diag', async (req, res) => {
  const db = require('./db');
  const cookieName = require('./auth').ADMIN_COOKIE;
  const reward = {};

  async function withTimeout(promise, ms, label) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL || '';
  let host = null;
  try {
    host = databaseUrl ? new URL(databaseUrl).host : null;
  } catch {
    /* ignore */
  }

  /* Region co-location is the single biggest speed lever: if the database sits in another
     continent, every query costs 200+ ms instead of ~2 ms. Work out what we can from the host. */
  const awsToVercel = {
    'us-east-1': 'iad1',
    'us-east-2': 'cle1',
    'us-west-1': 'sfo1',
    'us-west-2': 'pdx1',
    'ap-south-1': 'bom1',
    'ap-southeast-1': 'sin1',
    'ap-southeast-2': 'syd1',
    'ap-northeast-1': 'hnd1',
    'eu-central-1': 'fra1',
    'eu-west-1': 'dub1'
  };
  const awsRegion = (host && (host.match(/([a-z]{2}-[a-z]+-\d)\./) || [])[1]) || null;
  const functionRegion = process.env.VERCEL_REGION || null;
  const suggestedRegion = awsRegion ? awsToVercel[awsRegion] || null : null;

  const out = {
    ok: true,
    service: 'cricket-polling',
    serverTime: Date.now(),
    deployment: {
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
      branch: process.env.VERCEL_GIT_COMMIT_REF || null,
      url: process.env.VERCEL_URL || null,
      env: process.env.VERCEL_ENV || null,
      region: process.env.VERCEL_REGION || null
    },
    config: {
      nodeEnv: process.env.NODE_ENV || null,
      cookieSecure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === '1',
      adminSessionHours: Number(process.env.ADMIN_SESSION_HOURS || 12),
      participantSessionDays: Number(process.env.PARTICIPANT_SESSION_DAYS || 7),
      databaseHost: host,
      databaseAwsRegion: awsRegion,
      functionRegion,
      suggestedVercelRegion: suggestedRegion,
      regionMatches: Boolean(suggestedRegion && functionRegion && suggestedRegion === functionRegion),
      node: process.version
    },
    request: {
      hasAdminCookie: Boolean(req.cookies && req.cookies[cookieName]),
      adminCookieLength: (req.cookies && req.cookies[cookieName] && req.cookies[cookieName].length) || 0,
      hasParticipantCookie: Boolean(req.cookies && req.cookies.cp_participant),
      secureRequest: req.protocol === 'https'
    },
    database: { configured: Boolean(databaseUrl), reachable: false, latencyMs: null, error: null },
    perf: { stateMs: null },
    schema: {},
    counts: {}
  };

  // 0) How long does building the full public state take here? (this is what a page waits for)
  if (databaseUrl) {
    try {
      const t = Date.now();
      await withTimeout(require('./state').buildPublicState(null), 8000, 'state');
      out.perf.stateMs = Date.now() - t;
    } catch (err) {
      out.perf.stateError = err.message;
    }
  }

  // 1) Can we even talk to Postgres?
  if (databaseUrl) {
    const started = Date.now();
    try {
      await withTimeout(db.q('SELECT 1'), 6000, 'database');
      out.database.reachable = true;
      out.database.latencyMs = Date.now() - started;
    } catch (err) {
      out.database.error = err.message;
    }
  }

  // 2) Do the tables exist? (a half-created schema looks exactly like "logged out")
  if (out.database.reachable) {
    try {
      const tables = await withTimeout(
        db.q(
          `SELECT tablename FROM pg_tables WHERE schemaname = ANY (current_schemas(false))
             AND tablename IN ('admins','admin_sessions','participants','participant_sessions',
                               'polls','options','votes','settings','activity_log')`
        ),
        6000,
        'schema'
      );
      const found = tables.map((t) => t.tablename);
      ['admins', 'admin_sessions', 'participants', 'participant_sessions', 'polls', 'options', 'votes', 'settings'].forEach(
        (t) => (out.schema[t] = found.includes(t))
      );
    } catch (err) {
      out.schema.error = err.message;
    }

    // 3) Counts
    try {
      const c = await withTimeout(
        db.one(
          `SELECT (SELECT COUNT(*) FROM admins)::int AS admins,
                  (SELECT COUNT(*) FROM admin_sessions)::int AS admin_sessions,
                  (SELECT COUNT(*) FROM admin_sessions WHERE expires_at < $1)::int AS expired_sessions,
                  (SELECT COUNT(*) FROM participants)::int AS participants,
                  (SELECT COUNT(*) FROM polls)::int AS polls`,
          [Date.now()]
        ),
        6000,
        'counts'
      );
      out.counts = c || {};
    } catch (err) {
      out.counts.error = err.message;
    }

    // 4) Is the CALLER's admin cookie a real session? (the thing that decides your logout)
    const token = req.cookies && req.cookies[cookieName];
    if (token) {
      try {
        const row = await withTimeout(
          db.one('SELECT expires_at FROM admin_sessions WHERE token = $1', [token]),
          6000,
          'session'
        );
        out.request.adminCookieFoundInDatabase = Boolean(row);
        out.request.adminSessionExpired = row ? Number(row.expires_at) < Date.now() : null;
        out.request.adminSessionExpiresInMs = row ? Number(row.expires_at) - Date.now() : null;
      } catch (err) {
        out.request.sessionLookupError = err.message;
      }
    }

    try {
      out.schema.schemaVersion = await db.scalar("SELECT value FROM settings WHERE key = 'schema_version'");
    } catch {
      /* ignore */
    }
  }

  res.set('Cache-Control', 'no-store, max-age=0');
  res.json(out);
});

/* Everything below goes through one identity lookup + schema bootstrap */
app.use('/api', ensureInit, auth.attachIdentity);
app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* Local development: serve the static pages too (on Vercel the CDN does this). */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

const PAGES = {
  '/': 'index.html',
  '/join': 'index.html',
  '/poll': 'poll.html',
  '/vote-confirmed': 'vote-confirmed.html',
  '/results': 'results.html',
  '/display': 'display.html',
  '/projector': 'display.html',
  '/admin-login': 'admin-login.html',
  '/admin': 'admin.html',
  '/admin/polls': 'admin-polls.html',
  '/admin/participants': 'admin-participants.html',
  '/admin/history': 'admin-history.html',
  '/admin/players': 'admin-players.html'
};
for (const [route, file] of Object.entries(PAGES)) {
  app.get(route, (req, res) => res.sendFile(path.join(PUBLIC_DIR, file)));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = app;
