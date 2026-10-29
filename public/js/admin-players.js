/* Admin — the auction list: the ordered roster the host shouts from. */
(function () {
  'use strict';
  const { API, toast, escapeHtml, confirmDialog, setBusy, plural } = window.App;

  const listEl = document.getElementById('player-list');
  const countEl = document.getElementById('roster-count');
  const importText = document.getElementById('import-text');
  const importBtn = document.getElementById('import-btn');
  const importNote = document.getElementById('import-note');

  let players = [];
  let filter = 'all';
  let loading = false;

  const SAMPLE = [
    'Rohit Sharma, Batter, 2 Cr',
    'Jasprit Bumrah, Bowler, 1.5 Cr',
    'Hardik Pandya, All-rounder, 1.75 Cr',
    'Rishabh Pant, Wicketkeeper, 1.6 Cr',
    'Virat Kohli, Batter, 2.5 Cr',
    'Ravindra Jadeja, All-rounder, 1.4 Cr',
    'Suryakumar Yadav, Batter, 1.8 Cr',
    'Mohammed Siraj, Bowler, 1 Cr',
    'KL Rahul, Wicketkeeper, 1.5 Cr',
    'Axar Patel, All-rounder, 1.2 Cr'
  ].join('\n');

  const STATUS_LABEL = {
    queued: 'QUEUED',
    on_block: 'ON THE BLOCK',
    sold: 'SOLD',
    unsold: 'UNSOLD',
    skipped: 'SKIPPED'
  };
  const STATUS_PILL = {
    queued: 'pill-ghost',
    on_block: 'pill-live',
    sold: 'pill-green-soft',
    unsold: 'pill-paused',
    skipped: 'pill-draft'
  };

  /* ------------------------------- load ---------------------------------- */

  async function load({ quiet = false } = {}) {
    if (loading) return;
    loading = true;
    try {
      const data = await API.get('/api/admin/players');
      players = data.players || [];
      render();
      countEl.textContent = `${players.length} ${plural(players.length, 'player', 'players')}`;
    } catch (err) {
      if (!quiet) toast(err.message, 'err');
    } finally {
      loading = false;
    }
  }

  /* ------------------------------ render --------------------------------- */

  function row(p, index) {
    const isBlock = p.status === 'on_block';
    const canMove = p.status === 'queued';
    return `
      <div class="player-row" data-id="${p.id}" style="display:flex;align-items:center;gap:12px;padding:12px 4px;
           border-top:1px solid rgba(255,255,255,.07);${isBlock ? 'background:rgba(246,196,83,.08)' : ''}">
        <div style="width:34px;text-align:center;font:800 13px system-ui;color:#8fa1bd">${index + 1}</div>
        <div style="flex:1;min-width:0">
          <div style="font:800 15px system-ui;color:#fff">${escapeHtml(p.name)}
            ${p.role ? `<span class="mute-sm" style="font-weight:600">· ${escapeHtml(p.role)}</span>` : ''}
          </div>
          <div class="mute-sm" style="margin-top:2px">
            ${p.baseLabel ? `base ${escapeHtml(p.baseLabel)}` : 'no base price'}
            ${p.guessCount ? ` · ${p.guessCount} ${plural(p.guessCount, 'guess', 'guesses')}` : ''}
          </div>
        </div>
        ${
          p.soldLabel
            ? `<span style="font:800 14px system-ui;color:#f6c453">${escapeHtml(p.soldLabel)}</span>`
            : ''
        }
        <span class="pill ${STATUS_PILL[p.status] || 'pill-ghost'}">${STATUS_LABEL[p.status] || p.status}</span>
        <div class="row" style="gap:4px">
          ${
            canMove
              ? `<button class="icon-btn" data-move="-1" data-id="${p.id}" title="Move up" ${index === 0 ? 'disabled' : ''}>↑</button>
                 <button class="icon-btn" data-move="1" data-id="${p.id}" title="Move down" ${index === players.length - 1 ? 'disabled' : ''}>↓</button>`
              : ''
          }
          <button class="icon-btn" data-edit="${p.id}" title="Rename" aria-label="Rename"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
          <button class="icon-btn" data-del="${p.id}" title="Remove" aria-label="Remove"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg></button>
        </div>
      </div>`;
  }

  function render() {
    const shown = players.filter((p) => filter === 'all' || p.status === filter);
    if (!players.length) {
      listEl.innerHTML = `
        <div class="empty" style="padding:26px;text-align:center">
          <div style="font-size:26px">📋</div>
          <div style="margin-top:8px;font-weight:700">The auction list is empty.</div>
          <div class="mute-sm" style="margin-top:6px">Paste your players above — after that the SHOUT button does the rest.</div>
        </div>`;
      return;
    }
    if (!shown.length) {
      listEl.innerHTML = `<div class="empty" style="padding:20px">Nobody in this filter.</div>`;
      return;
    }
    listEl.innerHTML = shown
      .map((p) => row(p, players.findIndex((x) => x.id === p.id)))
      .join('');
    wire();
  }

  /* ------------------------------ actions -------------------------------- */

  function wire() {
    listEl.querySelectorAll('[data-move]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        await API.post(`/api/admin/players/${btn.dataset.id}/move`, { delta: Number(btn.dataset.move) });
        load({ quiet: true });
      })
    );

    listEl.querySelectorAll('[data-edit]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const p = players.find((x) => x.id === Number(btn.dataset.edit));
        const name = window.prompt('Player name', p.name);
        if (name === null) return;
        const role = window.prompt('Role (optional) — e.g. Batter', p.role || '');
        await API.put(`/api/admin/players/${p.id}`, { name, role: role || null });
        toast('Player updated', 'ok');
        load({ quiet: true });
      })
    );

    listEl.querySelectorAll('[data-del]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const p = players.find((x) => x.id === Number(btn.dataset.del));
        const ok = await confirmDialog({
          title: `Remove ${p.name}?`,
          message: 'They are taken off the auction list. Their round (if any) stays in history.',
          confirmText: 'Remove',
          danger: true
        });
        if (!ok) return;
        await API.del(`/api/admin/players/${p.id}`);
        toast(`${p.name} removed`, 'info');
        load({ quiet: true });
      })
    );
  }

  document.getElementById('p-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-pfilter]');
    if (!chip) return;
    filter = chip.dataset.pfilter;
    document.querySelectorAll('#p-filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    render();
  });

  importBtn.addEventListener('click', async () => {
    const raw = importText.value.trim();
    if (!raw) {
      importText.focus();
      return toast('Paste the players first — one per line', 'err');
    }
    setBusy(importBtn, true, 'Adding…');
    try {
      const res = await API.post('/api/admin/players', { names: raw });
      importNote.textContent = res.skipped && res.skipped.length
        ? `${res.added} added · ${res.skipped.length} already on the list`
        : `${res.added} added`;
      toast(`${res.added} ${plural(res.added, 'player', 'players')} added`, 'ok');
      importText.value = '';
      await load({ quiet: true });
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setBusy(importBtn, false);
    }
  });

  document.getElementById('demo-btn').addEventListener('click', () => {
    importText.value = SAMPLE;
    importText.focus();
  });

  document.getElementById('reset-btn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Reset the auction run?',
      message:
        'Every player goes back to the queue and all sold prices are cleared. The rounds and their guesses stay in history.',
      confirmText: 'Reset the run',
      danger: true
    });
    if (!ok) return;
    await API.post('/api/admin/players/reset', { confirm: true });
    toast('Auction list reset', 'ok');
    load({ quiet: true });
  });

  /* -------------------------------- boot --------------------------------- */

  window.AdminShell.ready.then(() => {
    load();
    window.AdminShell.onChange(() => load({ quiet: true }));
  });
})();
