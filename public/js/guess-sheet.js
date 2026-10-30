/* Poll guess sheet — every participant's guess for ONE poll, who is missing, and the winners.
   This is the host's answer sheet: open it from Polls (👥 All guesses) or from History. */
(function () {
  'use strict';
  const { API, escapeHtml, toast, setBusy, plural } = window.App;

  let modal = null;   // the overlay element
  let sheet = null;   // the fetched guess-sheet data
  let pollId = null;
  let segFilter = 'all';
  let busy = false;

  /* ------------------------------- markup -------------------------------- */

  function build() {
    const wrap = document.createElement('div');
    wrap.id = 'guess-sheet';
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:9000;display:none;align-items:flex-end;justify-content:center;' +
      'background:rgba(3,8,20,.72);backdrop-filter:blur(3px)';
    wrap.innerHTML = `
      <div id="guess-sheet-panel" style="width:min(900px,100%);max-height:92vh;display:flex;flex-direction:column;
           background:var(--surface,#0d1b33);border:1px solid rgba(255,255,255,.12);border-radius:18px 18px 0 0;
           box-shadow:0 -20px 60px rgba(0,0,0,.6);overflow:hidden">
        <div style="padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;gap:12px;align-items:flex-start">
          <div style="flex:1;min-width:0">
            <div id="gs-eyebrow" style="font:700 11px/1 system-ui;letter-spacing:.12em;text-transform:uppercase;color:#8fa1bd">Bid round</div>
            <div id="gs-title" style="font:800 18px/1.3 system-ui;color:#fff;margin-top:6px">Loading…</div>
            <div id="gs-sub" style="font:500 13px/1.4 system-ui;color:#8fa1bd;margin-top:4px"></div>
          </div>
          <button id="gs-close" aria-label="Close" style="background:none;border:0;color:#8fa1bd;font:700 20px/1 system-ui;cursor:pointer;padding:4px 8px">✕</button>
        </div>

        <div id="gs-body" style="padding:16px 18px;overflow:auto;flex:1"></div>

        <div id="gs-foot" style="padding:14px 18px;border-top:1px solid rgba(255,255,255,.08);display:flex;gap:10px;flex-wrap:wrap;align-items:center"></div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close();
    });
    wrap.querySelector('#gs-close').addEventListener('click', close);
    return wrap;
  }

  function el() {
    if (!modal) modal = build();
    return modal;
  }

  /* ------------------------------ rendering ------------------------------ */

  function statBox(label, value, accent) {
    return `<div style="flex:1;min-width:120px;padding:12px 14px;border-radius:14px;
      background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)">
      <div style="font:800 22px/1 system-ui;color:${accent || '#fff'}">${value}</div>
      <div style="font:600 11px/1.4 system-ui;letter-spacing:.08em;text-transform:uppercase;color:#8fa1bd;margin-top:6px">${label}</div>
    </div>`;
  }

  function render() {
    const root = el();
    const body = root.querySelector('#gs-body');
    const foot = root.querySelector('#gs-foot');
    if (!pollId) return;

    if (busy || !sheet) {
      root.querySelector('#gs-title').textContent = 'Loading…';
      body.innerHTML = '';
      foot.innerHTML = '';
      return;
    }


    const p = sheet.poll;
    const people = sheet.participants || [];
    const guessed = people.filter((x) => x.hasGuessed);
    const missing = people.filter((x) => !x.hasGuessed);

    root.querySelector('#gs-eyebrow').textContent = `Poll #${p.id} · ${p.status.toUpperCase()}`;
    root.querySelector('#gs-title').textContent = p.question;
    root.querySelector('#gs-sub').innerHTML = p.playerName
      ? `Player: <strong style="color:#fff">${escapeHtml(p.playerName)}</strong> · sold: ${
          sheet.revealed ? `<strong style="color:#f6c453">${escapeHtml(p.actualLabel)}</strong>` : 'not entered yet'
        }`
      : '';

    /* --- header stats --- */
    let html = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
      ${statBox('Guessed', `${guessed.length} / ${people.length}`)}
      ${statBox('Still missing', String(missing.length), missing.length ? '#ffcf6b' : '#35d07f')}
      ${statBox('Sold price', sheet.revealed ? escapeHtml(p.actualLabel) : '—', '#f6c453')}
    </div>`;

    /* --- winners: exact bids only --- */
    if (sheet.revealed && sheet.winners && sheet.winners.length) {
      html += `<div style="margin-bottom:16px">
        <div style="font:700 11px/1 system-ui;letter-spacing:.12em;text-transform:uppercase;color:#8fa1bd;margin-bottom:8px">Right on the price</div>
        ${sheet.winners
          .map(
            (w) => `<div style="display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:12px;
              background:rgba(53,208,127,.08);border:1px solid rgba(53,208,127,.25);margin-bottom:6px">
              <span style="font:800 13px system-ui;color:#f6c453;min-width:26px">#${w.rank}</span>
              <span style="flex:1;font:700 14px system-ui;color:#fff">${escapeHtml(w.name)}</span>
              <span style="font:800 14px system-ui;color:#35d07f">${escapeHtml(w.guessLabel)}</span>
              <span style="font:600 12px system-ui;color:#8fa1bd">${escapeHtml(w.diffLabel)} ${escapeHtml(w.direction)}</span>
            </div>`
          )
          .join('')}
      </div>`;
    } else if (sheet.revealed) {
      const c = sheet.closest;
      html += `<div style="margin-bottom:16px;padding:10px 12px;border-radius:12px;
        background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);
        font:600 13px system-ui;color:#8fa1bd">
        No right bid on this player${
          c
            ? ` · closest was <strong style="color:#fff">${escapeHtml(c.name)}</strong> ${escapeHtml(
                c.guessLabel
              )} (${escapeHtml(c.diffLabel)} off)`
            : ''
        }
      </div>`;
    }

    /* --- filter --- */
    const chip = (key, label, count) =>
      `<button data-gs-filter="${key}" style="cursor:pointer;border-radius:999px;padding:7px 14px;
        font:700 12px system-ui;border:1px solid ${segFilter === key ? 'rgba(53,208,127,.6)' : 'rgba(255,255,255,.14)'};
        background:${segFilter === key ? 'rgba(53,208,127,.16)' : 'transparent'};
        color:${segFilter === key ? '#35d07f' : '#8fa1bd'}">${label} ${count}</button>`;

    html += `<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      ${chip('all', 'Everyone', people.length)}
      ${chip('guessed', 'Guessed', guessed.length)}
      ${chip('missing', 'Not yet', missing.length)}
    </div>`;

    /* --- table --- */
    const rows =
      segFilter === 'guessed' ? guessed : segFilter === 'missing' ? missing : people;

    html += `<div style="border:1px solid rgba(255,255,255,.08);border-radius:12px;overflow:hidden">
      <table style="width:100%;border-collapse:collapse;font:500 13px system-ui">
        <thead><tr style="background:rgba(255,255,255,.04);text-align:left">
          <th style="padding:10px;color:#8fa1bd;font-weight:700">#</th>
          <th style="padding:10px;color:#8fa1bd;font-weight:700">Participant</th>
          <th style="padding:10px;color:#8fa1bd;font-weight:700">Employee ID</th>
          <th style="padding:10px;color:#8fa1bd;font-weight:700;text-align:right">Guess</th>
          <th style="padding:10px;color:#8fa1bd;font-weight:700;text-align:right">Off by</th>
        </tr></thead>
        <tbody>
        ${
          rows.length
            ? rows
                .map((r) => {
                  const win = r.isWinner;
                  const dim = !r.hasGuessed;
                  return `<tr style="border-top:1px solid rgba(255,255,255,.06);${win ? 'background:rgba(246,196,83,.08)' : ''}">
                    <td style="padding:10px;color:${win ? '#f6c453' : '#8fa1bd'};font-weight:800">${
                      r.rank ? '#' + r.rank : '—'
                    }</td>
                    <td style="padding:10px;font-weight:700;color:${dim ? '#6f819c' : '#fff'}">${escapeHtml(r.name)}</td>
                    <td style="padding:10px;color:#8fa1bd">${escapeHtml(r.employeeId || '—')}</td>
                    <td style="padding:10px;text-align:right;font-weight:800;color:${dim ? '#6f819c' : win ? '#f6c453' : '#35d07f'}">
                      ${r.hasGuessed ? escapeHtml(r.guessLabel) : 'no guess'}
                    </td>
                    <td style="padding:10px;text-align:right;color:#8fa1bd">
                      ${r.diffLabel ? escapeHtml(r.diffLabel) + ' ' + escapeHtml(r.direction) : '—'}
                    </td>
                  </tr>`;
                })
                .join('')
            : `<tr><td colspan="5" style="padding:18px;color:#8fa1bd">Nobody in this filter yet.</td></tr>`
        }
        </tbody>
      </table>
    </div>`;

    body.innerHTML = html;
    body.querySelectorAll('[data-gs-filter]').forEach((b) =>
      b.addEventListener('click', () => {
        segFilter = b.dataset.gsFilter;
        render();
      })
    );

    /* --- footer: sold price + export --- */
    foot.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:1">
        <input id="gs-price" class="input" style="width:130px" placeholder="Sold price"
               value="${sheet.revealed ? escapeHtml(p.actualLabel) : ''}" aria-label="Sold price" />
        <button class="btn btn-primary btn-sm" id="gs-save-price">
          ${sheet.revealed ? 'Update price' : 'Save price & declare winners'}
        </button>
        ${
          sheet.revealed
            ? `<button class="btn btn-ghost btn-sm" id="gs-clear-price">Clear price</button>`
            : ''
        }
      </div>
      <a class="btn btn-ghost btn-sm" href="/api/admin/export/poll/${p.id}.csv" download>⬇ CSV</a>
      <a class="btn btn-ghost btn-sm" href="/display" target="_blank" rel="noopener">🖥 Projector</a>`;

    foot.querySelector('#gs-save-price').addEventListener('click', savePrice);
    const clearBtn = foot.querySelector('#gs-clear-price');
    if (clearBtn) clearBtn.addEventListener('click', clearPrice);
    foot.querySelector('#gs-price').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') savePrice();
    });
  }

  /* ------------------------------- actions ------------------------------- */

  function setBusyState(v) {
    busy = v;
    render();
  }

  async function savePrice() {
    const input = el().querySelector('#gs-price');
    const raw = String(input.value || '').trim();
    if (!raw) return toast('Type the price the player actually sold for', 'err');

    setBusyState(true);
    try {
      const res = await API.post(`/api/admin/polls/${pollId}/actual`, { price: raw });
      const winners = (res.winners || []).length;
      toast(
        `Sold price saved — ${res.actualLabel || raw}. ${
          winners ? `${winners} right bid${winners > 1 ? 's' : ''}.` : 'No right bid on this one.'
        }`,
        'ok'
      );
      await load(pollId);
      window.App.confetti && window.App.confetti({ count: 40 });
    } catch (err) {
      toast(err.message, 'err');
      setBusyState(false);
    }
  }

  async function clearPrice() {
    setBusyState(true);
    try {
      await API.del(`/api/admin/polls/${pollId}/actual`);
      toast('Sold price cleared', 'ok');
      await load(pollId);
    } catch (err) {
      toast(err.message, 'err');
      setBusyState(false);
    }
  }

  async function load(id) {
    pollId = id;
    render();
    try {
      sheet = await API.get(`/api/admin/polls/${id}/guesses`);
    } catch (err) {
      sheet = null;
      toast(err.message, 'err');
    }
    busy = false;
    render();
  }

  function open(id) {
    segFilter = 'all';
    sheet = null;
    el().style.display = 'flex';
    document.body.style.overflow = 'hidden';
    load(id);
  }

  function close() {
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
    pollId = null;
  }

  /* Keep an open sheet live while the room is guessing. AdminShell loads after this file,
     so subscribe once it is ready. */
  function subscribe() {
    if (!window.AdminShell || !window.AdminShell.onChange) return;
    window.AdminShell.onChange(() => {
      if (pollId && modal && modal.style.display !== 'none' && !busy) load(pollId);
    });
  }
  if (window.AdminShell) subscribe();
  else document.addEventListener('DOMContentLoaded', subscribe);
  window.addEventListener('load', subscribe);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.style.display !== 'none') close();
  });

  window.PollGuessSheet = { open, close };
})();
