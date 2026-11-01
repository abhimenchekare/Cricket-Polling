'use strict';

/**
 * 📈 A tiny in-process stopwatch for the API.
 *
 * Serverless has no APM by default, and "it feels slow" is not something anyone can act on. This
 * keeps the last 200 request durations (per route, in the browser's own words), plus the timings of
 * the individual steps of the shout/settle paths, so the host can open /admin-speed on the real
 * deployment and see exactly which call is costing seconds.
 *
 * It is a ring buffer in memory — no database writes, no measurable cost.
 */

const RING = 200;
const requests = [];
const steps = [];

function record(method, route, ms, status, cold) {
  requests.push({ at: Date.now(), method, route, ms, status, cold: Boolean(cold) });
  if (requests.length > RING) requests.shift();
}

function step(name, ms, extra) {
  steps.push({ at: Date.now(), name, ms, extra: extra || null });
  if (steps.length > RING) steps.shift();
}

/** Express middleware: times every /api request and remembers the slow ones. */
function middleware(req, res, next) {
  const started = process.hrtime.bigint();
  const bootedAt = Date.now() - process.uptime() * 1000;
  const cold = Date.now() - STARTED_AT < 8000; // roughly: still inside the first seconds of this process
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const route = (req.baseUrl || '') + (req.route ? req.route.path : req.path || '');
    // key by the URL pattern, not by ids, so the numbers group
    const clean = String(route).replace(/\/\d+(?=\/|$)/g, '/:id');
    record(req.method, clean, Math.round(ms), res.statusCode, cold);
  });
  next();
}

const STARTED_AT = Date.now();

/** Time one async block and store it. */
async function timed(name, fn, extra) {
  const t = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    step(name, Math.round(Number(process.hrtime.bigint() - t) / 1e6), extra);
  }
}

function percentile(list, p) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Grouped summary, slowest first. */
function summary() {
  const byRoute = new Map();
  for (const r of requests) {
    const key = `${r.method} ${r.route}`;
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key).push(r.ms);
  }
  const routes = [...byRoute.entries()]
    .map(([key, list]) => ({
      route: key,
      calls: list.length,
      p50: percentile(list, 50),
      p95: percentile(list, 95),
      max: Math.max(...list),
      avg: Math.round(list.reduce((a, b) => a + b, 0) / list.length)
    }))
    .sort((a, b) => b.p95 - a.p95);

  return {
    routes,
    steps: steps.slice(-40),
    slowest: [...requests].sort((a, b) => b.ms - a.ms).slice(0, 12)
  };
}

module.exports = { middleware, record, step, timed, summary, STARTED_AT };
