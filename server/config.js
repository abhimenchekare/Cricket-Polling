'use strict';

module.exports = {
  port: Number(process.env.PORT || 4000),
  // Default countdown for new polls (seconds) — the admin can change it per poll
  defaultTimerSeconds: Number(process.env.DEFAULT_TIMER_SECONDS || 30),
  // Optional absolute URL used when showing the share link
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  isProduction: process.env.NODE_ENV === 'production',
  // Client refresh cadence (ms). Raise these if you have a very large audience
  // or want to stay well inside free-tier limits.
  pollIntervalActiveMs: Number(process.env.POLL_INTERVAL_ACTIVE_MS || 3000),
  pollIntervalIdleMs: Number(process.env.POLL_INTERVAL_IDLE_MS || 8000),
  /* How phones stay in sync: 'stream' (Server-Sent Events) or 'poll' (short HTTP polls).
     On Vercel the default is 'poll' — see server/routes/public.js for the reason. Override with
     LIVE_TRANSPORT=stream|poll if you move to a host without an invocation cap. */
  phoneTransport:
    process.env.LIVE_TRANSPORT === 'stream' || process.env.LIVE_TRANSPORT === 'poll'
      ? process.env.LIVE_TRANSPORT
      : (process.env.VERCEL ? 'poll' : 'stream'),
  phoneActiveMs: Number(process.env.PHONE_POLL_ACTIVE_MS || 900),
  phoneIdleMs: Number(process.env.PHONE_POLL_IDLE_MS || 3000),
  phoneRecentMs: Number(process.env.PHONE_POLL_RECENT_MS || 60000)
};
