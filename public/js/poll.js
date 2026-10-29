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
    realtime = window.App.createRealtime({
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

  /* ------------------------------- render -------------------------------- */

  function renderStats() {
    if (!state || !els.statsBar) return;
    const p = state.poll;
    els.statsBar.innerHTML = `
      <span class="pill pill-ghost">👥&nbsp;<strong>${state.stats.participants}</strong>&nbsp;participants</span>
      <span class="pill pill-ghost">🗳️&nbsp;<strong>${p ? p.totalVotes : 0}</strong>&nbsp;votes</span>
      ${p ? '' : '<span class="pill pill-draft">No live poll</span>'}
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

    if (p.pollType === 'bid') {
      renderBidPoll(p);
      return;
    }

    const hasVoted = p.viewer.hasVoted;
    const myOption = p.options.find((o) => o.id === p.viewer.votedOptionId);
    const canVote = p.status === 'active' && !hasVoted;

    const head = `
      <div class="poll-meta">
        <span class="eyebrow">${escapeHtml(p.category || 'Live poll')}</span>
        <div class="row" style="gap:8px">
          ${p.anonymous ? '<span class="pill pill-ghost">🕶️ Anonymous</span>' : ''}
          ${statusPill(p.status)}
        </div>
      </div>
      <h2 class="poll-question">${escapeHtml(p.question)}</h2>
      ${p.description ? `<p class="poll-desc">${escapeHtml(p.description)}</p>` : ''}
      <div class="row-between" style="gap:12px;margin-bottom:16px">
        <div class="timer ${p.status === 'active' ? '' : 'is-urgent'}" id="timer" data-state="${p.status}">
          <div class="timer-ring" id="timer-ring" style="--pct:100"><span>⏱</span></div>
          <span id="timer-text">--:--</span>
        </div>
        <div class="vote-count">🗳️ <strong id="vote-count-num">${p.totalVotes}</strong> votes</div>
      </div>`;

    if (hasVoted) {
      els.pollArea.innerHTML = `
        <div class="card card-hero poll-card">${head}
          <div class="voted-state pop">
            <div class="check-ring">
              <svg viewBox="0 0 24 24"><path d="M4 12.5l5.2 5.2L20 6.8"/></svg>
            </div>
            <h3 style="font-size:20px">Your vote is locked in</h3>
            <p class="muted" style="margin-top:6px;font-size:14px">One vote per participant per poll.</p>
            ${myOption ? `<div class="choice-chip"><span>${escapeHtml(myOption.emoji || '✅')}</span><span>${escapeHtml(myOption.label)}</span></div>` : ''}
            <p class="mute-sm" id="waiting-note" style="margin-top:16px">${
              p.status === 'active'
                ? p.resultsVisible
                  ? 'Live results below — watch the bars move'
                  : 'Results will be revealed by the host'
                : 'Waiting for the next poll'
            }</p>
            <a class="btn btn-ghost btn-sm" href="/vote-confirmed" style="margin-top:10px">View confirmation</a>
          </div>
        </div>`;
      return;
    }

    if (p.status === 'closed') {
      els.pollArea.innerHTML = `
        <div class="card card-hero poll-card">${head}
          <div class="locked" style="margin-bottom:4px">
            <span style="font-size:18px">🔒</span>
            <div><strong>Voting is closed for this poll.</strong><br />${
              p.resultsVisible ? 'Final results are shown below.' : 'The host has not published these results yet.'
            }</div>
          </div>
        </div>`;
      return;
    }

    if (p.status === 'paused') {
      els.pollArea.innerHTML = `
        <div class="card card-hero poll-card">${head}
          <div class="locked" style="border-color:rgba(255,176,32,.35);background:rgba(255,176,32,.08);margin-bottom:14px">
            <span style="font-size:18px">⏸️</span>
            <div><strong>Voting is paused.</strong><br />The host will resume in a moment — your screen updates automatically.</div>
          </div>
          <div class="options">${p.options.map((o) => optionHtml(o, false, true)).join('')}</div>
        </div>`;
      return;
    }

    // active + not voted
    els.pollArea.innerHTML = `
      <div class="card card-hero poll-card">${head}
        <div class="options" id="options" role="radiogroup" aria-label="Poll options">
          ${p.options.map((o) => optionHtml(o, o.id === selectedOptionId, false)).join('')}
        </div>
        <div class="sticky-action">
          <button class="btn btn-primary btn-lg btn-block" id="vote-btn" disabled>
            Select an option to vote
          </button>
        </div>
        <p class="mute-sm center" style="margin-top:10px">You can vote only once in this poll.</p>
      </div>`;
    wireVoting(p);
  }

  /* ══════════════════════════ bid range poll ══════════════════════════ */

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

  function wireBid(poll, startIndex) {
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
        window.App.confetti(1600);
        toast(`Locked in at ${res.guessLabel}`, 'ok');
        setTimeout(() => {
          window.location.href = `/vote-confirmed?poll=${res.pollId}`;
        }, 650);
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

  function optionHtml(option, selected, disabled) {
    return `
      <button type="button" class="option ${selected ? 'selected' : ''}" data-option="${option.id}"
              role="radio" aria-checked="${selected}" ${disabled ? 'disabled' : ''}>
        <span class="option-radio" aria-hidden="true"></span>
        ${option.emoji ? `<span class="option-emoji" aria-hidden="true">${escapeHtml(option.emoji)}</span>` : ''}
        <span class="option-label">${escapeHtml(option.label)}</span>
      </button>`;
  }

  function wireVoting(poll) {
    const optionsWrap = document.getElementById('options');
    const voteBtn = document.getElementById('vote-btn');
    const sync = () => {
      const selected = poll.options.find((o) => o.id === selectedOptionId);
      optionsWrap.querySelectorAll('.option').forEach((el) => {
        const on = Number(el.dataset.option) === selectedOptionId;
        el.classList.toggle('selected', on);
        el.setAttribute('aria-checked', String(on));
      });
      if (selected) {
        voteBtn.disabled = false;
        voteBtn.textContent = `Vote for ${selected.label}`;
      } else {
        voteBtn.disabled = true;
        voteBtn.textContent = 'Select an option to vote';
      }
    };

    optionsWrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.option');
      if (!btn || btn.disabled) return;
      selectedOptionId = Number(btn.dataset.option);
      haptic(8);
      sync();
    });

    voteBtn.addEventListener('click', async () => {
      if (!selectedOptionId || submitting) return;
      submitting = true;
      setBusy(voteBtn, true, 'Submitting…');
      try {
        const res = await API.post('/api/vote', { pollId: poll.id, optionId: selectedOptionId });
        haptic(40);
        window.App.confetti(1800);
        toast('Vote submitted!', 'ok');
        setTimeout(() => {
          window.location.href = `/vote-confirmed?poll=${res.pollId}`;
        }, 650);
      } catch (err) {
        submitting = false;
        setBusy(voteBtn, false);
        if (err.status === 409) {
          toast(err.data?.alreadyVoted ? 'You already voted in this poll' : err.message, 'info');
          if (realtime) realtime.poke();
          else await loadState();
          if (err.data?.alreadyVoted) window.location.href = '/vote-confirmed';
        } else {
          toast(err.message, 'err');
        }
      }
    });

    sync();
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

    if (p.results.kind === 'bid') {
      renderBidResults(p);
      return;
    }

    const rows = p.results.rows.map((r) => resultRow(r, p.results.leadingOptionId, p.viewer.votedOptionId)).join('');
    els.resultsArea.innerHTML = `
      <div class="card fade-up">
        <div class="card-head">
          <div>
            <div class="eyebrow">${p.status === 'closed' ? 'Final results' : 'Live results'}</div>
            <div class="card-title" style="margin-top:4px">${p.totalVotes} vote${p.totalVotes === 1 ? '' : 's'} counted</div>
          </div>
          <span class="pill ${p.status === 'closed' ? 'pill-closed' : 'pill-live'}">${p.status === 'closed' ? 'FINAL' : 'LIVE'}</span>
        </div>
        <div class="results">${rows}</div>
        ${p.anonymous ? '<p class="mute-sm" style="margin-top:12px">🕶️ Individual votes are anonymous in this poll.</p>' : ''}
      </div>`;
  }

  function renderBidResults(p) {
    const r = p.results;
    const medal = ['🥇', '🥈', '🥉'];
    const viewer = r.viewer;

    const winners = r.winners.length
      ? r.winners
          .map(
            (w) => `
        <div class="bid-winner rank-${w.rank}">
          <span class="bid-medal">${medal[w.rank - 1] || '#' + w.rank}</span>
          <div class="grow">
            <div class="bid-winner-name">${escapeHtml(w.name)}</div>
            <div class="mute-sm">guessed ${escapeHtml(w.guessLabel)} · ${escapeHtml(w.diffLabel)} ${
              w.direction === 'exact' ? 'exact!' : w.direction
            }</div>
          </div>
        </div>`
          )
          .join('')
      : '<div class="empty">Nobody guessed in this round.</div>';

    els.resultsArea.innerHTML = `
      <div class="card fade-up">
        <div class="card-head">
          <div>
            <div class="eyebrow">Hammer price</div>
            <div class="card-title" style="margin-top:4px">${escapeHtml(p.playerName || 'This player')} sold for ${escapeHtml(
              r.actualLabel || '—'
            )}</div>
          </div>
          <span class="pill pill-gold">${r.totalGuesses} guess${r.totalGuesses === 1 ? '' : 'es'}</span>
        </div>

        ${
          viewer
            ? `<div class="bid-you ${viewer.isWinner ? 'is-winner' : ''}">
                 <div>
                   <div class="mute-sm">Your guess</div>
                   <strong>${escapeHtml(viewer.guessLabel)}</strong>
                   <span class="mute-sm">· ${escapeHtml(viewer.diffLabel)} ${viewer.direction === 'exact' ? 'exact!' : viewer.direction}</span>
                 </div>
                 <div class="bid-rank">${viewer.isWinner ? medal[viewer.rank - 1] || '#' + viewer.rank : '#' + viewer.rank}</div>
               </div>`
            : ''
        }

        <div class="eyebrow" style="margin:18px 0 10px">Top 3 closest guesses</div>
        <div class="bid-winners">${winners}</div>

        <div class="eyebrow" style="margin:18px 0 10px">How the room guessed</div>
        <div class="bid-dist">
          ${r.distribution
            .map(
              (d) => `
            <div class="bid-dist-row ${d.isActual ? 'is-actual' : ''}">
              <span class="bid-dist-label">${escapeHtml(d.label)}${d.isActual ? ' ← sold' : ''}</span>
              <div class="bar-track"><div class="bar-fill" data-w="${d.percent}"></div></div>
              <span class="bid-dist-count">${d.count}</span>
            </div>`
            )
            .join('')}
        </div>
      </div>`;

    animateBars(els.resultsArea);
  }

  function resultRow(r, leaderId, myVoteId) {
    const isLeader = leaderId === r.optionId;
    return `
      <div class="result-row ${isLeader ? 'is-leader' : ''}">
        <div class="result-top">
          <span class="result-label">${r.emoji ? escapeHtml(r.emoji) + ' ' : ''}${escapeHtml(r.label)}
            ${myVoteId === r.optionId ? '<span class="pill pill-gold" style="margin-left:6px">YOUR VOTE</span>' : ''}</span>
          <span class="result-votes">${r.votes}</span>
          <span class="result-pct">${r.percent}%</span>
        </div>
        <div class="bar-track"><div class="bar-fill" data-w="${r.percent}"></div></div>
      </div>`;
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
              <span class="pill pill-ghost">${h.totalVotes}</span>
              <svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <div class="accordion-body">
              <div class="results">${
                h.results.kind === 'bid'
                  ? window.App.bidResultRows(h.results)
                  : h.results.rows.map((r) => resultRow(r, h.results.leadingOptionId, h.viewer?.votedOptionId ?? null)).join('')
              }</div>
              <p class="mute-sm" style="margin-top:8px">${h.totalVotes} votes · closed ${window.App.timeAgo(h.closedAt)}</p>
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
