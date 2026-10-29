'use strict';

/**
 * The bid ladder used for "what will this player sell for?" rounds.
 *
 * All amounts are INTEGER LAKH, so comparisons are exact (no float drift):
 *   20  = 20 L      100 = 1.00 Cr      3000 = 30.00 Cr
 *
 * Shape (matches the auction board):
 *   20 L, 40 L, 60 L, 80 L
 *   1.00 Cr → 9.75 Cr   in 0.25 Cr steps
 *   10.0 Cr → 30.0 Cr   in 0.50 Cr steps
 */

const LADDER_LAKH = (() => {
  const out = [20, 40, 60, 80];
  for (let lakh = 100; lakh <= 975; lakh += 25) out.push(lakh); // 1.00 … 9.75 Cr
  for (let lakh = 1000; lakh <= 3000; lakh += 50) out.push(lakh); // 10.0 … 30.0 Cr
  return out;
})();

/**
 * Human label for a lakh value, matching the auction board:
 *   "60 L", "1.00 Cr", "1.50 Cr", "9.75 Cr", "10.5 Cr", "30.0 Cr"
 * Below 10 Cr always two decimals (prices step by 0.25); 10 Cr and above one decimal (0.50 steps).
 */
function label(lakh) {
  const n = Number(lakh);
  if (!Number.isFinite(n)) return '—';
  if (n < 100) return `${n} L`;
  const cr = n / 100;
  return cr >= 10 ? `${cr.toFixed(1)} Cr` : `${cr.toFixed(2)} Cr`;
}

/** Short label for tight UI spots: "60L", "1.25Cr". */
function shortLabel(lakh) {
  return label(lakh).replace(' Cr', 'Cr');
}

const LAKH_SET = new Set(LADDER_LAKH);

/** Is this a value a participant is allowed to pick? */
function isValidGuess(lakh) {
  const n = Number(lakh);
  return Number.isInteger(n) && LAKH_SET.has(n);
}

/** Nearest ladder value to an arbitrary amount (used by the admin's custom input). */
function nearestOnLadder(lakh) {
  const n = Number(lakh);
  if (!Number.isFinite(n)) return LADDER_LAKH[0];
  let best = LADDER_LAKH[0];
  let bestDiff = Infinity;
  for (const v of LADDER_LAKH) {
    const d = Math.abs(v - n);
    if (d < bestDiff) {
      bestDiff = d;
      best = v;
    }
  }
  return best;
}

/** Index of a value on the ladder (or -1). */
function indexOf(lakh) {
  return LADDER_LAKH.indexOf(Number(lakh));
}

/** Signed difference in "steps" of the ladder — used to nudge winners on re-render. */
function stepDistance(a, b) {
  const ia = indexOf(a);
  const ib = indexOf(b);
  if (ia < 0 || ib < 0) return null;
  return Math.abs(ia - ib);
}

/**
 * Parse a price the host typed by hand into lakh. Accepts the shapes a human actually types:
 *   "1.85 Cr" → 185   "1.85cr" → 185   "1.85" → 185   "185 L" → 185   "185" → 185   "2 Cr" → 200
 * Returns null when it is not a usable price.
 */
function parsePrice(text) {
  const raw = String(text == null ? '' : text).trim().toLowerCase();
  if (!raw) return null;
  const m = raw.match(/^(?:₹|rs\.?\s*)?([0-9]+(?:\.[0-9]+)?)\s*(cr|crore|crores|l|lakh|lakhs|k)?\.?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  let lakh;
  if (unit === 'l' || unit === 'lakh' || unit === 'lakhs') lakh = n;
  else if (unit === 'cr' || unit === 'crore' || unit === 'crores') lakh = n * 100;
  else lakh = n < 100 ? n * 100 : n; // bare number: "1.85" means crore, "185" means lakh
  const rounded = Math.round(lakh);
  return rounded > 0 && rounded <= 10000 ? rounded : null;
}

module.exports = {
  LADDER_LAKH,
  label,
  shortLabel,
  isValidGuess,
  nearestOnLadder,
  indexOf,
  stepDistance,
  parsePrice
};
