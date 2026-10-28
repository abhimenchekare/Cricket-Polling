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
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'cricket-polling',
    platform: 'vercel',
    hasDatabase: Boolean(
      process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL
    ),
    serverTime: Date.now()
  });
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
  '/admin/history': 'admin-history.html'
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
