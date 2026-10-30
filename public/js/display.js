/* Full-screen presentation mode — the winners board.
 *
 * The big screen answers one question only: who has guessed the most players accurately?
 * 1st, 2nd and 3rd, with how many accurate guesses each of them has.
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
        loadBoard(false);
      }
    });

    renderClock();
    setInterval(renderClock, 1000);
    loadBoard(true);
    setInterval(() => loadBoard(false), 8000);
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
        .map((s) => `${s.name}:${s.nearest}:${s.exact}`)
        .join('|');

      const isNew = Boolean(previous && signature !== lastSignature);
      lastSignature = signature;

      /* first paint on load, and every time a result changes → bat meets ball first */
      if (force || isNew) {
        playSwing(() => renderBoard());
      } else {
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
          <div class="dp-board-title">Most accurate guesses</div>
          <div class="dp-board-sub">${board.rounds} of ${board.players} players sold</div>
        </div>

        ${
          top.length
            ? ''
            : `<div class="dp-board-empty">Sold prices are in, but nobody guessed yet — the board fills the moment the first accurate guess lands.</div>`
        }
        <div class="dp-podium">
          ${top
            .map(
              (s) => `
            <div class="dp-winner rank-${s.rank}">
              <div class="dp-winner-badge">${medalLabel(s.rank)}</div>
              <div class="dp-winner-name">${escapeHtml(s.name)}</div>
              <div class="dp-winner-score">
                <strong>${s.nearest}</strong>
                <span>accurate ${s.nearest === 1 ? 'guess' : 'guesses'}</span>
              </div>
              ${s.exact ? `<div class="dp-winner-exact">${s.exact} spot on</div>` : '<div class="dp-winner-exact is-empty">&nbsp;</div>'}
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
