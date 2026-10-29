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
  }

  /* The audience usually stays on this page after guessing. When the host shouts the NEXT player,
     say so here and let them jump straight back to the slider. */
  let seenPollId = null;
  function watchNextShout(payload) {
    const p = payload.poll;
    if (!p || !p.playerName) return;
    if (seenPollId === null) {
      seenPollId = p.id;
      return;
    }
    if (p.id === seenPollId || p.status !== 'active') return;
    seenPollId = p.id;
    if (p.viewer && p.viewer.hasVoted) return; // already guessed this one

    let banner = document.getElementById('next-shout');
    if (!banner) {
      banner = document.createElement('a');
      banner.id = 'next-shout';
      banner.href = '/poll';
      banner.style.cssText =
        'display:block;margin-top:18px;padding:16px 18px;border-radius:16px;text-decoration:none;' +
        'background:linear-gradient(120deg,rgba(255,199,66,.22),rgba(255,199,66,.06));' +
        'border:1px solid rgba(255,199,66,.5);color:#fff;font:700 15px/1.35 system-ui,sans-serif';
      contentEl.appendChild(banner);
    }
    banner.innerHTML = `📣 <strong style="color:#ffd166">${escapeHtml(p.playerName)}</strong> is on the block — tap to set your price`;
    window.App.haptic && window.App.haptic([16, 30, 16]);
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
      const payload = await API.get('/api/state');
      render(payload);
      watchNextShout(payload);
    } catch {
      window.App.toast('Could not load your confirmation', 'err');
    }
  }

  load();
  setInterval(load, 20000);

  if (window.App && window.App.createLiveChannel) {
    window.App.createLiveChannel({
      onData: (payload) => {
        if (payload && payload.poll) watchNextShout(payload);
      },
      onError: () => {}
    });
  }
})();
