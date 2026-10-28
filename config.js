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
  pollIntervalIdleMs: Number(process.env.POLL_INTERVAL_IDLE_MS || 8000)
};
