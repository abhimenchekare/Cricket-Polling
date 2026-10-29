/* Vote confirmation page */
(function () {
  'use strict';
  const { API, escapeHtml, confetti } = window.App;

  const params = new URLSearchParams(location.search);
  const wantedPollId = Number(params.get('poll')) || null;

  const contentEl = document.getElementById('confirm-content');
  const choiceEl = document.getElementById('choice');
  const statsEl = document.getElementById('confirm-stats');
  const noteEl = document.getElementById('confirm-note');
  const resultsLink = document.getElementById('results-link');

  function renderEmpty() {
    contentEl.innerHTML = `
      <div class="waiting-icon">🤔</div>
      <h1 class="confirm-title">No vote to show yet</h1>
      <p class="muted" style="font-size:14.5px;margin-top:8px">You have not voted in the current poll.</p>`;
  }

  async function render(state) {
    let poll = state.poll;
    // Prefer the poll mentioned in the URL (e.g. a poll that just closed)
    if (wantedPollId) {
      if (poll && poll.id === wantedPollId) {
        /* keep */
      } else {
        poll = state.history.find((h) => h.id === wantedPollId) || poll;
      }
    }
    if (!poll) return renderEmpty();

    const guessLakh = poll.viewer?.guessLakh ?? (poll.myGuess ? poll.myGuess.lakh : null);
    if (guessLakh == null) {
      contentEl.innerHTML = `
        <div class="waiting-icon">⏳</div>
        <h1 class="confirm-title">No vote found</h1>
        <p class="muted" style="font-size:14.5px;margin-top:8px">This poll is still open — cast your vote to see the confirmation.</p>`;
      resultsLink.textContent = 'Go to polls';
      resultsLink.href = '/poll';
      document.getElementById('confirm-stats').innerHTML = '';
      noteEl.textContent = '';
      return;
    }

    // a bid round is a guess, not a vote
    {
      const titleEl = document.querySelector('.confirm-title');
      if (titleEl) titleEl.textContent = 'Guess locked in!';
      const subEl = document.querySelector('.confirm-title + p');
      if (subEl) subEl.textContent = 'Closest guess to the sold price wins. Sit tight.';
      const statsLabel = document.querySelector('.stat-label');
      if (statsLabel) statsLabel.textContent = 'Guesses on this round';
      const label =
        poll.viewer?.guessLabel ||
        poll.myGuess?.label ||
        (guessLakh == null ? 'Recorded' : `${guessLakh / 100} Cr`);
      choiceEl.innerHTML = `
        <div style="margin-top:14px" class="mute-sm">Your guess</div>
        <div class="bid-locked-value pop" style="margin-top:6px">${escapeHtml(String(label))}</div>
        ${poll.playerName ? `<div class="bid-player" style="margin-top:12px"><span class="bid-player-tag">PLAYER</span>${escapeHtml(poll.playerName)}</div>` : ''}
        <p class="muted" style="margin-top:14px;font-size:13.5px">“${escapeHtml(poll.question)}”</p>`;
    }

    const resultsVisible = !!poll.resultsVisible;
    statsEl.innerHTML = `
      <div class="stat"><div class="stat-value">${poll.totalVotes}</div><div class="stat-label">Guesses on this round</div></div>
      <div class="stat"><div class="stat-value">${poll.status === 'closed' ? 'Closed' : poll.status === 'paused' ? 'Paused' : 'Live'}</div><div class="stat-label">Poll status</div></div>
    `;

    if (resultsVisible) {
      resultsLink.textContent = 'See live results';
      resultsLink.href = '/results';
      noteEl.textContent = 'Results are visible now — tap above to view them.';
    } else {
      resultsLink.textContent = 'Previous results';
      resultsLink.href = '/results';
      noteEl.textContent =
        poll.showResults === 'never'
          ? 'The host keeps this poll private — results will not be published.'
          : 'Results will appear automatically once the host reveals them.';
    }

    confetti(1600);
    scheduleReturn();
  }

  /* "Guess locked in" is a confirmation, not a place to wait. Hand the phone back to the
     auction after a beat so nobody is stuck off the slider when the host shouts the next player. */
  const RETURN_MS = 1200;
  let returnTimer = null;
  function scheduleReturn() {
    if (returnTimer) return;
    const bar = document.createElement('div');
    bar.id = 'confirm-return';
    bar.style.cssText =
      'margin-top:20px;display:flex;flex-direction:column;gap:10px;align-items:center';
    bar.innerHTML = `
      <div style="font:600 13px/1.3 system-ui,sans-serif;color:rgba(255,255,255,.62)">
        Back to the auction…
      </div>
      <div style="width:100%;max-width:220px;height:4px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden">
        <div id="confirm-return-bar" style="height:100%;width:100%;border-radius:99px;background:linear-gradient(90deg,#17d97f,#ffd166);transform-origin:left;transform:scaleX(0);transition:transform ${RETURN_MS}ms linear"></div>
      </div>
      <button type="button" id="confirm-stay" class="btn btn-ghost btn-sm" style="margin-top:2px">Stay here</button>`;
    contentEl.appendChild(bar);
    requestAnimationFrame(() => {
      const fill = document.getElementById('confirm-return-bar');
      if (fill) fill.style.transform = 'scaleX(1)';
    });
    document.getElementById('confirm-stay').addEventListener('click', () => {
      cancelReturn();
      bar.innerHTML =
        '<a class="btn btn-primary btn-sm" href="/poll">Go to the auction</a>';
    });
    returnTimer = setTimeout(goBack, RETURN_MS);
  }

  function cancelReturn() {
    if (returnTimer) clearTimeout(returnTimer);
    returnTimer = null;
  }

  function goBack() {
    window.location.replace('/poll');
  }

  async function load() {
    try {
      const meta = await API.get('/api/meta');
      if (!meta.viewer.joined) {
        window.location.replace('/');
        return;
      }
      document.querySelectorAll('[data-event-name]').forEach((el) => (el.textContent = meta.event.name));
      document.querySelectorAll('[data-event-tagline]').forEach((el) => (el.textContent = meta.event.tagline || ''));
      render(await API.get('/api/state'));
    } catch {
      window.App.toast('Could not load your confirmation', 'err');
    }
  }

  load();
  setInterval(load, 20000);
})();
