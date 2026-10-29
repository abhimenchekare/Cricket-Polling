/* Admin — the results ledger: every player, their sold price, and the three closest guesses. */
(function () {
  'use strict';
  const { API, toast, escapeHtml, setBusy, plural } = window.App;

  const kpisEl = document.getElementById('lg-kpis');
  const standingsEl = document.getElementById('lg-standings');
  const roundsEl = document.getElementById('st-rounds');
  const rowsEl = document.getElementById('lg-rows');
  const filterEl = document.getElementById('lg-filter');
  const searchEl = document.getElementById('lg-search');
  const exportBtn = document.getElementById('export-btn');

  let data = { rows: [], summary: {}, standings: [] };
  let filter = 'all';
  let term = '';
  let ladder = [];
  let loading = false;

  /* price entry for a player who has no sold price yet */
  const openSettle = { id: null };

  function lakhLabel(lakh) {
    const found = ladder.find((x) => x.lakh === Number(lakh));
    if (found) return found.label;
    const n = Number(lakh);
    if (n < 100) return `${n} L`;
    const cr = n / 100;
    return `${Number.isInteger(cr) ? cr.toFixed(2) : cr} Cr`;
  }

  function statusPill(row) {
    if (row.settled) return '<span class="pill pill-green-soft">SOLD</span>';
    if (row.pollId) return '<span class="pill pill-paused">AWAITING PRICE</span>';
    if (row.status === 'unsold') return '<span class="pill pill-paused">UNSOLD</span>';
    if (row.status === 'on_block') return '<span class="pill pill-live">ON THE BLOCK</span>';
    return '<span class="pill pill-ghost">NOT SHOUTED</span>';
  }

  function renderKpis() {
    const s = data.summary || {};
    const tiles = [
      ['Players', s.total || 0, 'in the auction list'],
      ['Sold', `${s.settled || 0} / ${s.total || 0}`, s.spentLabel ? `${s.spentLabel} spent` : 'no sales yet'],
      ['Awaiting price', s.awaitingPrice || 0, 'settle any time'],
      ['Guesses', s.totalGuesses || 0, `${s.guessesPerRound || 0} per sold player`]
    ];
    kpisEl.innerHTML = tiles
      .map(
        ([label, value, note]) => `
        <div class="kpi">
          <div class="kpi-value">${escapeHtml(String(value))}</div>
          <div class="kpi-label">${escapeHtml(label)}</div>
          <div class="mute-sm">${escapeHtml(note)}</div>
        </div>`
      )
      .join('');
  }

  function renderStandings() {
    const list = data.standings || [];
    roundsEl.textContent = `${data.summary.settled || 0} ${plural(data.summary.settled || 0, 'round', 'rounds')}`;
    if (!list.length) {
      standingsEl.innerHTML =
        '<div class="mute-sm">No sold prices yet — declare the first winner and the leaderboard fills in.</div>';
      return;
    }
    standingsEl.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>#</th><th>Participant</th><th>1st</th><th>2nd</th><th>3rd</th>
              <th>Points</th><th>Exact</th><th>Avg miss</th>
            </tr>
          </thead>
          <tbody>
            ${list
              .slice(0, 20)
              .map(
                (s) => `
              <tr>
                <td>${s.rank <= 3 ? `<strong style="color:var(--gold-300,#ffd166)">#${s.rank}</strong>` : s.rank}</td>
                <td><strong>${escapeHtml(s.name)}</strong></td>
                <td>${s.firsts || '·'}</td>
                <td>${s.seconds || '·'}</td>
                <td>${s.thirds || '·'}</td>
                <td><strong>${s.points}</strong></td>
                <td>${s.exact || '·'}</td>
                <td class="mute-sm">${escapeHtml(s.avgDiffLabel || '—')}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`;
  }

  function winnersCell(row) {
    if (!row.settled) return '<span class="mute-sm">winners appear once the price is in</span>';
    if (!row.guessCount) return '<span class="mute-sm">nobody guessed this player</span>';
    return row.winners
      .map(
        (w) => `
        <div class="lg-winner">
          <span class="lg-rank">${w.rank}</span>
          <span class="lg-name">${escapeHtml(w.name)}</span>
          <span class="lg-guess">${escapeHtml(w.guessLabel)}</span>
          <span class="mute-sm">${escapeHtml(w.diffLabel)} off</span>
        </div>`
      )
      .join('');
  }

  function settleCell(row) {
    if (row.settled) {
      return `<strong style="color:var(--gold-300,#ffd166)">${escapeHtml(row.soldLabel || '')}</strong>`;
    }
    if (!row.pollId) return '<span class="mute-sm">—</span>';
    if (openSettle.id === row.playerId) {
      return `
        <div class="row" style="gap:6px;align-items:center;flex-wrap:wrap">
          <input class="input" id="settle-input" style="max-width:110px" placeholder="2.10 Cr" autofocus />
          <button class="btn btn-gold btn-sm" data-settle-save="${row.playerId}">Save</button>
        </div>`;
    }
    return `<button class="btn btn-ghost btn-sm" data-settle="${row.playerId}">Enter price</button>`;
  }

  function renderRows() {
    const rows = (data.rows || []).filter((row) => {
      if (filter === 'settled' && !row.settled) return false;
      if (filter === 'awaiting' && !(row.pollId && !row.settled)) return false;
      if (filter === 'queued' && row.pollId) return false;
      if (term && !row.name.toLowerCase().includes(term)) return false;
      return true;
    });

    if (!rows.length) {
      rowsEl.innerHTML = '<div class="mute-sm">Nothing matches that filter.</div>';
      return;
    }

    rowsEl.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>#</th><th>Player</th><th>Sold for</th><th>Guesses</th><th>The three closest guesses</th><th>Status</th></tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
              <tr data-player="${row.playerId}">
                <td class="mute-sm">${row.position}</td>
                <td>
                  <strong>${escapeHtml(row.name)}</strong>
                  <div class="mute-sm">${escapeHtml(row.role || '')}${row.baseLabel ? ' · base ' + escapeHtml(row.baseLabel) : ''}</div>
                </td>
                <td>${settleCell(row)}</td>
                <td>${row.guessCount}</td>
                <td>${winnersCell(row)}</td>
                <td>${statusPill(row)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`;

    rowsEl.querySelectorAll('[data-settle]').forEach((btn) =>
      btn.addEventListener('click', () => {
        openSettle.id = Number(btn.dataset.settle);
        renderRows();
      })
    );
    rowsEl.querySelectorAll('[data-settle-save]').forEach((btn) =>
      btn.addEventListener('click', () => saveSettle(Number(btn.dataset.settleSave), btn))
    );
    const input = document.getElementById('settle-input');
    if (input)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveSettle(openSettle.id, null);
      });
  }

  async function saveSettle(playerId, btn) {
    const input = document.getElementById('settle-input');
    const row = (data.rows || []).find((r) => r.playerId === playerId);
    if (!row || !row.pollId) return;
    const raw = (input && input.value.trim()) || '';
    if (!raw) return toast('Type the sold price, e.g. 2.10 Cr', 'err');
    if (btn) setBusy(btn, true, 'Saving…');
    try {
      const res = await API.post(`/api/admin/polls/${row.pollId}/actual`, { price: raw });
      openSettle.id = null;
      await load(true);
      const names = (res.winners || []).map((w) => w.name).join(', ');
      toast(`Sold for ${res.actualLabel}${names ? ' · ' + names : ''}`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
      if (btn) setBusy(btn, false);
    }
  }

  function render() {
    renderKpis();
    renderStandings();
    renderRows();
  }

  async function load(quiet) {
    if (loading) return;
    loading = true;
    try {
      data = await API.get('/api/admin/ledger');
      render();
    } catch (err) {
      if (!quiet) toast('Could not load the results', 'err');
    } finally {
      loading = false;
    }
  }

  filterEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-f]');
    if (!btn) return;
    filter = btn.dataset.f;
    filterEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    renderRows();
  });

  searchEl.addEventListener('input', () => {
    term = searchEl.value.trim().toLowerCase();
    renderRows();
  });

  exportBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const token = window.App.getAdminToken && window.App.getAdminToken();
      const res = await fetch('/api/admin/ledger.csv', {
        headers: token ? { 'x-admin-token': token } : {},
        credentials: 'same-origin'
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'auction-results.csv';
      a.click();
      URL.revokeObjectURL(url);
      toast('Results exported', 'ok');
    } catch (err) {
      toast(err.message || 'Export failed', 'err');
    }
  });

  (async () => {
    try {
      const meta = await API.get('/api/meta');
      ladder = (meta.bid && meta.bid.ladder) || [];
      document.querySelectorAll('[data-event-name]').forEach((el) => (el.textContent = meta.event.name));
    } catch {
      /* the ladder only affects the price labels */
    }
    await load();
    if (window.AdminShell && window.AdminShell.onChange) {
      window.AdminShell.onChange(() => load(true));
    }
    setInterval(() => load(true), 15000);
  })();
})();
