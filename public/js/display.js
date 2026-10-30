/* Full-screen presentation mode — the winners board.
 *
 * The big screen answers one question only: who has nailed the most sold prices exactly?
 * 1st, 2nd and 3rd, with how many right bids each of them has (closest calls break the tie).
 *
 * Every time a sold price lands, a bat-and-ball reveal plays before the winners reappear.
 */
(function () {
  'use strict';
  const { API, escapeHtml } = window.App;

  let board = null;
  let clockOffset = 0;
  let lastSignature = '';
  let revealTimer = null;
  let firstLoad = true;
  /* What the board is currently showing. Repainting identical numbers used to restart the entry
     animations, which is why the winners appeared to blink over and over. */
  let paintedSignature = '';
  let lastSold = -1;

  const mainEl = document.getElementById('dp-main');
  const participantsEl = document.getElementById('dp-participants');
  const soldEl = document.getElementById('dp-sold');
  const clockEl = document.getElementById('dp-clock');
  const hintEl = document.getElementById('dp-hint');
  const swingEl = document.getElementById('dp-swing');

  function renderClock() {
    if (clockEl) {
      clockEl.textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
  }

  async function init() {
    try {
      const meta = await API.get('/api/meta');
      window.__meta = meta;
      window.__eventName = meta.event.name;
      document.querySelectorAll('[data-event-name]').forEach((el) => (el.textContent = meta.event.name));
      document.querySelectorAll('[data-event-tagline]').forEach((el) => (el.textContent = meta.event.tagline || ''));
      document.title = `${meta.event.name} · Winners`;
      const urlEl = document.getElementById('dp-url');
      if (urlEl) urlEl.textContent = meta.join.joinUrl.replace(/^https?:\/\//, '');
    } catch {
      /* the poller below retries */
    }

    window.App.createLiveChannel({
      url: '/api/state',
      activeInterval: 2000,
      idleInterval: 5000,
      hiddenMultiplier: 2,
      onData: (payload) => {
        clockOffset = payload.serverTime - Date.now();
        if (participantsEl) participantsEl.textContent = payload.stats.participants;
        /* The standings query is the expensive one. Only run it when a player was actually sold —
           a vote, a join or a heartbeat must never re-fetch the whole ledger. */
        const sold = payload.auction ? Number(payload.auction.sold) || 0 : 0;
        if (sold !== lastSold) {
          lastSold = sold;
          loadBoard(false);
        }
      }
    });

    renderClock();
    setInterval(renderClock, 1000);
    loadBoard(true);
    /* Safety net: if a push is ever missed the board still catches up, just gently. */
    setInterval(() => lastSold = -1, 20000);
  }

  /* ------------------------------ the board ------------------------------ */

  let revealing = false;

  async function loadBoard(force) {
    try {
      const data = await API.get('/api/standings');
      const previous = board;
      board = data && data.standings ? data : null;

      /* while the ball is in the air nothing may repaint the board underneath it */
      if (revealing) return;

      if (!board || !board.rounds) {
        renderEmpty();
        return;
      }

      if (soldEl) soldEl.textContent = board.rounds;

      const signature = board.standings
        .slice(0, 3)
        .map((s) => `${s.name}:${s.exact}:${s.closest}:${s.top3}`)
        .join('|');

      const isNew = Boolean(previous && signature !== lastSignature);
      lastSignature = signature;

      /* Only touch the DOM when the answer actually changed. Re-writing the same HTML every
         couple of seconds restarts the entrance animation — that is the blinking. */
      if (!force && signature === paintedSignature) return;

      /* first paint on load, and every time a result changes → bat meets ball first */
      if (force || isNew) {
        playSwing(() => {
          paintedSignature = signature;
          renderBoard();
        });
      } else {
        paintedSignature = signature;
        renderBoard();
      }
      if (firstLoad) firstLoad = false;
    } catch {
      /* leave whatever is on screen */
    }
  }

  function medalLabel(rank) {
    return rank === 1 ? '1st' : rank === 2 ? '2nd' : '3rd';
  }

  /* A real medal: gold / silver / bronze, with ribbon. Drawn inline so it never needs a network
     request on the projector. */
  function medalSvg(rank) {
    const tones = {
      1: ['#ffe28a', '#f6c453', '#b8860b'],
      2: ['#f2f6fb', '#cfd8e3', '#8e9bb0'],
      3: ['#f5c99a', '#e0a370', '#9c6432']
    };
    const [light, mid, dark] = tones[rank] || tones[3];
    return `
      <svg class="dp-medal" viewBox="0 0 64 84" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="dpMedalG${rank}" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="${light}" />
            <stop offset="52%" stop-color="${mid}" />
            <stop offset="100%" stop-color="${dark}" />
          </linearGradient>
        </defs>
        <path d="M20 2 L30 34 L18 34 Z" fill="#e5484d" opacity=".9" />
        <path d="M44 2 L34 34 L46 34 Z" fill="#2f6fed" opacity=".9" />
        <circle cx="32" cy="52" r="27" fill="url(#dpMedalG${rank})" stroke="${dark}" stroke-width="2.5" />
        <circle cx="32" cy="52" r="20" fill="none" stroke="${dark}" stroke-width="1.6" opacity=".55" />
        <text x="32" y="60" text-anchor="middle" class="dp-medal-num">${rank}</text>
        <path class="dp-medal-shine" d="M18 38 q6 -10 16 -12" stroke="#fff" stroke-width="3.4"
              fill="none" stroke-linecap="round" opacity=".75" />
      </svg>`;
  }

  function renderEmpty() {
    if (soldEl) soldEl.textContent = '0';
    mainEl.className = 'dp-main';
    mainEl.innerHTML = `
      <div class="dp-idle fade-up">
        <h1>${escapeHtml(window.__eventName || 'Cricket Auction Live Polls')}</h1>
        <p>No player has been sold yet. The winners board lights up the moment the first price is entered.</p>
        <div class="dp-idle-link">
          <div class="dp-idle-link-label">Open on your phone</div>
          <div class="dp-idle-link-url" id="dp-idle-url">—</div>
        </div>
        <div class="row" style="justify-content:center;gap:10px;flex-wrap:wrap">
          <span class="pill pill-live"><span class="dot"></span>Guessing is open</span>
        </div>
      </div>`;
    try {
      const meta = window.__meta;
      const idleUrl = document.getElementById('dp-idle-url');
      if (idleUrl && meta) idleUrl.textContent = meta.join.joinUrl.replace(/^https?:\/\//, '');
    } catch {
      /* cosmetic */
    }
    if (hintEl) hintEl.textContent = 'Waiting for the first sold price';
  }

  function renderBoard() {
    if (!board || !board.rounds) return renderEmpty();
    const top = board.standings.slice(0, 3);
    mainEl.className = 'dp-main dp-board-main';

    mainEl.innerHTML = `
      <div class="dp-board fade-up">
        <div class="dp-board-head">
          <div class="dp-board-title">Right on the price</div>
          <div class="dp-board-sub">${board.rounds} of ${board.players} players sold · most right bids wins</div>
        </div>

        ${
          top.length
            ? ''
            : `<div class="dp-board-empty">Sold prices are in, but nobody guessed yet — the board fills the moment the first guess lands.</div>`
        }
        <div class="dp-podium">
          ${top
            .map(
              (s) => `
            <div class="dp-winner rank-${s.rank}">
              ${medalSvg(s.rank)}
              <div class="dp-winner-badge">${medalLabel(s.rank)}</div>
              <div class="dp-winner-name">${escapeHtml(s.name)}</div>
              <div class="dp-winner-score">
                <strong>${s.exact}</strong>
                <span>${s.exact === 1 ? 'right bid' : 'right bids'}</span>
              </div>
              <div class="dp-winner-exact${s.closest ? '' : ' is-empty'}">${
                s.closest ? `${s.closest} closest ${s.closest === 1 ? 'call' : 'calls'}` : '&nbsp;'
              }</div>
            </div>`
            )
            .join('')}
        </div>
      </div>`;

    if (hintEl) hintEl.textContent = `${board.rounds} ${board.rounds === 1 ? 'player' : 'players'} sold`;
  }

  /* --------------------------- the bat & ball ---------------------------- */

  /**
   * Plays the swing, then hands control back so the winners fade in.
   * 2000 ms total — long enough to feel like a moment, short enough not to stall the room.
   */
  function playSwing(after) {
    if (!swingEl) {
      after();
      return;
    }
    clearTimeout(revealTimer);
    revealing = true;
    // hide the board while the ball is in the air
    const current = mainEl.querySelector('.dp-board');
    if (current) current.classList.add('is-hidden');

    swingEl.classList.remove('is-playing');
    void swingEl.offsetWidth; // restart the keyframes
    swingEl.classList.add('is-playing');

    revealTimer = setTimeout(() => {
      swingEl.classList.remove('is-playing');
      revealing = false;
      after();
      window.App.confetti(1800);
    }, 2000);
  }

  /* ---------------------------- full screen ---------------------------- */

  const fsBtn = document.getElementById('fs-btn');
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }
  fsBtn?.addEventListener('click', toggleFullscreen);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    if (e.key === 'r' || e.key === 'R') playSwing(() => renderBoard());
    document.body.classList.add('show-controls');
    setTimeout(() => document.body.classList.remove('show-controls'), 2600);
  });
  document.addEventListener('mousemove', () => {
    document.body.classList.add('show-controls');
    clearTimeout(window.__ct);
    window.__ct = setTimeout(() => document.body.classList.remove('show-controls'), 2600);
  });

  renderClock();
  init();
})();
