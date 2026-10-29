/* Admin dashboard */
(function () {
  'use strict';
  const { API, toast, escapeHtml, confirmDialog, setBusy, formatDate, timeAgo, haptic } = window.App;
  const UI = window.AdminPollUI;

  const els = {
    kpis: document.getElementById('dash-kpis'),
    live: document.getElementById('live-control'),
    results: document.getElementById('dash-results'),
    queue: document.getElementById('dash-queue'),
    quick: document.getElementById('dash-quick'),
    activity: document.getElementById('dash-activity')
  };

  let tickOffset = 0;

  /* ------------------------------ rendering ------------------------------ */

  function render(state) {
    tickOffset = state.serverTime - Date.now();
    renderKpis(state);
    renderLive(state);
    renderResults(state);
    renderQueue(state);
    renderQuick(state);
    renderActivity(state);
    UI.animateBars(document);
  }

  function renderKpis(state) {
    const live = state.polls.find((p) => p.status === 'active');
    const s = state.stats;
    els.kpis.innerHTML = `
      <div class="kpi"><div class="kpi-value">${s.participants}</div><div class="kpi-label">Participants</div></div>
      <div class="kpi gold"><div class="kpi-value">${s.totalVotes}</div><div class="kpi-label">Votes cast</div></div>
      <div class="kpi"><div class="kpi-value">${s.onlineParticipants}</div><div class="kpi-label">Online now</div></div>
      <div class="kpi"><div class="kpi-value">${live ? (live.totalVotes) : '—'}</div><div class="kpi-label">${live ? 'Votes on live poll' : 'No live poll'}</div></div>
    `;
  }

  function renderLive(state) {
    const live = state.polls.find((p) => p.status === 'active') || state.polls.find((p) => p.status === 'paused');
    if (!live) {
      const nextDraft = state.polls.filter((p) => p.status === 'draft').slice(-1)[0];
      els.live.innerHTML = `
        <div class="card card-hero">
          <div class="card-head">
            <div>
              <div class="eyebrow">Live control</div>
              <div class="card-title" style="margin-top:4px">No poll is running</div>
            </div>
            <span class="pill pill-draft">IDLE</span>
          </div>
          <p class="muted" style="font-size:14px">
            ${nextDraft ? 'Start your next poll whenever the room is ready.' : 'Create a poll to get started.'}
          </p>
          <div class="poll-actions" style="margin-top:14px">
            ${nextDraft ? `<button class="btn btn-primary" data-start="${nextDraft.id}">▶ Start: ${escapeHtml(nextDraft.question.slice(0, 38))}${nextDraft.question.length > 38 ? '…' : ''}</button>` : ''}
            <a class="btn btn-ghost" href="/admin-polls">+ New poll</a>
            <a class="btn btn-ghost" href="/display" target="_blank" rel="noopener">🖥 Big screen</a>
          </div>
        </div>`;
      els.live.querySelectorAll('[data-start]').forEach((btn) =>
        btn.addEventListener('click', () => UI.handleAction('start', btn.dataset.start))
      );
      return;
    }

    const isPaused = live.status === 'paused';
    els.live.innerHTML = `
      <div class="card card-hero">
        <div class="card-head">
          <div>
            <div class="eyebrow">Live control</div>
            <div class="card-title" style="margin-top:4px;font-size:19px;line-height:1.25">${escapeHtml(live.question)}</div>
            ${live.pollType === 'bid' ? `<div class="mute-sm" style="margin-top:6px">🎯 Bid range · <strong style="color:var(--gold-300)">${escapeHtml(live.playerName || 'player')}</strong></div>` : ''}
          </div>
          ${isPaused ? '<span class="pill pill-paused">PAUSED</span>' : '<span class="pill pill-live"><span class="dot"></span>LIVE</span>'}
        </div>
        <div class="row" style="gap:12px;flex-wrap:wrap;margin-bottom:14px">
          <div class="timer" id="admin-timer" style="font-size:22px">
            <div class="timer-ring" id="admin-ring" style="--pct:100"><span>⏱</span></div>
            <span id="admin-timer-text">--:--</span>
          </div>
          <div class="vote-count">${live.pollType === 'bid' ? '🎯' : '🗳️'} <strong>${live.totalVotes}</strong> ${live.pollType === 'bid' ? window.App.plural(live.totalVotes, 'guess', 'guesses') : 'votes'}</div>
          <div class="vote-count">👥 <strong>${state.stats.participants}</strong> participants</div>
        </div>
        <div class="poll-actions">${UI.controlButtons(live)}</div>
        <hr class="divider" />
        ${live.pollType === 'bid' ? '' : `<div class="row-between" style="flex-wrap:wrap;gap:10px">
          <div class="mute-sm">Results visibility</div>
          <div class="segmented" style="max-width:330px;flex:1 1 240px">
            <button data-id="${live.id}" data-visibility="never" class="${live.showResults === 'never' ? 'active' : ''}">Private</button>
            <button data-id="${live.id}" data-visibility="during" class="${live.showResults === 'during' ? 'active' : ''}">Live</button>
            <button data-id="${live.id}" data-visibility="after" class="${live.showResults === 'after' ? 'active' : ''}">After close</button>
          </div>
        </div>`}
        ${live.pollType === 'bid' ? bidPricePanel(live) : ''}
        <div class="row" style="gap:8px;margin-top:14px;flex-wrap:wrap">
          <span class="mute-sm">Restart countdown:</span>
          ${[10, 15, 20, 30, 45, 60, 90, 120]
            .map((s) => `<button class="btn btn-ghost btn-sm" data-timer="${s}" data-id="${live.id}" title="Restart the countdown with ${s}s">↻ ${s < 60 ? s + 's' : s / 60 + 'm'}</button>`)
            .join('')}
          <button class="btn btn-ghost btn-sm" data-extend="10" data-id="${live.id}" title="Add 10 seconds">+10s</button>
          <button class="btn btn-ghost btn-sm" data-extend="30" data-id="${live.id}" title="Add 30 seconds">+30s</button>
          <button class="btn btn-ghost btn-sm" data-timer="0" data-id="${live.id}" title="Remove the countdown">No limit</button>
        </div>
      </div>`;

    UI.bindActions(els.live, { onEdit: openEditor });
    if (live.pollType === 'bid') wireBidPricePanel(live);
    els.live.querySelectorAll('[data-timer]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const seconds = Number(btn.dataset.timer);
        try {
          await API.post(`/api/admin/polls/${btn.dataset.id}/timer`, { seconds, mode: 'set' });
          toast(seconds ? `Countdown restarted at ${seconds}s` : 'Countdown removed', 'ok');
          window.AdminShell.poke();
        } catch (err) {
          toast(err.message, 'err');
        }
      });
    });
    els.live.querySelectorAll('[data-extend]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const seconds = Number(btn.dataset.extend);
        try {
          await API.post(`/api/admin/polls/${btn.dataset.id}/timer`, { seconds, mode: 'extend' });
          toast(`Added ${seconds}s`, 'ok');
          window.AdminShell.poke();
        } catch (err) {
          toast(err.message, 'err');
        }
      });
    });
    tickTimer();
  }

  function tickTimer() {
    const textEl = document.getElementById('admin-timer-text');
    const ringEl = document.getElementById('admin-ring');
    const timerEl = document.getElementById('admin-timer');
    if (!textEl || !ringEl) return;
    const state = window.AdminShell.state;
    const live = state?.polls.find((p) => p.status === 'active') || state?.polls.find((p) => p.status === 'paused');
    if (!live) return;
    if (live.status === 'paused') {
      textEl.textContent = 'Paused';
      timerEl.classList.add('is-urgent');
      return;
    }
    if (!live.endsAt) {
      textEl.textContent = 'No limit';
      ringEl.style.setProperty('--pct', 100);
      return;
    }
    const remaining = Math.max(0, live.endsAt - (Date.now() + tickOffset));
    textEl.textContent = window.App.formatClock(remaining);
    const total = Math.max(1, live.endsAt - (live.startedAt || live.endsAt - live.timerSeconds * 1000));
    ringEl.style.setProperty('--pct', ((remaining / total) * 100).toFixed(1));
    timerEl.classList.toggle('is-urgent', remaining <= 10_000);
  }
  setInterval(tickTimer, 300);

  function renderResults(state) {
    // Prefer the live poll, then a paused one, then the most recently closed
    const live = state.polls.find((p) => p.status === 'active') || state.polls.find((p) => p.status === 'paused') || state.polls.find((p) => p.status === 'closed');
    if (!live) {
      els.results.innerHTML = `<div class="card"><div class="card-head"><div><div class="eyebrow">Results</div><div class="card-title" style="margin-top:4px">Nothing to show</div></div></div><div class="empty">Start a poll to see live results.</div></div>`;
      return;
    }
    els.results.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div>
            <div class="eyebrow">${live.status === 'closed' ? 'Final result' : 'Live result'}</div>
            <div class="card-title" style="margin-top:4px">${escapeHtml(live.question)}</div>
          </div>
          <span class="pill pill-ghost">${live.totalVotes} votes</span>
        </div>
        <div class="results">${UI.resultsHtml(live.results, { max: 10 })}</div>
        <div class="row" style="gap:8px;margin-top:14px;flex-wrap:wrap">
          <a class="btn btn-ghost btn-sm" href="/admin-history">Full report</a>
          <button class="btn btn-ghost btn-sm" data-id="${live.id}" data-poll-act="export">⬇ Export CSV</button>
          <span class="mute-sm" style="margin-left:auto">Updated live</span>
        </div>
      </div>`;
    UI.bindActions(els.results);
  }

  function renderQueue(state) {
    const drafts = state.polls.filter((p) => p.status === 'draft').slice(0, 4);
    const recent = state.polls.filter((p) => p.status === 'closed').slice(0, 3);
    els.queue.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div>
            <div class="eyebrow">Queue</div>
            <div class="card-title" style="margin-top:4px">Ready to run (${state.polls.filter((p) => p.status === 'draft').length})</div>
          </div>
          <a class="btn btn-ghost btn-sm" href="/admin-polls">Manage</a>
        </div>
        ${drafts.length
          ? drafts
              .map(
                (p) => `
          <div class="poll-item">
            <div class="poll-item-q" style="font-size:14.5px;margin-bottom:8px">${escapeHtml(p.question)}</div>
            <div class="poll-item-meta">${UI.metaChips(p)}</div>
            <div class="poll-actions">
              <button class="btn btn-primary" data-start="${p.id}">▶ Start</button>
              <a class="btn btn-ghost" href="/admin-polls?edit=${p.id}">✏️ Edit</a>
            </div>
          </div>`
              )
              .join('')
          : '<div class="empty">No draft polls. Create one to get ready.</div>'}
        <hr class="divider" />
        <div class="mute-sm" style="margin-bottom:8px">Recently closed</div>
        ${recent.length
          ? recent
              .map(
                (p) => `<div class="row-between" style="padding:7px 0;font-size:13px">
                  <span class="truncate" style="color:var(--text-dim)">${escapeHtml(p.question)}</span>
                  <span class="pill pill-ghost">${p.totalVotes}</span>
                </div>`
              )
              .join('')
          : '<div class="mute-sm">No closed polls yet.</div>'}
      </div>`;
    els.queue.querySelectorAll('[data-start]').forEach((btn) =>
      btn.addEventListener('click', () => UI.handleAction('start', btn.dataset.start))
    );
  }

  function renderQuick(state) {
    els.quick.innerHTML = `
      <div class="card" id="rapid-card" style="margin-bottom:16px">
        <div class="card-head">
          <div>
            <div class="eyebrow">⚡ Rapid round</div>
            <div class="card-title" style="margin-top:4px">Guess the next player</div>
          </div>
          <span class="pill pill-live">10–15 SEC</span>
        </div>
        <p class="mute-sm" style="margin:0 0 12px">
          Fires a round instantly: everyone guesses, voting locks at 0&nbsp;s and the answer appears on every
          screen by itself. Reuse it for every player in the auction.
        </p>
        <label class="field" style="display:block;margin-bottom:10px">
          <span class="mute-sm">Question</span>
          <input class="input" id="rr-question" maxlength="200" value="${escapeHtml(
            localStorage.getItem('rr_question') || 'Who will win the bidding for the next player?'
          )}" style="margin-top:6px" />
        </label>
        <label class="field" style="display:block;margin-bottom:10px">
          <span class="mute-sm">Options — one player per line</span>
          <textarea class="input" id="rr-options" rows="4" placeholder="Rohit&#10;Virat&#10;Hardik&#10;Jasprit" style="margin-top:6px;resize:vertical;font-family:inherit">${escapeHtml(
            localStorage.getItem('rr_options') || ''
          )}</textarea>
        </label>
        <div class="row-between" style="flex-wrap:wrap;gap:10px;margin-bottom:12px">
          <span class="mute-sm">Countdown</span>
          <div class="segmented" id="rr-seconds" style="max-width:320px;flex:1 1 220px">
            ${[10, 15, 20, 30, 45, 60]
              .map(
                (sec) =>
                  `<button type="button" data-sec="${sec}" class="${
                    Number(localStorage.getItem('rr_seconds')) === sec ||
                    (!localStorage.getItem('rr_seconds') && sec === 15)
                      ? 'active'
                      : ''
                  }">${sec}s</button>`
              )
              .join('')}
          </div>
        </div>
        <button class="btn btn-gold" id="rr-start" style="width:100%">⚡ Create &amp; start round</button>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="eyebrow">Quick actions</div>
            <div class="card-title" style="margin-top:4px">Run the room</div>
          </div>
        </div>
        <div class="grid-3">
          <a class="btn btn-primary" href="/admin-polls">+ Create poll</a>
          <a class="btn btn-ghost" href="/display" target="_blank" rel="noopener">🖥 Big screen</a>
          <button class="btn btn-ghost" id="show-qr">🔗 Join link</button>
          <a class="btn btn-ghost" href="/admin-participants">👥 Participants</a>
          <button class="btn btn-ghost" id="event-settings">⚙️ Event settings</button>
          <button class="btn btn-ghost" id="change-password">🔑 Password</button>
          <button class="btn btn-ghost" id="session-check">🩺 Session check</button>
        </div>
      </div>`;
    document.getElementById('show-qr').addEventListener('click', showShareModal);
    document.getElementById('event-settings').addEventListener('click', showSettingsModal);
    document.getElementById('change-password').addEventListener('click', showPasswordModal);
    document.getElementById('session-check').addEventListener('click', showSessionCheck);
    wireRapidRound();
  }

  /* 🎯 Bid round: enter the price the player actually sold for → 3 winners are computed. */
  function bidPricePanel(poll) {
    const ladder = (metaLadder() || []).length ? metaLadder() : [];
    const hasPrice = poll.actualLakh != null;
    const startIndex = hasPrice
      ? Math.max(0, ladder.findIndex((x) => x.lakh === poll.actualLakh))
      : Math.max(0, ladder.findIndex((x) => x.lakh === 1000));

    return `
      <div class="bid-admin ${hasPrice ? 'is-set' : ''}" style="margin-top:16px">
        <div class="row-between" style="flex-wrap:wrap;gap:8px">
          <div class="eyebrow" style="margin:0">💰 Enter the sold price</div>
          ${
            hasPrice
              ? `<span class="pill pill-gold">SOLD ${escapeHtml(poll.actualLabel || '')}</span>`
              : '<span class="pill pill-ghost">not entered yet</span>'
          }
        </div>
        <p class="mute-sm" style="margin:8px 0 12px">
          Slide to the final hammer price. Entering it closes the round and instantly declares the
          three closest guesses on every phone and on the projector.
        </p>
        <div class="bid-admin-value" id="adm-bid-value">${escapeHtml(
          ladder[startIndex] ? ladder[startIndex].label : '—'
        )}</div>
        <div class="row" style="gap:10px;align-items:center;margin-top:8px">
          <button class="btn btn-ghost btn-sm" id="adm-bid-minus" aria-label="Lower">−</button>
          <input class="bid-range" id="adm-bid-range" type="range" min="0" max="${ladder.length - 1}"
                 step="1" value="${startIndex}" style="flex:1" aria-label="Sold price" />
          <button class="btn btn-ghost btn-sm" id="adm-bid-plus" aria-label="Raise">+</button>
        </div>
        <div class="bid-chips" id="adm-bid-chips" style="justify-content:flex-start;margin-top:12px">
          ${[20, 100, 500, 1000, 2000, 3000]
            .map((lakh) => {
              const idx = ladder.findIndex((x) => x.lakh === lakh);
              return idx < 0 ? '' : `<button type="button" class="bid-chip" data-index="${idx}">${escapeHtml(ladder[idx].label)}</button>`;
            })
            .join('')}
        </div>
        <div class="row" style="gap:8px;margin-top:14px;flex-wrap:wrap">
          <button class="btn btn-gold" id="adm-bid-save">${hasPrice ? 'Update price & re-rank' : 'Declare winners'}</button>
          ${hasPrice ? '<button class="btn btn-ghost btn-sm" id="adm-bid-clear">Clear price</button>' : ''}
        </div>
      </div>`;
  }

  function metaLadder() {
    return (window.__bidLadder || []).map((x) => ({ lakh: x.lakh, label: x.label }));
  }

  function wireBidPricePanel(poll) {
    const ladder = metaLadder();
    if (!ladder.length) {
      // fetch once, then re-render
      API.get('/api/meta')
        .then((m) => {
          window.__bidLadder = m.bid.ladder;
          window.AdminShell.refresh();
        })
        .catch(() => toast('Could not load the price ladder', 'err'));
      return;
    }

    const range = document.getElementById('adm-bid-range');
    const valueEl = document.getElementById('adm-bid-value');
    const chips = document.getElementById('adm-bid-chips');
    const saveBtn = document.getElementById('adm-bid-save');
    let index = Number(range.value);

    const paint = () => {
      valueEl.textContent = ladder[index] ? ladder[index].label : '—';
      chips.querySelectorAll('.bid-chip').forEach((c) => {
        c.classList.toggle('active', Number(c.dataset.index) === index);
      });
    };

    range.addEventListener('input', () => {
      index = Number(range.value);
      paint();
    });
    document.getElementById('adm-bid-minus').addEventListener('click', () => {
      index = Math.max(0, index - 1);
      range.value = String(index);
      paint();
    });
    document.getElementById('adm-bid-plus').addEventListener('click', () => {
      index = Math.min(ladder.length - 1, index + 1);
      range.value = String(index);
      paint();
    });
    chips.addEventListener('click', (e) => {
      const chip = e.target.closest('.bid-chip');
      if (!chip) return;
      index = Number(chip.dataset.index);
      range.value = String(index);
      paint();
    });

    saveBtn.addEventListener('click', async () => {
      const step = ladder[index];
      if (!step) return;
      const ok = await window.App.confirmDialog({
        title: `Sold for ${step.label}?`,
        message: `This closes the round and declares the three closest guesses for ${poll.playerName || 'this player'}. You can correct the price later.`,
        confirmText: 'Declare winners'
      });
      if (!ok) return;
      setBusy(saveBtn, true, 'Declaring…');
      try {
        const res = await API.post(`/api/admin/polls/${poll.id}/actual`, { lakh: step.lakh });
        haptic(30);
        window.App.confetti(1600);
        toast(
          res.winners.length
            ? `Winners: ${res.winners.map((w) => w.name).join(', ')}`
            : 'Price saved — nobody guessed',
          'ok'
        );
        window.AdminShell.refresh();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        setBusy(saveBtn, false);
      }
    });

    const clearBtn = document.getElementById('adm-bid-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        const ok = await window.App.confirmDialog({
          title: 'Clear the sold price?',
          message: 'Participants will stop seeing the winners until you enter a price again.',
          confirmText: 'Clear',
          danger: true
        });
        if (!ok) return;
        try {
          await API.del(`/api/admin/polls/${poll.id}/actual`);
          toast('Price cleared', 'ok');
          window.AdminShell.refresh();
        } catch (err) {
          toast(err.message, 'err');
        }
      });
    }

    paint();
  }

  /* ⚡ One-tap round: create the poll, then start it with a seconds countdown. */
  function wireRapidRound() {
    const questionEl = document.getElementById('rr-question');
    const optionsEl = document.getElementById('rr-options');
    const secondsEl = document.getElementById('rr-seconds');
    const startBtn = document.getElementById('rr-start');
    if (!questionEl || !startBtn) return;

    if (!optionsEl.value.trim()) {
      optionsEl.value = ['Rohit', 'Virat', 'Hardik', 'Jasprit', 'Rishabh'].join('\n');
    }

    let seconds = Number(localStorage.getItem('rr_seconds')) || 15;

    secondsEl.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        seconds = Number(btn.dataset.sec);
        localStorage.setItem('rr_seconds', String(seconds));
        secondsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });

    startBtn.addEventListener('click', async () => {
      const question = questionEl.value.trim();
      const options = optionsEl.value
        .split(/\n|,/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 10);
      if (question.length < 5) return toast('Write a question first', 'err');
      if (options.length < 2) return toast('Add at least 2 options', 'err');

      localStorage.setItem('rr_question', question);
      localStorage.setItem('rr_options', options.join('\n'));

      startBtn.disabled = true;
      startBtn.textContent = 'Starting…';
      try {
        const created = await API.post('/api/admin/polls', {
          question,
          description: `Live guessing round · ${seconds}s`,
          category: 'Rapid round',
          showResults: 'after', // reveal automatically when the countdown ends
          anonymous: false,
          timerSeconds: seconds,
          options: options.map((label) => ({ label }))
        });
        const id = created.poll.id;
        await API.post(`/api/admin/polls/${id}/action`, { action: 'start', timerSeconds: seconds });
        toast(`Round live — ${seconds}s on the clock`, 'ok');
        window.AdminShell.refresh();
      } catch (err) {
        toast(err.message || 'Could not start the round', 'err');
      } finally {
        startBtn.disabled = false;
        startBtn.innerHTML = '⚡ Create &amp; start round';
      }
    });
  }

  function renderActivity(state) {
    if (!state.recentActivity.length) {
      els.activity.innerHTML = '<div class="empty">No activity yet.</div>';
      return;
    }
    els.activity.innerHTML = state.recentActivity
      .map(
        (a) => `
      <div class="act-item">
        <div class="act-dot"></div>
        <div class="grow">
          <div style="color:var(--text)">${escapeHtml(a.detail || a.action)}</div>
          <div class="mute-sm">${escapeHtml(a.action)} · ${escapeHtml(a.actor || 'system')}</div>
        </div>
        <div class="act-time">${timeAgo(a.created_at)}</div>
      </div>`
      )
      .join('');
  }

  /* 🩺 Session / deployment diagnostics: tells you exactly why the panel logs you out. */
  async function showSessionCheck() {
    const { backdrop, close } = buildModal(
      `<div class="card-title">Session &amp; deployment check</div>
       <p class="mute-sm" style="margin:10px 0 14px">Read live from this deployment. Useful when the panel
       keeps bouncing you to the login page.</p>
       <div id="diag-body"><div class="mute-sm">Checking…</div></div>`,
      { wide: true }
    );

    let diag;
    try {
      diag = await API.get('/api/diag');
    } catch (err) {
      document.getElementById('diag-body').innerHTML =
        `<div class="banner banner-warn">Could not reach /api/diag: ${escapeHtml(err.message)}</div>`;
      return;
    }

    const row = (label, value, good) => `
      <div class="row-between" style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.07)">
        <span class="mute-sm">${label}</span>
        <strong style="color:${good === undefined ? 'var(--text)' : good ? 'var(--green-400, #35d07f)' : '#ff7b8a'}">
          ${escapeHtml(String(value))}
        </strong>
      </div>`;

    const r = diag.request || {};
    const db = diag.database || {};
    const cfg = diag.config || {};
    const dep = diag.deployment || {};

    document.getElementById('diag-body').innerHTML = `
      <div class="eyebrow" style="margin-bottom:6px">Session</div>
      ${row('Admin cookie present in this browser', r.hasAdminCookie ? 'yes' : 'NO', !!r.hasAdminCookie)}
      ${row('Cookie found in database', r.adminCookieFoundInDatabase === undefined ? '—' : r.adminCookieFoundInDatabase ? 'yes' : 'NO', r.adminCookieFoundInDatabase)}
      ${row('Session expires in', r.adminSessionExpiresInMs ? Math.round(r.adminSessionExpiresInMs / 60000) + ' min' : '—')}
      <div class="eyebrow" style="margin:16px 0 6px">Database</div>
      ${row('DATABASE_URL set', db.configured ? 'yes' : 'NO', !!db.configured)}
      ${row('Reachable', db.reachable ? `yes (${db.latencyMs} ms)` : 'NO', !!db.reachable)}
      ${row('Host', cfg.databaseHost || '—')}
      ${row('Schema version', diag.schema?.schemaVersion || '—')}
      ${row('Admin accounts / sessions', `${diag.counts?.admins ?? '—'} / ${diag.counts?.admin_sessions ?? '—'}`)}
      ${row('Expired sessions sitting in DB', diag.counts?.expired_sessions ?? '—')}
      <div class="eyebrow" style="margin:16px 0 6px">Deployment</div>
      ${row('Commit', dep.commit ? dep.commit.slice(0, 7) : 'unknown (local)')}
      ${row('Environment', dep.env || cfg.nodeEnv || 'local')}
      ${row('Region', dep.region || '—')}
      ${row('Secure cookie setting', cfg.cookieSecure ? 'on' : 'off')}
      ${db.error ? `<div class="banner banner-warn" style="margin-top:12px">Database error: ${escapeHtml(db.error)}</div>` : ''}
      ${
        r.hasAdminCookie && r.adminCookieFoundInDatabase === false
          ? `<div class="banner banner-warn" style="margin-top:12px">
               The browser has an admin cookie but this deployment's database has no matching session.
               That usually means the cookie belongs to a different database or a session reset.
               Sign in again once — if it keeps happening, the deployment is pointing at a different database than before.
             </div>`
          : ''
      }
      ${
        !r.hasAdminCookie
          ? `<div class="banner banner-warn" style="margin-top:12px">
               Your browser is not sending the admin cookie at all. If you are viewing this through a
               link that is NOT the https address (or an embedded preview), open the deployment URL directly.
             </div>`
          : ''
      }
      <div class="row-between" style="margin-top:16px">
        <button class="btn btn-ghost" data-close>Close</button>
        <button class="btn btn-primary" id="diag-copy">Copy report</button>
      </div>`;

    document.getElementById('diag-copy').addEventListener('click', async () => {
      await window.App.copyText(JSON.stringify(diag, null, 2));
      toast('Report copied', 'ok');
    });
    backdrop.querySelector('[data-close]').addEventListener('click', close);
  }

  /* ------------------------------- modals ------------------------------- */

  function buildModal(inner, { wide = false } = {}) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal" style="${wide ? 'width:min(100%,680px)' : ''}">${inner}</div>`;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.closest('[data-close]')) close();
    });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', onKey);
      }
    });
    return { backdrop, close };
  }

  async function showShareModal() {
    const { backdrop } = buildModal(
      `<div class="modal-title">Share the join link</div>
       <div class="modal-body">Everyone opens this link on their phone — no app install needed.
         Paste it in your team chat, WhatsApp group or email.</div>
       <div class="center" id="share-holder" style="font-family:var(--font-num);font-size:14px;color:var(--green-400);word-break:break-all;padding:14px;border-radius:14px;background:rgba(4,10,24,.7);border:1px solid var(--card-border)">Loading…</div>
       <div class="modal-actions" style="margin-top:18px">
         <button class="btn btn-ghost" data-close>Close</button>
         <button class="btn btn-primary" id="copy-share">Copy link</button>
       </div>
       <div class="center" style="margin-top:12px">
         <a class="btn-link" href="/display" target="_blank" rel="noopener">Open the big screen instead →</a>
       </div>`
    );
    let joinUrl = '';
    try {
      const meta = await API.get('/api/meta');
      joinUrl = meta.join.joinUrl;
      backdrop.querySelector('#share-holder').textContent = joinUrl;
    } catch {
      backdrop.querySelector('#share-holder').textContent = 'Could not load the link';
    }
    backdrop.querySelector('#copy-share').addEventListener('click', async () => {
      const ok = await window.App.copyText(joinUrl);
      toast(ok ? 'Link copied' : joinUrl, ok ? 'ok' : 'info', 4000);
    });
  }

  async function showSettingsModal() {
    let settings = window.AdminShell.state?.settings || {};
    const { backdrop } = buildModal(
      `<div class="modal-title">Event settings</div>
       <div class="modal-body">These appear on the join page and the big screen.</div>
       <div class="stack">
         <label class="field"><span class="label">Event name</span><input class="input" id="s-name" value="${escapeHtml(settings.event_name || '')}" maxlength="80" /></label>
         <label class="field"><span class="label">Tagline</span><input class="input" id="s-tag" value="${escapeHtml(settings.event_tagline || '')}" maxlength="80" /></label>
         <label class="field"><span class="label">Big-screen message (idle)</span><textarea class="textarea" id="s-msg" maxlength="240">${escapeHtml(settings.display_message || '')}</textarea></label>
         <label class="switch"><input type="checkbox" id="s-code-req" ${settings.join_requires_code === '1' ? 'checked' : ''} /><span class="switch-track"></span><span class="switch-text"><span class="switch-title">Require an access code to join</span><span class="switch-sub">Only people with the event code can vote</span></span></label>
         <label class="field"><span class="label">Access code</span><input class="input" id="s-code" value="${escapeHtml(settings.access_code || '')}" maxlength="32" /></label>
         <label class="switch"><input type="checkbox" id="s-allow" ${settings.allow_new_participants === '1' ? 'checked' : ''} /><span class="switch-track"></span><span class="switch-text"><span class="switch-title">Allow new participants to join</span><span class="switch-sub">Turn off once everyone is in</span></span></label>
       </div>
       <div class="modal-actions" style="margin-top:18px">
         <button class="btn btn-ghost" data-close>Cancel</button>
         <button class="btn btn-primary" id="save-settings">Save settings</button>
       </div>`,
      { wide: true }
    );
    backdrop.querySelector('#save-settings').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      setBusy(btn, true, 'Saving…');
      try {
        await API.put('/api/admin/settings', {
          event_name: backdrop.querySelector('#s-name').value.trim(),
          event_tagline: backdrop.querySelector('#s-tag').value.trim(),
          display_message: backdrop.querySelector('#s-msg').value.trim(),
          join_requires_code: backdrop.querySelector('#s-code-req').checked,
          access_code: backdrop.querySelector('#s-code').value.trim(),
          allow_new_participants: backdrop.querySelector('#s-allow').checked
        });
        toast('Settings saved', 'ok');
        backdrop.remove();
        await window.AdminShell.refresh();
      } catch (err) {
        setBusy(btn, false);
        toast(err.message, 'err');
      }
    });
  }

  function showPasswordModal() {
    const { backdrop } = buildModal(
      `<div class="modal-title">Change admin password</div>
       <div class="modal-body">Use at least 6 characters. You'll stay signed in on this device.</div>
       <div class="stack">
         <label class="field"><span class="label">Current password</span><input class="input" type="password" id="pw-current" autocomplete="current-password" /></label>
         <label class="field"><span class="label">New password</span><input class="input" type="password" id="pw-new" autocomplete="new-password" /></label>
         <label class="field"><span class="label">Confirm new password</span><input class="input" type="password" id="pw-confirm" autocomplete="new-password" /></label>
       </div>
       <div class="modal-actions" style="margin-top:18px">
         <button class="btn btn-ghost" data-close>Cancel</button>
         <button class="btn btn-primary" id="save-pw">Update password</button>
       </div>`
    );
    backdrop.querySelector('#save-pw').addEventListener('click', async (e) => {
      const current = backdrop.querySelector('#pw-current').value;
      const next = backdrop.querySelector('#pw-new').value;
      const confirm = backdrop.querySelector('#pw-confirm').value;
      if (next !== confirm) return toast('New passwords do not match', 'err');
      setBusy(e.currentTarget, true, 'Saving…');
      try {
        const pw = await API.post('/api/admin/password', { currentPassword: current, newPassword: next });
        if (pw && pw.token) window.dispatchEvent(new CustomEvent('app:new-admin-token', { detail: pw }));
        toast('Password updated', 'ok');
        document.getElementById('password-banner')?.classList.add('hidden');
        backdrop.remove();
      } catch (err) {
        setBusy(e.currentTarget, false);
        toast(err.message, 'err');
      }
    });
  }

  function openEditor(poll) {
    window.location.href = `/admin-polls?edit=${poll.id}`;
  }

  document.getElementById('open-password')?.addEventListener('click', showPasswordModal);

  window.AdminShell.ready.then(() => {
    window.AdminShell.onChange(render);
  });
})();
