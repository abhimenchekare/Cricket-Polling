/* Admin — participant management */
(function () {
  'use strict';
  const { API, toast, escapeHtml, confirmDialog, debounce, timeAgo, setBusy } = window.App;

  const listEl = document.getElementById('p-list');
  const searchEl = document.getElementById('search');
  const kpisEl = document.getElementById('p-kpis');

  let participants = [];
  let query = '';

  function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  }

  async function load() {
    try {
      const [res, adminState] = await Promise.all([
        API.get(`/api/admin/participants?q=${encodeURIComponent(query)}`),
        API.get('/api/admin/state')
      ]);
      participants = res.participants;
      renderKpis(adminState);
      renderList();
    } catch (err) {
      if (err.status === 401) window.location.replace('/admin-login');
    }
  }

  function renderKpis(state) {
    const s = state.stats;
    kpisEl.innerHTML = `
      <div class="kpi"><div class="kpi-value">${s.participants}</div><div class="kpi-label">Joined</div></div>
      <div class="kpi"><div class="kpi-value">${s.onlineParticipants}</div><div class="kpi-label">Online now</div></div>
      <div class="kpi gold"><div class="kpi-value">${s.totalVotes}</div><div class="kpi-label">Votes cast</div></div>
      <div class="kpi"><div class="kpi-value">${s.blocked}</div><div class="kpi-label">Blocked</div></div>
    `;
  }

  function renderList() {
    if (!participants.length) {
      listEl.innerHTML = `<div class="empty"><div class="empty-icon">👥</div>${query ? 'No participants match your search.' : 'Nobody has joined yet. Share the join link from the dashboard.'}</div>`;
      return;
    }
    listEl.innerHTML = participants
      .map(
        (p) => `
      <div class="participant-row ${p.blocked ? 'blocked' : ''}" data-id="${p.id}">
        <div class="avatar" style="width:40px;height:40px;font-size:14px;border-radius:12px">${escapeHtml(initials(p.name))}</div>
        <div class="grow">
          <div class="p-name">${escapeHtml(p.name)} ${p.blocked ? '<span class="pill pill-closed" style="margin-left:6px">blocked</span>' : ''}</div>
          <div class="p-sub">${escapeHtml(p.employeeId)}${p.team ? ' · ' + escapeHtml(p.team) : ''} · ${p.voteCount} vote${p.voteCount === 1 ? '' : 's'} · joined ${timeAgo(p.createdAt)}</div>
        </div>
        <div class="row" style="gap:6px">
          <button class="btn btn-ghost btn-sm" data-act="toggle" title="${p.blocked ? 'Unblock' : 'Block'}">${p.blocked ? '✅' : '🚫'}</button>
          <button class="btn btn-ghost btn-sm" data-act="clear" title="Clear this participant's votes">⟲</button>
          <button class="btn btn-ghost btn-sm" data-act="delete" title="Remove participant" aria-label="Remove participant"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg></button>
        </div>
      </div>`
      )
      .join('');

    listEl.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => handle(btn.closest('.participant-row').dataset.id, btn.dataset.act));
    });
  }

  async function handle(id, act) {
    const p = participants.find((x) => String(x.id) === String(id));
    if (!p) return;
    try {
      if (act === 'toggle') {
        await API.patch(`/api/admin/participants/${id}`, { blocked: !p.blocked });
        toast(p.blocked ? `${p.name} can vote again` : `${p.name} blocked from voting`, 'ok');
      } else if (act === 'clear') {
        const ok = await confirmDialog({
          title: 'Clear votes?',
          message: `Delete every vote cast by <strong>${escapeHtml(p.name)}</strong>? They will be able to vote again.`,
          confirmText: 'Clear votes',
          danger: true
        });
        if (!ok) return;
        await API.del(`/api/admin/participants/${id}/votes`);
        toast('Votes cleared', 'ok');
      } else if (act === 'delete') {
        const ok = await confirmDialog({
          title: 'Remove participant?',
          message: `Remove <strong>${escapeHtml(p.name)}</strong> and all their votes? They can re-join with the same employee ID.`,
          confirmText: 'Remove',
          danger: true
        });
        if (!ok) return;
        await API.del(`/api/admin/participants/${id}`);
        toast('Participant removed', 'ok');
      }
      await load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  searchEl.addEventListener(
    'input',
    debounce(() => {
      query = searchEl.value.trim();
      load();
    }, 300)
  );

  document.getElementById('export-btn').addEventListener('click', () => {
    window.location.href = '/api/admin/export/participants.csv';
  });

  document.getElementById('add-btn').addEventListener('click', async () => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <div class="modal-title">Add a participant</div>
        <div class="modal-body">Pre-register someone so they can join instantly, or use this when their phone is out of battery.</div>
        <div class="stack">
          <label class="field"><span class="label">Name</span><input class="input" id="np-name" maxlength="40" placeholder="Priya Sharma" /></label>
          <label class="field"><span class="label">Employee ID</span><input class="input" id="np-id" maxlength="24" placeholder="EMP2041" /></label>
          <label class="field"><span class="label">Team (optional)</span><input class="input" id="np-team" maxlength="40" placeholder="Pune Panthers" /></label>
        </div>
        <p class="error-text hidden" id="np-err" style="margin-top:10px"></p>
        <div class="modal-actions" style="margin-top:18px">
          <button class="btn btn-ghost" data-close>Cancel</button>
          <button class="btn btn-primary" id="np-save">Add participant</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.hasAttribute('data-close')) backdrop.remove();
    });
    const errEl = backdrop.querySelector('#np-err');
    backdrop.querySelector('#np-save').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const name = backdrop.querySelector('#np-name').value.trim();
      const employeeId = backdrop.querySelector('#np-id').value.trim();
      const team = backdrop.querySelector('#np-team').value.trim();
      setBusy(btn, true, 'Adding…');
      try {
        await API.post('/api/admin/participants', { name, employeeId, team });
        toast('Participant added', 'ok');
        backdrop.remove();
        await load();
      } catch (err) {
        setBusy(btn, false);
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });
  });

  const refreshSoon = debounce(() => load(), 2500);

  window.AdminShell.ready.then(() => {
    load();
    window.AdminShell.onChange((state) => {
      renderKpis(state);
      // Keep vote counts fresh without hammering the API on every vote
      refreshSoon();
    });
  });
})();
