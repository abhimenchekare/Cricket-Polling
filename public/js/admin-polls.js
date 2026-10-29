/* Admin — create & manage slider (bid range) polls.
   Slider-only: every poll asks "What will be the bid range for <player> player?" and the
   audience answers with a price from the auction ladder. There is no multiple-choice path. */
(function () {
  'use strict';
  const { API, toast, escapeHtml, setBusy, timeAgo, plural } = window.App;
  const UI = window.AdminPollUI;

  const editorCard = document.getElementById('editor-card');
  const editorTitle = document.getElementById('editor-title');
  const editorEyebrow = document.getElementById('editor-eyebrow');
  const form = document.getElementById('poll-form');
  const formError = document.getElementById('form-error');
  const listEl = document.getElementById('poll-list');
  const timerInput = document.getElementById('f-timer');
  const anonInput = document.getElementById('f-anon');
  const qInput = document.getElementById('f-question');
  const playerInput = document.getElementById('f-player');
  const dInput = document.getElementById('f-description');
  const cInput = document.getElementById('f-category');

  let editingId = null;
  let visibility = 'after';
  let filter = 'all';
  let submitMode = 'draft';

  /* ---------------------------- visibility UI ---------------------------- */

  const visHints = {
    during: 'The winners are revealed as soon as you enter the sold price.',
    after: 'Winners appear to participants once the round is closed.',
    never: 'Only you can see the guesses and the winners.'
  };

  document.getElementById('vis-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-vis]');
    if (!btn) return;
    visibility = btn.dataset.vis;
    document.querySelectorAll('#vis-seg button').forEach((b) => b.classList.toggle('active', b === btn));
    document.getElementById('vis-hint').textContent = visHints[visibility];
  });

  function markTimerPreset() {
    const value = String(Number(timerInput.value) || 0);
    document.querySelectorAll('#timer-presets button').forEach((b) => {
      b.classList.toggle('active', b.dataset.secs === value);
    });
  }

  document.getElementById('timer-presets').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-secs]');
    if (!btn) return;
    timerInput.value = btn.dataset.secs;
    markTimerPreset();
  });

  timerInput.addEventListener('input', markTimerPreset);

  /* ------------------------------ editor -------------------------------- */

  function showError(msg) {
    if (!msg) return formError.classList.add('hidden');
    formError.textContent = msg;
    formError.classList.remove('hidden');
  }

  function openEditor(poll = null) {
    editingId = poll ? poll.id : null;
    editorEyebrow.textContent = poll ? `Editing poll #${poll.id}` : 'New poll';
    editorTitle.textContent = poll ? 'Edit bid round' : 'New bid round';
    playerInput.value = poll && poll.playerName ? poll.playerName : '';
    qInput.value = poll ? poll.question || '' : '';
    dInput.value = poll ? poll.description || '' : '';
    cInput.value = poll ? poll.category || 'Bid range' : 'Bid range';
    timerInput.value = poll ? poll.timerSeconds : 20;
    markTimerPreset();
    anonInput.checked = poll ? !!poll.anonymous : false;
    visibility = poll ? poll.showResults : 'after';
    document.querySelectorAll('#vis-seg button').forEach((b) =>
      b.classList.toggle('active', b.dataset.vis === visibility)
    );
    document.getElementById('vis-hint').textContent = visHints[visibility];
    showError('');
    editorCard.classList.remove('hidden');
    editorCard.classList.add('fade-up');
    editorCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => playerInput.focus({ preventScroll: true }), 250);
  }

  function closeEditor() {
    editorCard.classList.add('hidden');
    editingId = null;
    if (location.search.includes('edit=')) history.replaceState({}, '', '/admin-polls');
  }

  document.getElementById('new-poll').addEventListener('click', () => openEditor());
  document.getElementById('close-editor').addEventListener('click', closeEditor);
  document.getElementById('cancel-editor').addEventListener('click', closeEditor);

  document.getElementById('save-draft').addEventListener('click', () => (submitMode = 'draft'));
  document.getElementById('save-start').addEventListener('click', () => (submitMode = 'start'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');

    const playerName = playerInput.value.trim();
    const typedQuestion = qInput.value.trim();

    if (!playerName) return showError('Enter the player name for this bid round');

    const payload = {
      playerName,
      question: typedQuestion || `What will be the bid range for ${playerName} player?`,
      description: dInput.value.trim(),
      category: cInput.value.trim() || 'Bid range',
      timerSeconds: Number(timerInput.value) || 0,
      showResults: visibility,
      anonymous: anonInput.checked
    };

    const btn =
      submitMode === 'start' ? document.getElementById('save-start') : document.getElementById('save-draft');
    setBusy(btn, true, submitMode === 'start' ? 'Starting…' : 'Saving…');
    try {
      let pollId = editingId;
      if (editingId) {
        await API.put(`/api/admin/polls/${editingId}`, payload);
        toast('Bid round updated', 'ok');
      } else {
        const res = await API.post('/api/admin/polls', payload);
        pollId = res.poll.id;
        toast(`Bid round for ${playerName} created`, 'ok');
      }
      if (submitMode === 'start' && pollId) {
        await API.post(`/api/admin/polls/${pollId}/action`, {
          action: 'start',
          timerSeconds: payload.timerSeconds
        });
        toast('Live on every device now', 'ok');
      }
      closeEditor();
      await window.AdminShell.refresh();
      renderList(window.AdminShell.state);
    } catch (err) {
      showError(err.message);
      toast(err.message, 'err');
    } finally {
      setBusy(btn, false);
    }
  });

  /* ------------------------------- list -------------------------------- */

  document.getElementById('filters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    filter = chip.dataset.filter;
    document.querySelectorAll('#filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderList(window.AdminShell.state);
  });

  function winnersBlock(p) {
    const r = p.results || {};
    if (!r.totalGuesses) {
      return `<div class="mini-row"><span class="mini-label mute-sm">No guesses yet</span></div>`;
    }
    if (r.actualLakh == null) {
      return `<div class="mini-row">
        <span class="mini-label">${r.totalGuesses} ${plural(r.totalGuesses, 'guess', 'guesses')} in</span>
        <span class="mute-sm">· sold price not entered</span>
      </div>`;
    }
    return (r.winners || [])
      .map(
        (w) => `<div class="mini-row">
          <span class="mini-label">${['🥇', '🥈', '🥉'][w.rank - 1] || '#' + w.rank} ${escapeHtml(w.name)}</span>
          <span class="mini-pct">${escapeHtml(w.guessLabel)}</span>
          <span class="mute-sm">${escapeHtml(w.diffLabel)} ${escapeHtml(w.direction)}</span>
        </div>`
      )
      .join('');
  }

  function renderList(state) {
    if (!state) return;
    const polls = state.polls.filter((p) => {
      if (filter === 'all') return true;
      if (filter === 'active') return p.status === 'active' || p.status === 'paused';
      return p.status === filter;
    });

    if (!polls.length) {
      listEl.innerHTML = `<div class="card empty"><div class="empty-icon">🎯</div>No bid rounds in this view. Tap “+ New poll” to create one.</div>`;
      return;
    }

    listEl.innerHTML = polls
      .map(
        (p) => `
      <div class="poll-item ${p.status === 'active' ? 'is-live' : ''}">
        <div class="poll-item-head">
          <div class="grow">
            <div class="poll-item-q">${escapeHtml(p.question)}</div>
            ${p.description ? `<div class="mute-sm" style="margin-top:4px">${escapeHtml(p.description)}</div>` : ''}
          </div>
          <span class="pill pill-ghost">#${p.id}</span>
        </div>
        <div class="poll-item-meta">
          ${UI.metaChips(p)}
          <span class="pill pill-ghost">${timeAgo(p.createdAt)}</span>
        </div>
        <div class="admin-mini-results">${winnersBlock(p)}</div>
        <div class="poll-actions" style="margin-top:14px">
          ${UI.controlButtons(p)}
          <button class="btn btn-ghost btn-sm" data-guesses="${p.id}">👥 All guesses &amp; winners</button>
        </div>
      </div>`
      )
      .join('');

    listEl.querySelectorAll('[data-guesses]').forEach((btn) => {
      btn.addEventListener('click', () => window.PollGuessSheet.open(Number(btn.dataset.guesses)));
    });

    UI.bindActions(listEl, { onEdit: openEditor });
  }

  /* ------------------------------- boot -------------------------------- */

  window.AdminShell.ready.then(() => {
    const state = window.AdminShell.state;
    renderList(state);
    window.AdminShell.onChange((s) => renderList(s));

    const params = new URLSearchParams(location.search);
    const editId = Number(params.get('edit'));
    if (editId) {
      const poll = (window.AdminShell.state?.polls || []).find((p) => p.id === editId);
      if (poll) openEditor(poll);
    } else if (params.get('new') === '1') {
      openEditor();
    }
  });
})();
