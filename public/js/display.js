/* Full-screen presentation mode */
(function () {
  'use strict';
  const { API, escapeHtml, formatClock } = window.App;

  let state = null;
  let clockOffset = 0;
  let lastStatus = null;
  let lastPollId = null;

  const mainEl = document.getElementById('dp-main');
  const participantsEl = document.getElementById('dp-participants');
  const votesEl = document.getElementById('dp-votes');
  const clockEl = document.getElementById('dp-clock');
  const urlEl = document.getElementById('dp-url');
  const hintEl = document.getElementById('dp-hint');

  function serverNow() {
    return Date.now() + clockOffset;
  }

  async function init() {
    try {
      const meta = await API.get('/api/meta');
      document.querySelectorAll('[data-event-name]').forEach((el) => (el.textContent = meta.event.name));
      document.querySelectorAll('[data-event-tagline]').forEach((el) => (el.textContent = meta.event.tagline || ''));
      document.title = `${meta.event.name} · Big Screen`;
      const urlEl2 = document.getElementById('dp-url');
      if (urlEl2) urlEl2.textContent = meta.join.joinUrl.replace(/^https?:\/\//, '');
      window.__meta = meta;
    } catch {
      /* retried by the poller below */
    }

    window.App.createRealtime({
      url: '/api/state',
      activeInterval: 2000,
      idleInterval: 5000,
      hiddenMultiplier: 2,
      onData: (payload) => {
        clockOffset = payload.serverTime - Date.now();
        state = payload;
        render();
      }
    });

    setInterval(tick, 200);
    setInterval(renderClock, 1000);
  }

  function renderClock() {
    if (clockEl) {
      clockEl.textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
  }

  function animBars() {
    requestAnimationFrame(() => {
      mainEl.querySelectorAll('.dp-bar-fill, .dp-progress-fill').forEach((b) => {
        b.style.width = `${b.dataset.w}%`;
      });
    });
  }

  function render() {
    if (!state) return;
    const p = state.poll;
    participantsEl.textContent = state.stats.participants;
    votesEl.textContent = p ? p.totalVotes : 0;
    renderClock();

    if (!p) {
      renderIdle();
      lastStatus = null;
      return;
    }

    const statusChanged = p.id === lastPollId && lastStatus && lastStatus !== p.status;
    lastStatus = p.status;
    lastPollId = p.id;

    if (p.status === 'closed') {
      renderClosed(p);
      if (statusChanged) window.App.confetti(2600);
      return;
    }
    if (p.status === 'paused') {
      renderPaused(p);
      return;
    }
    renderActive(p);
  }

  function renderIdle() {
    const meta = window.__meta;
    mainEl.className = 'dp-main';
    mainEl.innerHTML = `
      <div class="dp-idle fade-up">
        <h1>${escapeHtml(state.event.name)}</h1>
        <p>${escapeHtml(state.event.displayMessage || 'The next poll is about to begin. Open the link on your phone and get ready to vote!')}</p>
        <div class="dp-idle-link">
          <div class="dp-idle-link-label">Open on your phone</div>
          <div class="dp-idle-link-url" id="dp-idle-url">—</div>
        </div>
        <div class="row" style="justify-content:center;gap:10px;flex-wrap:wrap">
          <span class="pill pill-live"><span class="dot"></span>${state.stats.participants} participants ready</span>
          <span class="pill pill-gold">Next poll soon</span>
        </div>
      </div>`;
    const idleUrl = document.getElementById('dp-idle-url');
    if (idleUrl && window.__meta) {
      idleUrl.textContent = window.__meta.join.joinUrl.replace(/^https?:\/\//, '');
    }
    hintEl.textContent = 'Waiting for the host to start a poll';
  }

  function renderPaused(p) {
    mainEl.className = 'dp-main';
    mainEl.innerHTML = `
      <div class="dp-idle fade-up">
        <span class="pill pill-paused" style="font-size:clamp(12px,1.1vw,18px);padding:8px 18px">⏸ Voting paused</span>
        <h1 class="dp-question" style="font-size:clamp(24px,3.4vw,56px)">${escapeHtml(p.question)}</h1>
        <p>The host has paused voting. Hang tight — we'll resume shortly.</p>
        <div class="row" style="justify-content:center;gap:10px">
          <span class="pill pill-ghost">${p.totalVotes} votes so far</span>
          <span class="pill pill-ghost">${state.stats.participants} participants</span>
        </div>
      </div>`;
    hintEl.textContent = 'Voting paused';
  }

  function winnerHtml(p) {
    const results = p.results;
    if (!results || !results.leadingOptionId) {
      return `
        <div class="dp-winner">
          <div class="trophy">🏏</div>
          <div class="win-label">Poll closed</div>
          <div class="win-name">It's a tie!</div>
          <p class="muted">${p.totalVotes} votes counted</p>
        </div>`;
    }
    const row = results.rows.find((r) => r.optionId === results.leadingOptionId);
    return `
      <div class="dp-winner">
        <div class="trophy">🏆</div>
        <div class="win-label">Audience winner</div>
        <div class="win-name">${row.emoji ? escapeHtml(row.emoji) + ' ' : ''}${escapeHtml(row.label)}</div>
        <p class="muted" style="font-size:clamp(13px,1.2vw,20px)">${row.percent}% · ${row.votes} of ${p.totalVotes} votes</p>
      </div>`;
  }

  function renderClosed(p) {
    if (p.pollType === 'bid') return renderBid(p, { closed: true });
    const showResults = p.resultsVisible && p.results;
    mainEl.className = 'dp-main split';
    mainEl.innerHTML = `
      <div class="fade-up">
        ${showResults ? winnerHtml(p) : `<div class="dp-winner"><div class="trophy">🔒</div><div class="win-label">Poll closed</div><div class="win-name">Results private</div></div>`}
        <div class="dp-question dp-question-sm" style="margin-top:clamp(10px,1.4vw,24px);max-width:34ch">${escapeHtml(p.question)}</div>
      </div>
      ${showResults ? `<div class="dp-results">${p.results.rows
        .map(
          (r) => `
        <div class="dp-result ${p.results.leadingOptionId === r.optionId ? 'is-leader' : ''}">
          <div class="dp-result-top">
            <span class="dp-result-label">${r.emoji ? escapeHtml(r.emoji) + ' ' : ''}${escapeHtml(r.label)}</span>
            <span class="dp-result-votes">${r.votes}</span>
            <span class="dp-result-pct">${r.percent}%</span>
          </div>
          <div class="dp-bar"><div class="dp-bar-fill" data-w="${r.percent}"></div></div>
        </div>`
        )
        .join('')}</div>` : ''}`;
    animBars();
    hintEl.textContent = `Poll closed · ${p.totalVotes} votes`;
  }

  /* 🎯 Bid round: big player name + guesses so far, then the winners podium. */
  function renderBid(p, { closed = false } = {}) {
    const showResults = p.resultsVisible && p.results && p.results.kind === 'bid';
    mainEl.className = 'dp-main split';
    const medal = ['🥇', '🥈', '🥉'];

    const podium = showResults
      ? `<div class="dp-results">
           <div class="dp-bid-sold">
             <span class="mute-sm">SOLD FOR</span>
             <strong>${escapeHtml(p.results.actualLabel || '—')}</strong>
           </div>
           ${p.results.winners
             .map(
               (w) => `
             <div class="dp-result is-leader dp-bid-winner">
               <div class="dp-result-top">
                 <span class="dp-result-label">${medal[w.rank - 1] || '#' + w.rank} ${escapeHtml(w.name)}</span>
                 <span class="dp-result-pct">${escapeHtml(w.guessLabel)}</span>
               </div>
               <div class="mute-sm" style="padding:4px 2px 8px">${escapeHtml(w.diffLabel)} ${w.direction === 'exact' ? '— spot on!' : w.direction}</div>
             </div>`
             )
             .join('')}
         </div>`
      : `<div class="dp-panel dp-open">
           <div class="dp-open-icon">🎯</div>
           <div class="dp-open-title">Guess the price</div>
           <p class="muted" style="font-size:clamp(12px,1.05vw,18px);max-width:34ch">
             Drag the price bar on your phone. ${
               closed ? 'The host will enter the sold price in a moment.' : 'Closest guess wins.'
             }
           </p>
           <div class="dp-progress">
             <div class="dp-progress-top"><span>${p.totalVotes} ${window.App.plural(p.totalVotes, 'guess', 'guesses')}</span><span>${closed ? 'closed' : 'live'}</span></div>
             <div class="dp-progress-bar"><div class="dp-progress-fill" data-w="${closed ? 100 : 60}"></div></div>
           </div>
         </div>`;

    mainEl.innerHTML = `
      <div class="fade-up">
        <div class="dp-row" style="margin-bottom:clamp(8px,1vw,18px)">
          <span class="pill ${closed ? 'pill-closed' : 'pill-live'}" style="font-size:clamp(10px,.9vw,15px);padding:6px 14px">
            ${closed ? 'ROUND CLOSED' : '<span class="dot"></span>LIVE BID ROUND'}
          </span>
          <span class="pill pill-ghost" style="font-size:clamp(10px,.9vw,15px);padding:6px 14px">${p.totalVotes} ${window.App.plural(p.totalVotes, 'guess', 'guesses')}</span>
        </div>
        ${p.playerName ? `<div class="dp-bid-player">${escapeHtml(p.playerName)}</div>` : ''}
        <h1 class="dp-question" style="margin-top:clamp(6px,1vw,14px)">${escapeHtml(p.question)}</h1>
        ${
          !closed
            ? `<div class="dp-row" style="margin-top:clamp(14px,1.8vw,30px)">
                 <div class="dp-timer ${p.endsAt ? '' : 'hidden'}" id="dp-timer">
                   <div class="dp-ring" id="dp-ring" style="--pct:100"></div>
                   <span id="dp-timer-text">--:--</span>
                 </div>
                 <div class="dp-hint" style="text-align:left;margin-left:0;letter-spacing:0">Guess on your phone now</div>
               </div>`
            : ''
        }
      </div>
      ${podium}`;
    animBars();
    hintEl.textContent = showResults ? 'Winners' : closed ? 'Waiting for the sold price' : 'Bid round live';
  }

  function renderActive(p) {
    if (p.pollType === 'bid') return renderBid(p);
    const showResults = p.resultsVisible && p.results;
    mainEl.className = 'dp-main split';
    const hasTimer = !!p.endsAt;
    const totalParticipants = Math.max(state.stats.participants, p.totalVotes);
    const turnout = totalParticipants ? Math.min(100, (p.totalVotes / totalParticipants) * 100) : 0;
    mainEl.innerHTML = `
      <div class="fade-up">
        <div class="dp-row" style="margin-bottom:clamp(8px,1vw,18px)">
          <span class="pill pill-live" style="font-size:clamp(10px,.9vw,15px);padding:6px 14px"><span class="dot"></span>LIVE POLL</span>
          ${p.category ? `<span class="pill pill-ghost" style="font-size:clamp(10px,.9vw,15px);padding:6px 14px">${escapeHtml(p.category)}</span>` : ''}
          <span class="pill pill-ghost" style="font-size:clamp(10px,.9vw,15px);padding:6px 14px">${p.totalVotes} votes</span>
        </div>
        <h1 class="dp-question">${escapeHtml(p.question)}</h1>
        <div class="dp-row" style="margin-top:clamp(14px,1.8vw,30px)">
          <div class="dp-timer ${hasTimer ? '' : 'hidden'}" id="dp-timer">
            <div class="dp-ring" id="dp-ring" style="--pct:100"></div>
            <span id="dp-timer-text">--:--</span>
          </div>
          <div class="dp-hint" style="text-align:left;margin-left:0;letter-spacing:0">
            Vote on your phone now${p.anonymous ? ' · anonymous' : ''}
          </div>
        </div>
      </div>
      ${
        showResults
          ? `<div class="dp-results">${p.results.rows
              .map(
                (r) => `
            <div class="dp-result ${p.results.leadingOptionId === r.optionId ? 'is-leader' : ''}">
              <div class="dp-result-top">
                <span class="dp-result-label">${r.emoji ? escapeHtml(r.emoji) + ' ' : ''}${escapeHtml(r.label)}</span>
                <span class="dp-result-votes">${r.votes}</span>
                <span class="dp-result-pct">${r.percent}%</span>
              </div>
              <div class="dp-bar"><div class="dp-bar-fill" data-w="${r.percent}"></div></div>
            </div>`
              )
              .join('')}</div>`
          : `<div class="dp-panel dp-open">
               <div class="dp-open-icon">🗳️</div>
               <div class="dp-open-title">Voting is open</div>
               <p class="muted" style="font-size:clamp(12px,1.05vw,18px);max-width:34ch">
                 Open the link at the bottom on your phone, pick your answer and watch the big screen.
                 ${p.anonymous ? 'Votes are anonymous.' : 'One vote per person.'}
               </p>
               <div class="dp-progress">
                 <div class="dp-progress-top">
                   <span>${p.totalVotes} votes in</span>
                   <span>${Math.round(turnout)}% turnout</span>
                 </div>
                 <div class="dp-progress-bar"><div class="dp-progress-fill" id="dp-turnout" data-w="${turnout.toFixed(1)}"></div></div>
               </div>
               <div class="row" style="justify-content:center;gap:10px;flex-wrap:wrap">
                 <span class="pill pill-gold">Results revealed by the host</span>
               </div>
             </div>`
      }`;
    animBars();
    hintEl.textContent = showResults ? 'Live results' : 'Results hidden until reveal';
  }

  function tick() {
    if (!state || !state.poll) return;
    const p = state.poll;
    const textEl = document.getElementById('dp-timer-text');
    const ringEl = document.getElementById('dp-ring');
    const timerEl = document.getElementById('dp-timer');
    if (!textEl || !ringEl || !timerEl) return;
    if (!p.endsAt) {
      textEl.textContent = 'No limit';
      return;
    }
    const remaining = Math.max(0, p.endsAt - serverNow());
    textEl.textContent = formatClock(remaining);
    const total = Math.max(1, p.endsAt - (p.startedAt || p.endsAt - p.timerSeconds * 1000));
    ringEl.style.setProperty('--pct', ((remaining / total) * 100).toFixed(1));
    timerEl.classList.toggle('is-urgent', remaining <= 10_000);
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
    document.body.classList.add('show-controls');
    setTimeout(() => document.body.classList.remove('show-controls'), 2600);
  });
  document.addEventListener('mousemove', () => {
    document.body.classList.add('show-controls');
    clearTimeout(window.__ct);
    window.__ct = setTimeout(() => document.body.classList.remove('show-controls'), 2600);
  });

  setInterval(renderClock, 1000);
  renderClock();
  init();
  setInterval(() => {
    if (!state) API.get('/api/state').then((s) => { state = s; render(); }).catch(() => {});
  }, 8000);
})();
