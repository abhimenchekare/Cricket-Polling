'use strict';

const { q } = require('./db');

let cache = null;
let cacheAt = 0;
const TTL = 4000; // settings change rarely; short cache saves DB round-trips

async function allSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < TTL) return { ...cache };
  const rows = await q('SELECT key, value FROM settings');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  cache = out;
  cacheAt = Date.now();
  return { ...out };
}

async function getSetting(key, fallback = null) {
  const rows = await q('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : fallback;
}

async function setSetting(key, value) {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
  cache = null;
  return String(value);
}

function invalidateCache() {
  cache = null;
}

module.exports = { allSettings, getSetting, setSetting, invalidateCache };
