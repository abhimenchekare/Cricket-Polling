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
  /* The guess the participant is currently sitting on. Kept outside the DOM so that another
     person voting (which pushes a new state) can never bounce the slider back to its default. */
  let bidUi = { pollId: null, index: null };

  /* The same memory, but on disk — a phone that reloads (or wakes from sleep) comes back to the
     price the participant had dialled in, not to the default. */
  function readBidMemory(pollId) {
    try {
      const raw = localStorage.getItem(`cp_bid_${pollId}`);
      const n = Number(raw);
      return raw !== null && Number.isInteger(n) ? n : null;
    } catch {
      return null;
    }
  }

  function writeBidMemory(pollId, index) {
    try {
      localStorage.setItem(`cp_bid_${pollId}`, String(index));
    } catch {
      /* private mode — the in-memory copy is enough */
    }
  }
  let structureKey = '';

  const els = {
    pollArea: document.getElementById('poll-area'),
    statsBar: document.getElementById('stats-bar'),
    greetName: document.getElementById('greet-name'),
    greetSub: document.getElementById('greet-sub'),
    avatar: document.getElementById('avatar'),
    conn: document.getElementById('conn'),
    eventName: document.querySelectorAll('[data-event-name]'),
    eventTagline: document.querySelectorAll('[data-event-tagline]')
  };

  /* What the card looks like, ignoring numbers that tick constantly (guess counts, timers). */
  function pollStructureKey(p) {
    if (!p) return 'none';
    return [
      p.id,
      p.status,
      p.playerName || '',
      p.viewer && p.viewer.hasVoted ? 1 : 0,
      p.viewer && p.viewer.guessLakh != null ? p.viewer.guessLakh : '',
      p.resultsVisible ? 1 : 0,
      p.question
    ].join('|');
  }

  /* Cheap in-place refresh: the guess count on a live round. */
  function updateLiveNumbers(p) {
    const el = document.getElementById('vote-count-num');
    if (el && p) el.textContent = String(p.totalVotes);
  }

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
      const id = String(meta.viewer.employeeId || '');
      els.greetSub.textContent = id && !id.startsWith('@') ? `Employee ID · ${id}` : 'One guess per player';
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

    /* Someone else's vote only changes a number. Rebuilding the card for that used to throw away
       whatever price this person had dragged to — so rebuild only when the card actually changes. */
    const nextKey = pollStructureKey(payload.poll);
    if (nextKey !== structureKey || closedNow) {
      structureKey = nextKey;
      renderPoll();
    } else {
      updateLiveNumbers(payload.poll);
    }
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
    `;
  }

  function renderPoll() {
    const p = state.poll;

    /* No round on the block → the waiting mascot. Nothing about past rounds is shown:
       no names, no sold prices, no rankings. */
    if (!p || p.status === 'closed' || p.status === 'draft') {
      document.body.classList.remove('guess-focus');
      els.pollArea.innerHTML = waitingScreen(p);
      return;
    }

    renderBidPoll(p);
  }

  /* 🦆 The waiting screen: a duck in a cap bats a ball away, then gets stumped
     (and sneaking in a full swing every few seconds) until the host shouts. */
  function waitingScreen(p) {
    const finished = p && p.status === 'closed' ? p : null;
    const result = '';
    return `
      <div class="card card-hero duck-card fade-up">
        <div class="duck-scene">
          <div class="duck-glow"></div>
          <svg class="duck" viewBox="0 0 240 220" role="img" aria-label="A duck in a cricket cap batting a ball, then getting stumped out while it waits">
            <!-- shadow -->
            <ellipse class="duck-shadow" cx="120" cy="198" rx="66" ry="9" />

            <!-- stumps on the left: the second ball takes them out -->
            <g class="duck-stumps" transform="translate(36 150)">
              <rect x="-16" y="0" width="6" height="44" rx="3" fill="#c9a06a" />
              <rect x="-3" y="0" width="6" height="44" rx="3" fill="#d8b07a" />
              <rect x="10" y="0" width="6" height="44" rx="3" fill="#c9a06a" />
              <g class="duck-bails">
                <rect x="-18" y="-7" width="17" height="5" rx="2.5" fill="#e7c088" />
                <rect x="2" y="-7" width="17" height="5" rx="2.5" fill="#e7c088" />
              </g>
            </g>

            <!-- ball two: comes in low behind the bat and takes the stumps -->
            <circle class="duck-ball-low" cx="0" cy="0" r="7" fill="#e5484d" />
            <circle class="duck-hit" cx="36" cy="188" r="6" fill="none" stroke="#ffd166" stroke-width="2.5" />

            <!-- body -->
            <g class="duck-body">
              <ellipse cx="120" cy="150" rx="58" ry="44" fill="#f6c453" />
              <ellipse cx="120" cy="158" rx="44" ry="30" fill="#ffd97a" opacity=".55" />
              <path class="duck-wing" d="M96 138 q-22 6 -20 24 q16 10 34 2 q10 -14 -14 -26 z" fill="#e0a63a" />
              <path class="duck-tail" d="M176 146 q22 -4 26 -16 q-16 -2 -22 6 z" fill="#e0a63a" />
            </g>

            <!-- head -->
            <g class="duck-head">
              <ellipse cx="108" cy="86" rx="38" ry="34" fill="#f6c453" />
              <path d="M72 74 q4 -34 38 -34 q34 0 38 32 z" fill="#34d399" />
              <path d="M72 74 q40 -10 78 0 q4 6 -2 8 q-38 -8 -74 0 q-4 -3 -2 -8 z" fill="#22a06b" />
              <circle cx="110" cy="42" r="5" fill="#ffd166" />
              <g class="duck-eye">
                <circle cx="92" cy="88" r="4.6" fill="#1b2436" />
                <circle cx="90.4" cy="86.4" r="1.5" fill="#fff" opacity=".9" />
              </g>
              <path class="duck-beak" d="M66 96 q-16 2 -16 9 q0 8 16 8 l14 -2 q6 -6 0 -13 z" fill="#ff9f43" />
              <path d="M51 103 q14 3 28 1" stroke="#d97e22" stroke-width="1.6" fill="none" opacity=".7" />
            </g>

            <g class="duck-feet">
              <path d="M104 194 q-2 8 -12 8 q10 6 20 0 q4 -5 -8 -8 z" fill="#ff9f43" />
              <path d="M138 194 q-2 8 -12 8 q10 6 20 0 q4 -5 -8 -8 z" fill="#ff9f43" />
            </g>

            <!-- the bat -->
            <g class="duck-bat" transform="translate(186 132) rotate(-13)">
              <rect x="-7" y="-64" width="14" height="40" rx="6" fill="#241a10" />
              <rect x="-8" y="-30" width="16" height="8" rx="3" fill="#b8794a" />
              <path d="M-11 -24 L11 -24 L11 26 Q11 38 0 38 Q-11 38 -11 26 Z" fill="#e7c088" />
              <path d="M-11 20 L11 20 L11 26 Q11 38 0 38 Q-11 38 -11 26 Z" fill="#cfa568" />
            </g>

            <!-- ball one: struck off the bat -->
            <g class="duck-ball">
              <circle r="8" fill="#e5484d" />
              <circle cx="-2.5" cy="-2.5" r="2.4" fill="#ff9d9d" opacity=".9" />
              <path d="M-6 -4 Q0 0 -6 4" stroke="#fff" stroke-width="1.4" fill="none" opacity=".85" />
            </g>

            <!-- contact spark -->
            <g class="duck-spark" transform="translate(206 150)">
              <circle r="6" fill="#ffe9a8" />
              <g stroke="#ffd166" stroke-width="2.6" stroke-linecap="round">
                <path d="M0 -10 V-18" /><path d="M0 10 V18" /><path d="M-10 0 H-18" /><path d="M10 0 H18" />
              </g>
            </g>

          </svg>

          <div class="duck-dots" aria-hidden="true"><i></i><i></i><i></i></div>
        </div>

        ${result}

        <h2 class="duck-title">${finished ? 'That player is done' : 'Waiting for the next player'}</h2>
        <p class="muted duck-sub">${
          finished
            ? 'Sit tight — the host is lining up the next name. This screen fills in by itself.'
            : 'The bat is ready. Keep this page open — the next name appears here automatically.'
        }</p>
      </div>`;
  }

  function bidLadder() {
    return (meta && meta.bid && meta.bid.ladder) || [];
  }

  function bidHead(p) {
    return `
      <div class="poll-meta bid-meta">
        <div class="row" style="gap:6px;align-items:center">
          <span class="eyebrow">${escapeHtml(p.category || 'Bid range')}</span>
          ${statusPill(p.status)}
        </div>
        <div class="timer timer-inline ${p.status === 'active' ? '' : 'is-urgent'}" id="timer" data-state="${p.status}">
          <div class="timer-ring" id="timer-ring" style="--pct:100"><span>⏱</span></div>
          <span id="timer-text">--:--</span>
        </div>
      </div>
      <div class="bid-head">
        ${
          p.playerName
            ? `<div class="bid-player"><span class="bid-player-tag">PLAYER</span>${escapeHtml(p.playerName)}</div>`
            : ''
        }
        <h2 class="poll-question${p.playerName ? ' sr-only' : ''}">${escapeHtml(p.question)}</h2>
      </div>
      <div class="vote-count bid-guesscount">🎯 <strong id="vote-count-num">${p.totalVotes}</strong> ${window.App.plural(
        p.totalVotes,
        'guess',
        'guesses'
      )}</div>`;
  }

  function renderBidPoll(p) {
    /* One screen, no scrolling: the header, greeting and archive fold away while a round is live. */
    document.body.classList.toggle('guess-focus', p.status !== 'closed' && !p.viewer.hasVoted);
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

    /* Live: the drag bar — starts 10 Cr, but keeps whatever the participant has chosen */
    const defaultIndex = Math.max(0, ladder.findIndex((x) => x.lakh === 1000)); // default 10 Cr
    const fromMemory = bidUi.pollId === p.id && Number.isInteger(bidUi.index) ? bidUi.index : readBidMemory(p.id);
    const remembered =
      Number.isInteger(fromMemory) ? Math.min(Math.max(fromMemory, 0), ladder.length - 1) : null;
    const startIndex = remembered == null ? defaultIndex : remembered;
    els.pollArea.innerHTML = `
      <div class="card card-hero poll-card bid-card">${head}
        <div class="bid-slider-wrap">
          <div class="bid-value" id="bid-value">${escapeHtml(ladder[startIndex] ? ladder[startIndex].label : '—')}</div>

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
        <p class="mute-sm center bid-fineprint">Closest to the sold price wins · one guess per player</p>
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
    bidUi = { pollId: poll.id, index };
    if (index !== startIndex) writeBidMemory(poll.id, index);

    const paint = () => {
      bidUi.index = index;
      writeBidMemory(poll.id, index);
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
