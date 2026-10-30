/* Join page logic */
(function () {
  'use strict';
  const { API, toast, setBusy, escapeHtml } = window.App;

  const form = document.getElementById('join-form');
  const nameInput = document.getElementById('name');
  const codeInput = document.getElementById('code');
  const codeField = document.getElementById('code-field');
  const errorBox = document.getElementById('join-error');
  const submitBtn = document.getElementById('join-submit');
  const returning = document.getElementById('returning');
  const statsEl = document.getElementById('join-stats');
  const joinUrlEl = document.getElementById('join-url');
  const copyBtn = document.getElementById('copy-link');
  const eventNameEls = document.querySelectorAll('[data-event-name]');
  const taglineEls = document.querySelectorAll('[data-event-tagline]');

  let meta = null;

  function showError(msg) {
    if (!msg) {
      errorBox.classList.add('hidden');
      errorBox.textContent = '';
      return;
    }
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
  }

  async function loadMeta() {
    try {
      meta = await API.get('/api/meta');
    } catch (err) {
      toast('Could not reach the polling server. Is it running?', 'err', 5000);
      return;
    }

    eventNameEls.forEach((el) => (el.textContent = meta.event.name));
    taglineEls.forEach((el) => (el.textContent = meta.event.tagline || ''));
    document.title = `${meta.event.name} · Join`;

    if (meta.event.displayMessage) {
      const msg = document.getElementById('event-message');
      if (msg) {
        msg.textContent = meta.event.displayMessage;
        msg.classList.remove('hidden');
      }
    }

    // Share link
    if (joinUrlEl) joinUrlEl.textContent = meta.join.joinUrl;
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const ok = await window.App.copyText(meta.join.joinUrl);
        toast(ok ? 'Link copied — paste it in the group chat' : meta.join.joinUrl, ok ? 'ok' : 'info', 4000);
      });
    }

    // Access code field
    if (meta.join.requiresCode) codeField.classList.remove('hidden');

    // Join closed?
    if (!meta.join.allowNewParticipants && !meta.viewer.joined) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Joining is closed by the host';
      showError('The host has temporarily closed new joins. Please ask the organiser to enable joining.');
    }

    // Already joined
    if (meta.viewer.joined) {
      returning.classList.remove('hidden');
      document.getElementById('returning-name').textContent = meta.viewer.name;
      nameInput.value = meta.viewer.name;
      submitBtn.textContent = 'Continue to polls';
    }

    // Participant stats
    try {
      const state = await API.get('/api/state');
      if (statsEl) {
        statsEl.innerHTML = `
          <span class="pill pill-green-soft">👥 ${state.stats.participants} joined</span>
          <span class="pill pill-ghost">📊 ${state.stats.votesOnCurrent} votes on current poll</span>
          ${state.poll && state.poll.status === 'active' ? '<span class="pill pill-live"><span class="dot"></span>Poll live now</span>' : ''}
        `;
      }
    } catch {
      /* non-fatal */
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const name = nameInput.value.trim();
    const code = codeInput ? codeInput.value.trim() : '';

    if (name.length < 2) return showError('Please enter your full name');
    if (name.length > 40) return showError('That name is a little too long');
    if (meta?.join?.requiresCode && !code) return showError('Please enter the event access code');

    setBusy(submitBtn, true, 'Joining…');
    try {
      const res = await API.post('/api/join', { name, code });
      toast(res.returning ? `Welcome back, ${res.participant.name}!` : `You're in, ${res.participant.name}!`, 'ok');
      window.location.href = '/poll';
    } catch (err) {
      setBusy(submitBtn, false);
      showError(err.message);
      if (err.data?.error) toast(err.data.error, 'err');
    }
  });

  // Remember name locally for convenience on this device
  const saved = localStorage.getItem('cp_last_name');
  if (saved && !nameInput.value) nameInput.value = saved;
  form.addEventListener('submit', () => {
    localStorage.setItem('cp_last_name', nameInput.value.trim());
  });

  loadMeta();
})();
