/* Participant polling dashboard */
(function () {
  'use strict';
  const { API, toast, escapeHtml, formatClock, statusPill, haptic, setBusy } = window.App;

  let state = null;
  let meta = null;
  let clockOffset = 0; // serverTime - localTime
  let selectedOptionId = null;
  let lastPollId = null;
  let submitting = false;

  const els = {
    pollArea: document.getElementById('poll-area'),
    resultsArea: document.getElementById('results-area'),
    historyArea: document.getElementById('history-area'),
    greetName: document.getElementById('greet-name'),
    greetSub: document.getElementById('greet-sub'),
    avatar: document.getElementById('avatar'),
    conn: document.getElementById('conn'),
    eventName: document.querySelectorAll('[data-event-name]'),
    eventTagline: document.querySelectorAll('[data-event-tagline]'),
    statsBar: document.getElementById('stats-bar')
  };

  function serverNow() {
    return Date.now() + clockOffset;
  }

  /* ------------------------------ bootstrap ------------------------------ */
  // Tell the phone when a newer deployment is live (banner, never an auto-reload).
  if (window.App.watchForNewBuild) window.App.watchForNewBuild({ intervalMs: 90000 });

  async function init() {
    try {
      meta = await API.get('/api/meta');
      els.eventName.forEach((el) => (el.textContent = meta.event.name));
      els.eventTagline.forEach((el) => (el.textContent = meta.event.tagline || ''));
      document.title = `${meta.event.name} · Live Poll`;
      if (!meta.viewer.joined) {
        window.location.replace('/');
        return;
      }
      els.greetName.textContent = `Hi, ${meta.viewer.name}`;
      els.greetSub.textContent = `Employee ID · ${meta.viewer.employeeId}`;
      els.avatar.textContent = initials(meta.viewer.name);
    } catch {
      toast('Cannot reach the server. Check your internet connection and refresh.', 'err', 6000);
    }

    startRealtime();
    setInterval(tickTimer, 250);
  }

  function initials(name) {
    return String(name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('');
  }

  let realtime = null;

  function startRealtime() {
    realtime = window.App.createLiveChannel({
      url: '/api/state',
      activeInterval: (meta && meta.polling && meta.polling.activeMs) || 3000,
      idleInterval: (meta && meta.polling && meta.polling.idleMs) || 8000,
      onData: (payload) => {
        setConn(true);
        applyState(payload);
      },
      onStatus: (status) => setConn(status === 'online'),
      onError: (err) => {
        if (err && err.status === 401) window.location.replace('/');
      }
    });
  }

  function setConn(online) {
    if (!els.conn) return;
    els.conn.innerHTML = online
      ? '<span class="pill pill-green-soft">● Live</span>'
      : '<span class="pill pill-ghost">● Reconnecting…</span>';
  }

  async function loadState() {
    try {
      applyState(await API.get('/api/state'));
    } catch (err) {
      if (err.status === 401) window.location.replace('/');
    }
  }

  function applyState(payload) {
    const prev = state;
    clockOffset = payload.serverTime - Date.now();
    state = payload;

    els.eventName.forEach((el) => (el.textContent = payload.event.name));
    els.eventTagline.forEach((el) => (el.textContent = payload.event.tagline || ''));

    // A new poll arrived → clear local selection
    const newId = payload.poll ? payload.poll.id : null;
    if (newId !== lastPollId) {
      selectedOptionId = null;
      lastPollId = newId;
    }
    if (payload.poll && payload.poll.viewer.hasVoted) {
      selectedOptionId = payload.poll.viewer.votedOptionId;
    }

    // 📣 A player was just shouted onto the block → announce it loudly on the phone.
    const spokeNew =
      payload.poll &&
      payload.poll.playerName &&
      payload.poll.status === 'active' &&
      (!prev || !prev.poll || prev.poll.id !== payload.poll.id);
    if (spokeNew) announceShout(payload.poll.playerName);

    const closedNow = prev?.poll && payload.poll && prev.poll.id === payload.poll.id && prev.poll.status === 'active' && payload.poll.status === 'closed';
    renderPoll();
    renderResults();
    renderHistory();
    renderStats();
    tickTimer();
    if (closedNow) {
      haptic(60);
      toast('Voting closed for this poll', 'info');
    }
  }

  /* 📣 ON THE BLOCK splash — shown the moment the host shouts a new player. */
  let shoutTimer = null;
  function announceShout(playerName) {
    let el = document.getElementById('shout-splash');
    if (!el) {
      el = document.createElement('div');
      el.id = 'shout-splash';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.innerHTML = `
      <div class="shout-splash-inner">
        <div class="shout-splash-mic" aria-hidden="true"><svg viewBox="0 0 48 48" width="52" height="52" fill="none">
          <path d="M6 20v8h7l10 8V12L13 20H6z" fill="#ffd166"/>
          <path d="M30 16c3 2.4 3 13.6 0 16" stroke="#ffd166" stroke-width="3.4" stroke-linecap="round"/>
          <path d="M37 10c6 4.6 6 23.4 0 28" stroke="#ffd166" stroke-width="3.4" stroke-linecap="round" opacity=".6"/>
        </svg></div>
        <div class="shout-splash-label">ON THE BLOCK</div>
        <div class="shout-splash-name">${window.App.escapeHtml(playerName)}</div>
        <div class="shout-splash-hint">Set your price below</div>
      </div>`;
    el.classList.remove('shout-splash-out');
    el.classList.add('shout-splash-in');
    haptic([18, 40, 18]);
    clearTimeout(shoutTimer);
    shoutTimer = setTimeout(() => {
      el.classList.add('shout-splash-out');
      setTimeout(() => el.classList.remove('shout-splash-in', 'shout-splash-out'), 500);
    }, 2200);
  }

  /* ------------------------------- render -------------------------------- */

  function renderStats() {
    if (!state || !els.statsBar) return;
    const p = state.poll;
    els.statsBar.innerHTML = `
      <span class="pill pill-ghost">👥&nbsp;<strong>${state.stats.participants}</strong>&nbsp;participants</span>
      <span class="pill pill-ghost">🎯&nbsp;<strong>${p ? p.totalVotes : 0}</strong>&nbsp;${window.App.plural(
        p ? p.totalVotes : 0,
        'guess',
        'guesses'
      )}</span>
      ${p ? '' : '<span class="pill pill-draft">Waiting for the next shout</span>'}
      ${
        state.auction && state.auction.upNext && p
          ? `<span class="pill pill-ghost">⏭&nbsp;next: ${window.App.escapeHtml(state.auction.upNext)}</span>`
          : ''
      }
    `;
  }

  function renderPoll() {
    const p = state.poll;
    if (!p) {
      els.pollArea.innerHTML = `
        <div class="card card-hero waiting">
          <div class="waiting-icon">⏳</div>
          <h2 style="font-size:20px">Waiting for the host</h2>
          <p class="muted" style="margin-top:8px">No poll is live right now. Keep this page open — the next poll will appear automatically.</p>
          <div class="wave"><i></i><i></i><i></i></div>
        </div>`;
      return;
    }

    renderBidPoll(p);
  }

  function bidLadder() {
    return (meta && meta.bid && meta.bid.ladder) || [];
  }

  function bidHead(p) {
    return `
      <div class="poll-meta">
        <span class="eyebrow">${escapeHtml(p.category || 'Bid range')}</span>
        <div class="row" style="gap:8px">
          <span class="pill pill-gold">🎯 Guess the price</span>
          ${statusPill(p.status)}
        </div>
      </div>
      ${p.playerName ? `<div class="bid-player"><span class="bid-player-tag">PLAYER</span>${escapeHtml(p.playerName)}</div>` : ''}
      <h2 class="poll-question">${escapeHtml(p.question)}</h2>
      <div class="row-between" style="gap:12px;margin-bottom:16px">
        <div class="timer ${p.status === 'active' ? '' : 'is-urgent'}" id="timer" data-state="${p.status}">
          <div class="timer-ring" id="timer-ring" style="--pct:100"><span>⏱</span></div>
          <span id="timer-text">--:--</span>
        </div>
        <div class="vote-count">🎯 <strong id="vote-count-num">${p.totalVotes}</strong> ${window.App.plural(p.totalVotes, 'guess', 'guesses')}</div>
      </div>`;
  }

  function renderBidPoll(p) {
    const head = bidHead(p);
    const ladder = bidLadder();

    /* Already guessed → show their call, and the reveal when it lands. */
    if (p.viewer.hasVoted) {
      const mine = p.viewer.guessLakh != null ? p.viewer.guessLakh : p.myGuess && p.myGuess.lakh;
      const mineLabel = mine != null ? ladderLabel(mine) : '—';
      els.pollArea.innerHTML = `
        <div class="card card-hero poll-card">${head}
          <div class="voted-state pop">
            <div class="check-ring"><svg viewBox="0 0 24 24"><path d="M4 12.5l5.2 5.2L20 6.8"/></svg></div>
            <h3 style="font-size:20px">Your guess is locked in</h3>
            <div class="bid-locked-value">${escapeHtml(mineLabel)}</div>
            <p class="muted" style="margin-top:6px;font-size:14px">One guess per participant per player.</p>
            <p class="mute-sm" style="margin-top:14px">${
              p.resultsVisible
                ? 'The hammer price is in — winners are below'
                : 'The host will enter the sold price after the bidding ends'
            }</p>
          </div>
        </div>`;
      return;
    }

    if (p.status === 'closed') {
      els.pollArea.innerHTML = `
        <div class="card card-hero poll-card">${head}
          <div class="locked"><span style="font-size:18px">🔒</span>
            <div><strong>Guessing is closed for this player.</strong><br />${
              p.resultsVisible ? 'Final standings are below.' : 'The host has not entered the sold price yet.'
            }</div>
          </div>
        </div>`;
      return;
    }
    if (p.status === 'paused') {
      els.pollArea.innerHTML = `
        <div class="card card-hero poll-card">${head}
          <div class="locked" style="border-color:rgba(255,176,32,.35);background:rgba(255,176,32,.08)">
            <span style="font-size:18px">⏸️</span>
            <div><strong>Guessing is paused.</strong><br />Hold tight — the host will resume shortly.</div>
          </div>
        </div>`;
      return;
    }

    /* Live: the drag bar */
    const startIndex = Math.max(0, ladder.findIndex((x) => x.lakh === 1000)); // default 10 Cr
    els.pollArea.innerHTML = `
      <div class="card card-hero poll-card bid-card">${head}
        <div class="bid-slider-wrap">
          <div class="bid-value" id="bid-value">${escapeHtml(ladder[startIndex] ? ladder[startIndex].label : '—')}</div>
          <div class="mute-sm center" style="margin-bottom:10px">Slide to your guess — drag the handle or use − / +</div>

          <div class="bid-track-row">
            <button class="bid-nudge" id="bid-minus" aria-label="Lower the guess">−</button>
            <div class="bid-track">
              <input id="bid-range" class="bid-range" type="range" min="0" max="${ladder.length - 1}"
                     step="1" value="${startIndex}" aria-label="Guess the selling price" />
              <div class="bid-scale"><span>20 L</span><span>1 Cr</span><span>10 Cr</span><span>30 Cr</span></div>
            </div>
            <button class="bid-nudge" id="bid-plus" aria-label="Raise the guess">+</button>
          </div>

          <div class="bid-chips" id="bid-chips">
            ${[20, 100, 500, 1000, 2000, 3000]
              .map((lakh) => {
                const idx = ladder.findIndex((x) => x.lakh === lakh);
                return idx < 0
                  ? ''
                  : `<button type="button" class="bid-chip" data-index="${idx}">${escapeHtml(ladderLabel(lakh))}</button>`;
              })
              .join('')}
          </div>
        </div>

        <div class="sticky-action">
          <button class="btn btn-primary btn-lg btn-block" id="vote-btn">
            Lock in <span id="bid-btn-label">${escapeHtml(ladder[startIndex] ? ladder[startIndex].label : '')}</span>
          </button>
        </div>
        <p class="mute-sm center" style="margin-top:10px">Closest guess to the sold price wins. You can guess once.</p>
      </div>`;

    wireBid(p, startIndex);
  }

  function ladderLabel(lakh) {
    const found = bidLadder().find((x) => x.lakh === Number(lakh));
    if (found) return found.label;
    const n = Number(lakh);
    if (n < 100) return `${n} L`;
    const cr = n / 100;
    return `${Number.isInteger(cr) ? cr.toFixed(2) : cr} Cr`;
  }

  /* Warm the confirmation document while the round is open, so the tap has nothing to download. */
  function prefetchConfirm(pollId) {
    try {
      if (!pollId || document.querySelector('link[data-confirm-prefetch]')) return;
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.as = 'document';
      link.href = `/vote-confirmed?poll=${pollId}`;
      link.setAttribute('data-confirm-prefetch', '1');
      document.head.appendChild(link);
    } catch {
      /* prefetch is a nicety */
    }
  }

  function wireBid(poll, startIndex) {
    prefetchConfirm(poll.id);
    const range = document.getElementById('bid-range');
    const valueEl = document.getElementById('bid-value');
    const labelEl = document.getElementById('bid-btn-label');
    const voteBtn = document.getElementById('vote-btn');
    const ladder = bidLadder();
    let index = startIndex;

    const paint = () => {
      const step = ladder[index];
      const text = step ? step.label : '—';
      valueEl.textContent = text;
      if (labelEl) labelEl.textContent = text;
      valueEl.classList.remove('pop');
      void valueEl.offsetWidth;
      valueEl.classList.add('pop');
      document.querySelectorAll('.bid-chip').forEach((chip) => {
        chip.classList.toggle('active', Number(chip.dataset.index) === index);
      });
    };

    range.addEventListener('input', () => {
      index = Number(range.value);
      haptic(5);
      paint();
    });
    document.getElementById('bid-minus').addEventListener('click', () => {
      index = Math.max(0, index - 1);
      range.value = String(index);
      haptic(6);
      paint();
    });
    document.getElementById('bid-plus').addEventListener('click', () => {
      index = Math.min(ladder.length - 1, index + 1);
      range.value = String(index);
      haptic(6);
      paint();
    });
    document.getElementById('bid-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.bid-chip');
      if (!chip) return;
      index = Number(chip.dataset.index);
      range.value = String(index);
      haptic(8);
      paint();
    });

    voteBtn.addEventListener('click', async () => {
      if (submitting) return;
      const step = ladder[index];
      if (!step) return;
      submitting = true;
      setBusy(voteBtn, true, 'Locking in…');
      try {
        const res = await API.post('/api/vote', { pollId: poll.id, guessLakh: step.lakh });
        haptic(40);
        /* Hand the confirmation everything it needs so the next page paints with no API call. */
        try {
          sessionStorage.setItem(
            'last_vote',
            JSON.stringify({
              at: Date.now(),
              pollId: res.pollId,
              guessLakh: res.guessLakh,
              guessLabel: res.guessLabel,
              playerName: poll.playerName || null,
              question: res.question || poll.question,
              totalVotes: res.totalVotes,
              status: poll.status
            })
          );
        } catch {
          /* private mode — the confirmation page falls back to fetching */
        }
        /* No artificial pause: the confirmation page is what shows the celebration. */
        window.location.href = `/vote-confirmed?poll=${res.pollId}`;
      } catch (err) {
        submitting = false;
        setBusy(voteBtn, false);
        if (err.status === 409) {
          toast(err.data?.alreadyVoted ? 'You already locked a guess' : err.message, 'info');
          if (realtime) realtime.poke();
          await loadState();
        } else {
          toast(err.message, 'err');
        }
      }
    });

    paint();
  }

  function tickTimer() {
    const timerEl = document.getElementById('timer');
    if (!timerEl || !state || !state.poll) return;
    const p = state.poll;
    const textEl = document.getElementById('timer-text');
    const ringEl = document.getElementById('timer-ring');
    if (!textEl || !ringEl) return;

    if (p.status === 'paused') {
      textEl.textContent = 'Paused';
      timerEl.classList.add('is-urgent');
      return;
    }
    if (p.status === 'closed') {
      textEl.textContent = 'Closed';
      return;
    }
    if (!p.endsAt) {
      textEl.textContent = 'No limit';
      ringEl.style.setProperty('--pct', 100);
      return;
    }
    const remaining = Math.max(0, p.endsAt - serverNow());
    textEl.textContent = formatClock(remaining);
    const total = Math.max(1, (p.endsAt - (p.startedAt || p.endsAt - p.timerSeconds * 1000)) || 1);
    const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
    ringEl.style.setProperty('--pct', pct.toFixed(1));
    timerEl.classList.toggle('is-urgent', remaining <= 10_000);
  }

  function renderResults() {
    if (!state || !state.poll) {
      els.resultsArea.innerHTML = '';
      return;
    }
    const p = state.poll;
    if (!p.resultsVisible || !p.results) {
      els.resultsArea.innerHTML = `
        <div class="card">
          <div class="card-head">
            <div>
              <div class="eyebrow">Results</div>
              <div class="card-title" style="margin-top:4px">Hidden for now</div>
            </div>
            <span class="pill pill-ghost">🔒</span>
          </div>
          <div class="locked">
            <span style="font-size:18px">👀</span>
            <div><strong>The host controls result visibility.</strong><br />
            ${
              p.showResults === 'never'
                ? 'Results for this poll will not be published to the audience.'
                : 'They will appear here automatically once revealed — no need to refresh.'
            }</div>
          </div>
        </div>`;
      return;
    }

    renderBidResults(p);
  }

  /* Winners + my own rank for the round just played. */
  function renderBidResults(p) {
    const r = p.results || {};
    const mine = r.viewer;
    const soldLabel = r.actualLabel || '—';

    const mineBlock = mine
      ? `<div class="bid-winner ${mine.isWinner ? 'rank-' + mine.rank : ''}" style="margin-bottom:12px">
           <span class="bid-medal">${mine.isWinner ? ['🥇', '🥈', '🥉'][mine.rank - 1] : '🎯'}</span>
           <div class="grow">
             <div class="bid-winner-name">Your guess: ${escapeHtml(mine.guessLabel)}</div>
             <div class="mute-sm">${
               mine.direction === 'exact'
                 ? 'Exact price — perfect call!'
                 : `${escapeHtml(mine.diffLabel)} ${escapeHtml(mine.direction)}`
             } · rank #${mine.rank} of ${r.totalGuesses}</div>
           </div>
         </div>`
      : '';

    const dist = (r.distribution || []).length
      ? `<div class="bid-dist" style="margin-top:6px">
           ${r.distribution
             .map(
               (d) => `<div class="bid-dist-row ${d.isActual ? 'is-actual' : ''}">
                 <span class="bid-dist-label">${escapeHtml(d.label)}</span>
                 <div class="bar-track"><div class="bar-fill" data-w="${Math.max(6, d.percent)}"></div></div>
                 <span class="bid-dist-count">${d.count}</span>
               </div>`
             )
             .join('')}
         </div>`
      : '';

    els.resultsArea.innerHTML = `
      <div class="card fade-up">
        <div class="card-head">
          <div>
            <div class="eyebrow">Final result</div>
            <div class="card-title" style="margin-top:4px">Sold for ${escapeHtml(soldLabel)}</div>
          </div>
          <span class="pill pill-gold">🎯 ${r.totalGuesses || 0} ${window.App.plural(
            r.totalGuesses || 0,
            'guess',
            'guesses'
          )}</span>
        </div>
        ${mineBlock}
        <div class="eyebrow" style="margin:10px 0 8px">Top 3 closest guesses</div>
        <div class="bid-winners">${window.App.bidResultRows(r)}</div>
        <div class="eyebrow" style="margin:18px 0 8px">How the room guessed</div>
        ${dist}
      </div>`;

    animateBars(els.resultsArea);
  }

  function renderHistory() {
    const history = (state && state.history) || [];
    if (!history.length) {
      els.historyArea.innerHTML = '';
      return;
    }
    els.historyArea.innerHTML = `
      <div class="card">
        <div class="card-head" style="margin-bottom:10px">
          <div>
            <div class="eyebrow">Previous polls</div>
            <div class="card-title" style="margin-top:4px">Results archive</div>
          </div>
        </div>
        ${history.slice(0, 8).map((h) => `
          <div class="accordion" data-history="${h.id}">
            <button class="accordion-head" type="button">
              <span class="accordion-q">${escapeHtml(h.question)}</span>
              <span class="pill pill-ghost">${h.totalVotes} 🎯</span>
              <svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <div class="accordion-body">
              <div class="results">${window.App.bidResultRows(h.results)}</div>
              <p class="mute-sm" style="margin-top:8px">${h.totalVotes} ${window.App.plural(
                h.totalVotes,
                'guess',
                'guesses'
              )} · closed ${window.App.timeAgo(h.closedAt)}</p>
            </div>
          </div>`).join('')}
      </div>`;

    els.historyArea.querySelectorAll('.accordion-head').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.closest('.accordion').classList.toggle('open');
        animateBars(btn.closest('.accordion'));
      });
    });
  }

  function animateBars(scope) {
    const root = scope || document;
    requestAnimationFrame(() => {
      root.querySelectorAll('.bar-fill').forEach((bar) => {
        bar.style.width = `${bar.dataset.w}%`;
      });
    });
  }

  // Re-draw bars after every render
  const observer = new MutationObserver(() => animateBars(document));
  observer.observe(document.body, { childList: true, subtree: true });

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    const ok = await window.App.confirmDialog({
      title: 'Leave the polls?',
      message: 'You can re-join with the same employee ID. Your votes stay recorded.',
      confirmText: 'Leave',
      danger: true
    });
    if (!ok) return;
    await API.post('/api/logout');
    window.location.href = '/';
  });

  init();
})();
