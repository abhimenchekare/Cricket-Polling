/* Admin — poll history, reports & exports */
(function () {
  'use strict';
  const { escapeHtml, formatDate, timeAgo } = window.App;
  const UI = window.AdminPollUI;

  const kpisEl = document.getElementById('h-kpis');
  const listEl = document.getElementById('h-list');
  const activityEl = document.getElementById('h-activity');
  let filter = 'all';

  function render(state) {
    renderKpis(state);
    renderList(state);
    renderActivity(state);
  }

  function renderKpis(state) {
    const s = state.stats;
    const pollCount = state.polls.length;
    kpisEl.innerHTML = `
      <div class="kpi"><div class="kpi-value">${pollCount}</div><div class="kpi-label">Total polls</div></div>
      <div class="kpi gold"><div class="kpi-value">${s.totalVotes}</div><div class="kpi-label">Votes cast</div></div>
      <div class="kpi"><div class="kpi-value">${s.participants}</div><div class="kpi-label">Participants</div></div>
      <div class="kpi"><div class="kpi-value">${s.closedPolls}</div><div class="kpi-label">Closed polls</div></div>
    `;
  }

  function renderList(state) {
    const polls = state.polls.filter((p) => {
      if (filter === 'all') return true;
      if (filter === 'active') return p.status === 'active' || p.status === 'paused';
      return p.status === filter;
    });

    if (!polls.length) {
      listEl.innerHTML = `<div class="card empty"><div class="empty-icon">📊</div>Nothing here yet.</div>`;
      return;
    }

    listEl.innerHTML = polls
      .map((p) => {
        const winner = p.results && p.results.winners ? p.results.winners[0] || null : null;
        const closest = !winner && p.results ? p.results.closest || null : null;
        return `
        <div class="card" style="margin-bottom:12px">
          <div class="card-head">
            <div class="grow">
              <div class="eyebrow">${escapeHtml(p.category || 'Poll')} · #${p.id}</div>
              <div class="card-title" style="margin-top:4px;font-size:16px">${escapeHtml(p.question)}</div>
            </div>
            ${window.App.statusPill(p.status)}
          </div>
          <div class="poll-item-meta">${UI.metaChips(p)}</div>
          ${
            winner
              ? `<div class="banner banner-plain banner-ok" style="margin:10px 0">🏆 Winner: <strong>${escapeHtml(
                  winner.name
                )}</strong> · guessed ${escapeHtml(winner.guessLabel)} · ${escapeHtml(
                  winner.diffLabel
                )} ${escapeHtml(winner.direction)}</div>`
              : closest
              ? `<div class="banner banner-plain" style="margin:10px 0">No right bid · closest was <strong>${escapeHtml(
                  closest.name
                )}</strong> ${escapeHtml(closest.diffLabel)} off</div>`
              : ''
          }
          <div class="results">${UI.resultsHtml(p.results, { max: 10 })}</div>
          <div class="poll-actions" style="margin-top:14px">
            <button class="btn btn-ghost btn-sm" data-id="${p.id}" data-poll-act="guesses">👥 All guesses</button>
            <button class="btn btn-ghost btn-sm" data-id="${p.id}" data-poll-act="export">⬇ Export CSV</button>
            ${p.status === 'closed' ? `<button class="btn btn-ghost btn-sm" data-id="${p.id}" data-poll-act="reopen">↻ Reopen</button>` : ''}
            ${p.status === 'draft' ? `<button class="btn btn-primary btn-sm" data-id="${p.id}" data-poll-act="start">▶ Start</button>` : ''}
            ${p.status === 'active' ? `<button class="btn btn-ghost btn-sm" data-id="${p.id}" data-poll-act="close">■ Close</button>` : ''}
            <span class="mute-sm" style="margin-left:auto">
              ${p.closedAt ? 'Closed ' + timeAgo(p.closedAt) : p.startedAt ? 'Started ' + timeAgo(p.startedAt) : 'Created ' + timeAgo(p.createdAt)}
            </span>
          </div>
        </div>`;
      })
      .join('');

    UI.bindActions(listEl);
    UI.animateBars(listEl);
  }

  function renderActivity(state) {
    if (!state.recentActivity?.length) {
      activityEl.innerHTML = '<div class="empty">No activity yet.</div>';
      return;
    }
    activityEl.innerHTML = state.recentActivity
      .map(
        (a) => `
      <div class="act-item">
        <div class="act-dot"></div>
        <div class="grow">
          <div>${escapeHtml(a.detail || a.action)}</div>
          <div class="mute-sm">${escapeHtml(a.action)} · ${escapeHtml(a.actor || 'system')} · ${formatDate(a.created_at)}</div>
        </div>
        <div class="act-time">${timeAgo(a.created_at)}</div>
      </div>`
      )
      .join('');
  }

  document.getElementById('h-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-f]');
    if (!chip) return;
    filter = chip.dataset.f;
    document.querySelectorAll('#h-filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderList(window.AdminShell.state);
  });

  document.getElementById('export-all').addEventListener('click', () => {
    window.location.href = '/api/admin/export/all-polls.csv';
  });
  document.getElementById('export-people').addEventListener('click', () => {
    window.location.href = '/api/admin/export/participants.csv';
  });

  window.AdminShell.ready.then(() => {
    window.AdminShell.onChange(render);
  });
})();
