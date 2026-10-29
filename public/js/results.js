/* Standalone results page */
(function () {
  'use strict';
  const { API, escapeHtml, formatDate, statusPill, timeAgo } = window.App;

  const currentEl = document.getElementById('current');
  const archiveEl = document.getElementById('archive');
  const connEl = document.getElementById('conn');

  function rowHtml(r, leaderId, myVoteId) {
    return `
      <div class="result-row ${leaderId === r.optionId ? 'is-leader' : ''}">
        <div class="result-top">
          <span class="result-label">${r.emoji ? escapeHtml(r.emoji) + ' ' : ''}${escapeHtml(r.label)}
            ${myVoteId === r.optionId ? '<span class="pill pill-gold" style="margin-left:6px">YOUR VOTE</span>' : ''}</span>
          <span class="result-votes">${r.votes}</span>
          <span class="result-pct">${r.percent}%</span>
        </div>
        <div class="bar-track"><div class="bar-fill" data-w="${r.percent}"></div></div>
      </div>`;
  }

  function animateBars(root) {
    requestAnimationFrame(() => {
      (root || document).querySelectorAll('.bar-fill').forEach((b) => {
        b.style.width = `${b.dataset.w}%`;
      });
    });
  }

  function render(state) {
    const poll = state.poll;
    const myVoteId = poll?.viewer?.votedOptionId ?? null;

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
            <div class="stat"><div class="stat-value">${poll.totalVotes}</div><div class="stat-label">Total votes</div></div>
            <div class="stat"><div class="stat-value">${state.stats.participants}</div><div class="stat-label">Participants</div></div>
            <div class="stat"><div class="stat-value">${poll.options.length}</div><div class="stat-label">Options</div></div>
            <div class="stat"><div class="stat-value">${poll.anonymous ? 'Yes' : 'No'}</div><div class="stat-label">Anonymous</div></div>
          </div>
          <div class="results">
            ${
              poll.results.kind === 'bid'
                ? window.App.bidResultRows(poll.results)
                : poll.results.rows.map((r) => rowHtml(r, poll.results.leadingOptionId, myVoteId)).join('')
            }
          </div>
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
                 <span class="pill pill-ghost">${h.totalVotes}</span>
                 <svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>
               </button>
               <div class="accordion-body">
                 <div class="results">${
                   h.results.kind === 'bid'
                     ? window.App.bidResultRows(h.results)
                     : h.results.rows.map((r) => rowHtml(r, h.results.leadingOptionId, null)).join('')
                 }</div>
                 <p class="mute-sm" style="margin-top:8px">${h.totalVotes} votes · closed ${timeAgo(h.closedAt)} · ${formatDate(h.closedAt)}</p>
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

  function applyState(state) {
    render(state);
  }

  function setConn(online) {
    if (!connEl) return;
    connEl.innerHTML = online
      ? '<span class="pill pill-green-soft">● Live</span>'
      : '<span class="pill pill-ghost">● Reconnecting…</span>';
  }

  window.App.createLiveChannel({
    url: '/api/state',
    activeInterval: 3000,
    idleInterval: 8000,
    onData: (state) => {
      setConn(true);
      applyState(state);
    },
    onStatus: setConn
  });
})();
