/* Standalone results page */
(function () {
  'use strict';
  const { API, escapeHtml, formatDate, statusPill, timeAgo } = window.App;

  const currentEl = document.getElementById('current');
  const archiveEl = document.getElementById('archive');
  const standingsEl = document.getElementById('standings');
  const connEl = document.getElementById('conn');

  function animateBars(root) {
    requestAnimationFrame(() => {
      (root || document).querySelectorAll('.bar-fill').forEach((b) => {
        b.style.width = `${b.dataset.w}%`;
      });
    });
  }

  function render(state) {
    const poll = state.poll;
    const myGuess = poll?.viewer?.guessLabel ?? null;

    if (!poll) {
      currentEl.innerHTML = `
        <div class="card waiting">
          <div class="waiting-icon">📊</div>
          <h2 style="font-size:19px">No poll running</h2>
          <p class="muted" style="margin-top:8px">Results will appear here as soon as the host starts a poll.</p>
        </div>`;
    } else if (!poll.resultsVisible || !poll.results) {
      currentEl.innerHTML = `
        <div class="card card-hero poll-card">
          <div class="poll-meta">
            <span class="eyebrow">${escapeHtml(poll.category || 'Current poll')}</span>
            ${statusPill(poll.status)}
          </div>
          <h2 class="poll-question">${escapeHtml(poll.question)}</h2>
          <div class="locked" style="margin-top:14px">
            <span style="font-size:18px">🔒</span>
            <div><strong>Results are not published yet.</strong><br />
            ${poll.status === 'closed'
              ? 'The host has kept this poll private.'
              : 'The host will reveal results during or after voting.'}</div>
          </div>
        </div>`;
    } else {
      currentEl.innerHTML = `
        <div class="card card-hero poll-card fade-up">
          <div class="poll-meta">
            <span class="eyebrow">${poll.status === 'closed' ? 'Final result' : 'Live result'}</span>
            ${statusPill(poll.status)}
          </div>
          <h2 class="poll-question">${escapeHtml(poll.question)}</h2>
          <div class="stat-grid" style="margin:16px 0">
            <div class="stat"><div class="stat-value">${poll.totalVotes}</div><div class="stat-label">Total guesses</div></div>
            <div class="stat"><div class="stat-value">${state.stats.participants}</div><div class="stat-label">Participants</div></div>
            <div class="stat"><div class="stat-value">${poll.playerName ? escapeHtml(poll.playerName) : '—'}</div><div class="stat-label">Player</div></div>
            <div class="stat"><div class="stat-value">${poll.results && poll.results.actualLabel ? escapeHtml(poll.results.actualLabel) : '—'}</div><div class="stat-label">Sold for</div></div>
          </div>
          <div class="results">${window.App.bidResultRows(poll.results)}</div>
        </div>`;
      animateBars(currentEl);
    }

    const history = state.history || [];
    archiveEl.innerHTML = history.length
      ? `<div class="card">
           <div class="card-head"><div>
             <div class="eyebrow">Archive</div>
             <div class="card-title" style="margin-top:4px">Previous poll results</div>
           </div></div>
           ${history.map((h) => `
             <div class="accordion">
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
                 )} · closed ${timeAgo(h.closedAt)} · ${formatDate(h.closedAt)}</p>
               </div>
             </div>`).join('')}
         </div>`
      : `<div class="card empty"><div class="empty-icon">🗂️</div>No previous poll results yet.</div>`;

    archiveEl.querySelectorAll('.accordion-head').forEach((btn) => {
      btn.addEventListener('click', () => {
        const acc = btn.closest('.accordion');
        acc.classList.toggle('open');
        animateBars(acc);
      });
    });
  }

  /* 🏆 Overall leaderboard — 1st closest = 3 points, 2nd = 2, 3rd = 1, across every player sold. */
  let lastStandingsAt = 0;
  async function loadStandings(force) {
    if (!standingsEl) return;
    if (!force && Date.now() - lastStandingsAt < 15000) return;
    lastStandingsAt = Date.now();
    let data;
    try {
      data = await API.get('/api/standings');
    } catch {
      return;
    }
    if (!data || !data.rounds) {
      standingsEl.innerHTML = '';
      return;
    }
    const medal = ['#ffd166', '#cfd8e3', '#e0a370'];
    standingsEl.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div>
            <div class="eyebrow">🏆 Leaderboard</div>
            <div class="card-title" style="margin-top:4px">Closest to the sold price</div>
          </div>
          <span class="pill pill-gold">${data.rounds} ${data.rounds === 1 ? 'player' : 'players'} sold</span>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>#</th><th>Who</th><th>1st</th><th>2nd</th><th>3rd</th><th>Points</th></tr></thead>
            <tbody>
              ${data.standings
                .slice(0, 10)
                .map(
                  (s) => `<tr>
                    <td><strong style="color:${medal[s.rank - 1] || 'inherit'}">${s.rank}</strong></td>
                    <td><strong>${escapeHtml(s.name)}</strong></td>
                    <td>${s.firsts || '·'}</td>
                    <td>${s.seconds || '·'}</td>
                    <td>${s.thirds || '·'}</td>
                    <td><strong>${s.points}</strong></td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
        ${
          data.latest && data.latest.length
            ? `<div style="margin-top:14px">
                 <div class="eyebrow" style="margin-bottom:8px">Just sold</div>
                 ${data.latest
                   .map(
                     (r) => `<div class="mute-sm" style="margin-bottom:6px">
                        <strong style="color:var(--gold-300,#ffd166)">${escapeHtml(r.player)}</strong> — ${escapeHtml(
                          r.soldLabel || ''
                        )}${r.winners.length ? ' · ' + r.winners.map((w) => escapeHtml(w.name)).join(', ') : ''}
                     </div>`
                   )
                   .join('')}
               </div>`
            : ''
        }
      </div>`;
  }

  function applyState(state) {
    render(state);
  }

  function setConn(online) {
    if (!connEl) return;
    connEl.innerHTML = online
      ? '<span class="pill pill-green-soft">● Live</span>'
      : '<span class="pill pill-ghost">● Reconnecting…</span>';
  }

  loadStandings(true);
  setInterval(() => loadStandings(false), 20000);

  window.App.createLiveChannel({
    url: '/api/state',
    activeInterval: 3000,
    idleInterval: 8000,
    onData: (state) => {
      setConn(true);
      applyState(state);
      loadStandings(false);
    },
    onStatus: setConn
  });
})();
