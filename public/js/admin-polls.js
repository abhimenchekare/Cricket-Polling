/* Admin — create & manage polls */
(function () {
  'use strict';
  const { API, toast, escapeHtml, confirmDialog, setBusy, timeAgo } = window.App;
  const UI = window.AdminPollUI;

  const editorCard = document.getElementById('editor-card');
  const editorTitle = document.getElementById('editor-title');
  const editorEyebrow = document.getElementById('editor-eyebrow');
  const form = document.getElementById('poll-form');
  const optionEditor = document.getElementById('option-editor');
  const optCount = document.getElementById('opt-count');
  const addOptionBtn = document.getElementById('add-option');
  const formError = document.getElementById('form-error');
  const listEl = document.getElementById('poll-list');
  const timerInput = document.getElementById('f-timer');
  const anonInput = document.getElementById('f-anon');
  const qInput = document.getElementById('f-question');
  const qInputBid = document.getElementById('f-question-bid');
  const playerInput = document.getElementById('f-player');
  let pollType = 'choice';

  function setPollType(type, { keepFields = false } = {}) {
    pollType = type === 'bid' ? 'bid' : 'choice';
    document.querySelectorAll('#type-seg button').forEach((b) => {
      b.classList.toggle('active', b.dataset.type === pollType);
    });
    document.getElementById('bid-fields').classList.toggle('hidden', pollType !== 'bid');
    document.getElementById('choice-question-section').classList.toggle('hidden', pollType === 'bid');
    document.getElementById('options-section').classList.toggle('hidden', pollType === 'bid');
    const vis = document.getElementById('vis-section');
    if (vis) {
      vis.style.opacity = pollType === 'bid' ? '0.5' : '1';
      vis.querySelector('.hint, p.hint')?.classList.toggle('hidden', pollType === 'bid');
    }
    if (!keepFields) {
      // sensible default countdown for a bid round
      if (pollType === 'bid' && (!timerInput.value || Number(timerInput.value) === 30)) {
        timerInput.value = 20;
        markTimerPreset();
      }
    }
  }

  document.getElementById('type-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-type]');
    if (!btn) return;
    setPollType(btn.dataset.type);
  });
  const dInput = document.getElementById('f-description');
  const cInput = document.getElementById('f-category');

  let editingId = null;
  let visibility = 'after';
  let filter = 'all';
  let submitMode = 'draft';

  /* ----------------------------- options UI ----------------------------- */

  function optionRow(label = '', emoji = '') {
    const row = document.createElement('div');
    row.className = 'option-input-row';
    row.innerHTML = `
      <input class="input emoji-input" maxlength="4" placeholder="🏏" value="${escapeHtml(emoji)}" aria-label="Option emoji" />
      <input class="input" maxlength="120" placeholder="Option text" value="${escapeHtml(label)}" aria-label="Option text" />
      <button type="button" class="remove-opt" aria-label="Remove option">✕</button>`;
    row.querySelector('.remove-opt').addEventListener('click', () => {
      if (optionEditor.children.length <= 2) return toast('A poll needs at least 2 options', 'err');
      row.remove();
      refreshOptionState();
    });
    return row;
  }

  function refreshOptionState() {
    const n = optionEditor.children.length;
    optCount.textContent = n;
    addOptionBtn.disabled = n >= 10;
    Array.from(optionEditor.children).forEach((row) => {
      row.querySelector('.remove-opt').disabled = n <= 2;
    });
  }

  function setOptions(options) {
    optionEditor.innerHTML = '';
    const list = options && options.length ? options : [{ label: '', emoji: '🏏' }, { label: '', emoji: '🔥' }];
    list.forEach((o) => optionEditor.appendChild(optionRow(o.label, o.emoji || '')));
    refreshOptionState();
  }

  addOptionBtn.addEventListener('click', () => {
    if (optionEditor.children.length >= 10) return;
    optionEditor.appendChild(optionRow());
    refreshOptionState();
    optionEditor.lastElementChild.querySelectorAll('input')[1].focus();
  });

  /* ---------------------------- visibility UI ---------------------------- */

  const visHints = {
    during: 'Participants see live results while the poll runs.',
    after: 'Participants see results only once the poll closes.',
    never: 'Results stay private — only admins can see them.'
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
    editorTitle.textContent = poll ? 'Edit poll' : 'Create a poll';
    qInput.value = poll ? poll.question : '';
    dInput.value = poll ? poll.description || '' : '';
    cInput.value = poll ? poll.category || '' : '';
    timerInput.value = poll ? poll.timerSeconds : 30;
    markTimerPreset();
    anonInput.checked = poll ? !!poll.anonymous : false;
    visibility = poll ? poll.showResults : 'after';
    document.querySelectorAll('#vis-seg button').forEach((b) => b.classList.toggle('active', b.dataset.vis === visibility));
    document.getElementById('vis-hint').textContent = visHints[visibility];
    setOptions(poll && poll.pollType !== 'bid' ? poll.options : null);
    setPollType(poll && poll.pollType === 'bid' ? 'bid' : 'choice', { keepFields: true });
    playerInput.value = poll && poll.playerName ? poll.playerName : '';
    qInputBid.value = poll && poll.pollType === 'bid' ? poll.question || '' : '';
    showError('');
    editorCard.classList.remove('hidden');
    editorCard.classList.add('fade-up');
    document.getElementById('save-start').textContent = poll ? 'Save & start' : 'Save & start';
    if (poll && poll.totalVotes > 0) {
      toast('This poll has votes — options are locked', 'info');
    }
    editorCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeEditor() {
    editorCard.classList.add('hidden');
    editingId = null;
    if (location.search.includes('edit=')) history.replaceState({}, '', '/admin/polls');
  }

  document.getElementById('new-poll').addEventListener('click', () => openEditor());
  document.getElementById('close-editor').addEventListener('click', closeEditor);
  document.getElementById('cancel-editor').addEventListener('click', closeEditor);

  document.getElementById('save-draft').addEventListener('click', () => (submitMode = 'draft'));
  document.getElementById('save-start').addEventListener('click', () => (submitMode = 'start'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const isBid = pollType === 'bid';
    const question = (isBid ? qInputBid.value.trim() : qInput.value.trim());
    const playerName = playerInput.value.trim();
    const options = Array.from(optionEditor.children).map((row) => ({
      emoji: row.querySelector('.emoji-input').value.trim(),
      label: row.querySelectorAll('.input')[1].value.trim()
    })).filter((o) => o.label);

    if (isBid) {
      if (!playerName) return showError('Enter the player name for this bid round');
    } else {
      if (question.length < 5) return showError('Please write a question (at least 5 characters)');
      if (options.length < 2) return showError('Add at least 2 answer options');
    }

    const payload = {
      pollType: isBid ? 'bid' : 'choice',
      playerName: isBid ? playerName : null,
      question: isBid
        ? question || `What will be the bid range for ${playerName} player?`
        : question,
      description: dInput.value.trim(),
      category: cInput.value.trim() || (isBid ? 'Bid range' : ''),
      timerSeconds: Number(timerInput.value) || 0,
      showResults: visibility,
      anonymous: anonInput.checked,
      options: isBid ? [] : options
    };

    const btn = submitMode === 'start' ? document.getElementById('save-start') : document.getElementById('save-draft');
    setBusy(btn, true, submitMode === 'start' ? 'Starting…' : 'Saving…');
    try {
      let pollId = editingId;
      if (editingId) {
        await API.put(`/api/admin/polls/${editingId}`, payload);
        toast('Poll updated', 'ok');
      } else {
        const res = await API.post('/api/admin/polls', payload);
        pollId = res.poll.id;
        toast('Poll created', 'ok');
      }
      if (submitMode === 'start' && pollId) {
        await API.post(`/api/admin/polls/${pollId}/action`, {
          action: 'start',
          timerSeconds: payload.timerSeconds
        });
        toast('Poll is live on every device', 'ok');
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

  function renderList(state) {
    if (!state) return;
    const polls = state.polls.filter((p) => {
      if (filter === 'all') return true;
      if (filter === 'active') return p.status === 'active' || p.status === 'paused';
      return p.status === filter;
    });

    if (!polls.length) {
      listEl.innerHTML = `<div class="card empty"><div class="empty-icon">📋</div>No polls in this view. Tap “+ New poll” to create one.</div>`;
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
        ${
          p.totalVotes || (p.pollType === 'bid' && p.actualLakh)
            ? `<div class="admin-mini-results">${
                p.results.kind === 'bid'
                  ? p.results.actualLakh
                    ? p.results.winners
                        .map(
                          (w) => `<div class="mini-row">
                            <span class="mini-label">${['🥇', '🥈', '🥉'][w.rank - 1] || '#' + w.rank} ${escapeHtml(w.name)}</span>
                            <span class="mini-pct">${escapeHtml(w.guessLabel)}</span>
                            <span class="mute-sm">${escapeHtml(w.diffLabel)}</span>
                          </div>`
                        )
                        .join('')
                    : `<div class="mini-row"><span class="mini-label">${p.results.totalGuesses} guesses · sold price not entered</span></div>`
                  : p.results.rows
                      .slice(0, 5)
                      .map(
                        (r) => `<div class="mini-row">
                    <span class="mini-label">${r.emoji ? escapeHtml(r.emoji) + ' ' : ''}${escapeHtml(r.label)}</span>
                    <span class="mini-pct">${r.percent}%</span>
                    <span class="mute-sm">${r.votes}</span>
                  </div>`
                      )
                      .join('')
              }</div>`
            : ''
        }
        <div class="poll-actions" style="margin-top:14px">${UI.controlButtons(p)}</div>
      </div>`
      )
      .join('');

    UI.bindActions(listEl, { onEdit: openEditor });
    UI.animateBars(listEl);
  }

  /* ------------------------------- boot -------------------------------- */

  window.AdminShell.ready.then(() => {
    const state = window.AdminShell.state;
    renderList(state);
    window.AdminShell.onChange((s) => renderList(s));

    setOptions(null);

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
