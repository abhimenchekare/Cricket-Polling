/* Shared helpers for all pages: API wrapper, toasts, modals, confetti, sockets. */
(function () {
  'use strict';

  /* ------------------------------- API ---------------------------------- */

  async function request(method, url, body) {
    const options = {
      method,
      headers: { Accept: 'application/json' },
      credentials: 'same-origin'
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    // Admin calls always carry the token header when we have one. If the browser dropped
    // the cookie (proxy, webview, privacy mode) the header keeps the panel signed in.
    if (url.startsWith('/api/admin') || url.startsWith('/api/vote') || url.startsWith('/api/state')) {
      const token = getAdminToken();
      if (token && !options.headers['x-admin-token']) options.headers['x-admin-token'] = token;
    }
    const res = await fetch(url, options);
    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      // Any 401 means the session may be gone. Panels listen for this instead of each
      // caller guessing — one lost request must never strand a half-finished admin action.
      if (res.status === 401 && !/\/api\/(admin\/)?login$/.test(url)) {
        try {
          window.dispatchEvent(new CustomEvent('app:unauthorized', { detail: { url } }));
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
    return data;
  }

  /* ---- admin token (belt and braces with the cookie) ---- */
  const TOKEN_KEY = 'cp_admin_token';
  function getAdminToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return '';
    }
  }
  function clearAdminToken() {
    setAdminToken('');
  }
  function setAdminToken(token) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage blocked: cookie auth still works */
    }
  }

  const API = {
    getAdminToken,
    setAdminToken,
    clearAdminToken,
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body || {}),
    put: (url, body) => request('PUT', url, body || {}),
    patch: (url, body) => request('PATCH', url, body || {}),
    del: (url) => request('DELETE', url)
  };

  /* ------------------------------ toasts -------------------------------- */

  function toastHost() {
    let host = document.querySelector('.toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host';
      document.body.appendChild(host);
    }
    return host;
  }

  function toast(message, type = 'info', ms = 3200) {
    const host = toastHost();
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const icon = type === 'ok' ? '✅' : type === 'err' ? '⚠️' : 'ℹ️';
    el.innerHTML = `<span aria-hidden="true">${icon}</span><span class="grow"></span>`;
    el.lastElementChild.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 240);
    }, ms);
  }

  /* ------------------------------ modals -------------------------------- */

  function confirmDialog({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', danger = false, requireText = null }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-title"></div>
          <div class="modal-body"></div>
          ${requireText ? `<input class="input" id="confirm-input" placeholder="${requireText.placeholder || ''}" autocomplete="off" />` : ''}
          <div class="modal-actions" style="margin-top:16px">
            <button class="btn btn-ghost" data-act="cancel"></button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok"></button>
          </div>
        </div>`;
      backdrop.querySelector('.modal-title').textContent = title;
      backdrop.querySelector('.modal-body').innerHTML = message;
      backdrop.querySelector('[data-act="cancel"]').textContent = cancelText;
      const okBtn = backdrop.querySelector('[data-act="ok"]');
      okBtn.textContent = confirmText;
      if (requireText) {
        okBtn.disabled = true;
        const input = backdrop.querySelector('#confirm-input');
        input.addEventListener('input', () => {
          okBtn.disabled = input.value.trim().toUpperCase() !== String(requireText.expect || '').toUpperCase();
        });
        setTimeout(() => input.focus(), 60);
      }

      function close(result) {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') close(false);
      }
      backdrop.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]');
        if (act) close(act.dataset.act === 'ok');
        else if (e.target === backdrop) close(false);
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(backdrop);
    });
  }

  /* ------------------------------ confetti ------------------------------ */

  function confetti(duration = 2200) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let canvas = document.getElementById('confetti-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'confetti-canvas';
      document.body.appendChild(canvas);
    }
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    const colors = ['#17d97f', '#3ff09a', '#f7c948', '#ffdb70', '#4ea8ff', '#ffffff'];
    const count = window.innerWidth < 520 ? 90 : 160;
    const pieces = Array.from({ length: count }, () => ({
      x: Math.random() * window.innerWidth,
      y: -20 - Math.random() * window.innerHeight * 0.5,
      w: 5 + Math.random() * 7,
      h: 8 + Math.random() * 10,
      vx: (Math.random() - 0.5) * 2.4,
      vy: 2.2 + Math.random() * 3.6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.22,
      color: colors[(Math.random() * colors.length) | 0]
    }));

    const start = performance.now();
    function frame(now) {
      const elapsed = now - start;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      for (const p of pieces) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.035;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = elapsed > duration - 500 ? Math.max(0, (duration - elapsed) / 500) : 1;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (elapsed < duration) {
        requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        canvas.remove();
        window.removeEventListener('resize', resize);
      }
    }
    requestAnimationFrame(frame);
  }


  /* ── bid round results, rendered compactly for history / reports ── */
  function bidResultRows(results) {
    if (!results || results.kind !== 'bid') return '';
    const medal = ['🥇', '🥈', '🥉'];
    if (!results.winners || !results.winners.length) {
      return `<div class="mute-sm" style="padding:6px 2px">${
        results.actualLakh ? 'Nobody guessed this round' : 'Waiting for the sold price'
      }</div>`;
    }
    return results.winners
      .map(
        (w) => `
      <div class="bid-winner rank-${w.rank}">
        <span class="bid-medal">${medal[w.rank - 1] || '#' + w.rank}</span>
        <div class="grow">
          <div class="bid-winner-name">${escapeHtml(w.name)}</div>
          <div class="mute-sm">${escapeHtml(w.guessLabel)} · ${escapeHtml(w.diffLabel)} ${
            w.direction === 'exact' ? 'exact!' : w.direction
          }</div>
        </div>
      </div>`
      )
      .join('');
  }


  /* ── "a newer version was deployed" watcher ──
     Prevents the classic "I deployed but my browser still shows the old site":
     compare the build id served by /api/health with the one we loaded with. */
  let loadedBuild = null;

  async function currentBuild() {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const data = await res.json();
      return data && data.build ? String(data.build) : null;
    } catch {
      return null;
    }
  }

  async function watchForNewBuild({ intervalMs = 60000, onNewBuild } = {}) {
    loadedBuild = loadedBuild || (await currentBuild());
    if (!loadedBuild) return;
    setInterval(async () => {
      const now = await currentBuild();
      if (!now || now === loadedBuild) return;
      // A first deploy has no commit suffix ("2.2.1+local" → "2.2.1+abc1234"): compare the
      // version part only, so local/CLI builds don't false-alarm.
      if (now.split('+')[0] === loadedBuild.split('+')[0]) return;
      if (onNewBuild) onNewBuild(now);
      else showUpdateBanner(now);
    }, intervalMs);
  }

  function showUpdateBanner(build) {
    if (document.getElementById('new-build-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'new-build-banner';
    bar.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:99999;display:flex;' +
      'gap:12px;align-items:center;padding:12px 16px;border-radius:14px;background:#0d1b33;color:#fff;' +
      'border:1px solid rgba(53,208,127,.5);box-shadow:0 14px 40px rgba(0,0,0,.5);' +
      'font:600 14px/1.35 system-ui,sans-serif;max-width:92vw';
    bar.innerHTML =
      `<span>A newer version (${String(build).split('+')[0]}) is deployed.</span>` +
      '<button id="new-build-reload" style="cursor:pointer;border:0;border-radius:999px;padding:8px 16px;' +
      'background:#35d07f;color:#06121f;font:800 13px system-ui,sans-serif">Reload</button>' +
      '<button id="new-build-later" aria-label="Dismiss" style="cursor:pointer;border:0;background:none;' +
      'color:#8fa1bd;font:600 13px system-ui,sans-serif">later</button>';
    document.body.appendChild(bar);
    bar.querySelector('#new-build-reload').addEventListener('click', () => location.reload());
    bar.querySelector('#new-build-later').addEventListener('click', () => bar.remove());
  }

  /* ------------------------------ formatting ---------------------------- */

  function plural(n, one, many) {
    return Number(n) === 1 ? one : many;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    // Short rounds (10-15 s guessing rounds) read best as plain seconds.
    if (total < 60) return `${total}s`;
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${pad(m)}:${pad(s)}`;
  }

  function timeAgo(ts) {
    if (!ts) return '—';
    const diff = Date.now() - ts;
    if (diff < 45_000) return 'just now';
    const mins = Math.round(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function formatDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }

  function statusPill(status) {
    const map = {
      active: ['pill-live', '<span class="dot"></span>LIVE'],
      paused: ['pill-paused', 'PAUSED'],
      closed: ['pill-closed', 'CLOSED'],
      draft: ['pill-draft', 'DRAFT']
    };
    const [cls, label] = map[status] || ['pill-draft', String(status || '').toUpperCase()];
    return `<span class="pill ${cls}">${label}</span>`;
  }

  function haptic(ms = 12) {
    // Phones ignore vibrate() until the page has been touched at least once; asking earlier
    // only produces a console warning, so wait for real user activation.
    const active = navigator.userActivation ? navigator.userActivation.hasBeenActive : true;
    if (!active || !navigator.vibrate) return;
    try {
      navigator.vibrate(ms);
    } catch {
      /* ignore */
    }
  }

  function debounce(fn, wait = 250) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function setBusy(btn, busy, busyText = 'Working…') {
    if (!btn) return;
    if (busy) {
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span><span>${busyText}</span>`;
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    }
  }

  /* ------------------------------ realtime -------------------------------
     This app is hosted on Vercel (serverless), so there is no WebSocket.
     Instead every screen polls a tiny JSON endpoint. The interval adapts to
     what is happening: fast while a poll is live, slow when idle, paused when
     the tab is hidden. A version fingerprint skips redundant re-renders.
  ---------------------------------------------------------------------- */

  /**
   * Live channel. Tries Server-Sent Events first: the server pushes the new state the moment
   * anything changes, so an admin action lands on every phone in well under a second.
   * If the stream cannot be opened (old browser, proxy, flaky network) it falls back to the
   * adaptive poller silently — the caller cannot tell the difference.
   */
  function createLiveChannel(options) {
    const {
      url = '/api/state',
      streamUrl = '/api/stream',
      onData,
      onStatus,
      onError,
      activeInterval,
      idleInterval,
      immediate = true,
      allowStream = true
    } = options;

    let source = null;
    let fallback = null;
    let stopped = false;
    let gotFirstPayload = false;
    let errorStreak = 0;

    // visible to tests and to anyone debugging: "stream" or "polling"
    const setMode = (m) => {
      window.__liveMode = m;
    };
    setMode('stream');

    const startFallback = (why) => {
      if (stopped || fallback) return;
      if (source) {
        try {
          source.close();
        } catch {
          /* ignore */
        }
        source = null;
      }
      if (why && typeof console !== 'undefined') console.info(`[live] polling instead of stream (${why})`);
      setMode('polling');
      fallback = createRealtime({
        url,
        onData,
        onStatus,
        onError,
        activeInterval,
        idleInterval,
        immediate
      });
    };

    if (!allowStream || typeof window.EventSource !== 'function') {
      startFallback('no EventSource');
      return {
        poke: () => fallback && fallback.poke(),
        stop: () => {
          stopped = true;
          fallback && fallback.stop();
        },
        forceRenderNext: () => fallback && fallback.forceRenderNext(),
        get mode() {
          return 'polling';
        }
      };
    }

    const connect = () => {
      if (stopped) return;
      try {
        source = new EventSource(streamUrl);
      } catch (err) {
        startFallback(err && err.message);
        return;
      }

      source.addEventListener('state', (event) => {
        errorStreak = 0;
        gotFirstPayload = true;
        setMode('stream');
        let data = null;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        onStatus && onStatus('online');
        onData && onData(data);
      });

      source.addEventListener('bye', () => {
        // server ends the stream on purpose every ~45 s; EventSource reconnects by itself
        if (source) {
          try {
            source.close();
          } catch {
            /* ignore */
          }
          source = null;
        }
        setTimeout(connect, 60);
      });

      source.onerror = () => {
        errorStreak += 1;
        // One hiccup is normal (reconnect); a run of them means the stream is blocked here.
        if (!gotFirstPayload || errorStreak >= 3) startFallback(`EventSource error ×${errorStreak}`);
      };
    };

    connect();

    // A hidden tab holds its stream open (cheap); coming back should still be instant.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && fallback) fallback.poke();
    });

    return {
      poke: () => fallback && fallback.poke(),
      stop() {
        stopped = true;
        if (source) {
          try {
            source.close();
          } catch {
            /* ignore */
          }
          source = null;
        }
        fallback && fallback.stop();
      },
      forceRenderNext: () => fallback && fallback.forceRenderNext(),
      get mode() {
        return fallback ? 'polling' : 'stream';
      }
    };
  }

  function createRealtime(options) {
    const {
      url,
      onData,
      onStatus,
      onError,
      activeInterval = 1200, // a poll is live — short enough to feel instant
      idleInterval = 3000, // nothing happening
      hiddenMultiplier = 4,
      immediate = true
    } = options;

    let timer = null;
    let stopped = false;
    let inFlight = false;
    let lastVersion = null;
    let failures = 0;
    let paused = document.hidden;
    let forceNext = true;

    function intervalFor(data) {
      const live = data && data.poll && (data.poll.status === 'active' || data.poll.status === 'paused');
      let base = live ? activeInterval : idleInterval;
      if (failures > 0) base = Math.min(base * 2 ** failures, 15000);
      if (paused) base *= hiddenMultiplier;
      // ±15% jitter so dozens of phones never hit the server in the same instant
      return Math.round(base * (0.85 + Math.random() * 0.3));
    }

    function schedule(data) {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(poll, intervalFor(data));
    }

    async function poll() {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const data = await API.get(url);
        failures = 0;
        onStatus && onStatus('online');
        const version = data && data.version ? data.version : null;
        if (forceNext || version === null || version !== lastVersion) {
          forceNext = false;
          lastVersion = version;
          onData && onData(data);
        }
        inFlight = false;
        schedule(data);
      } catch (err) {
        inFlight = false;
        failures = Math.min(failures + 1, 4);
        onStatus && onStatus('offline');
        onError && onError(err);
        schedule(null);
      }
    }

    function poke() {
      forceNext = true;
      failures = 0;
      clearTimeout(timer);
      poll();
    }

    document.addEventListener('visibilitychange', () => {
      paused = document.hidden;
      if (!paused) poke();
      else schedule(null);
    });

    window.addEventListener('online', poke);

    if (immediate) poll();
    else schedule(null);

    return {
      poke,
      stop() {
        stopped = true;
        clearTimeout(timer);
      },
      forceRenderNext() {
        forceNext = true;
      }
    };
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to the legacy path */
    }
    try {
      const input = document.createElement('textarea');
      input.value = text;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      const ok = document.execCommand('copy');
      input.remove();
      return ok;
    } catch {
      return false;
    }
  }

  window.App = {
    API,
    toast,
    confirmDialog,
    confetti,
    formatClock,
    timeAgo,
    formatDate,
    escapeHtml,
    statusPill,
    haptic,
    debounce,
    setBusy,
    createRealtime,
    createLiveChannel,
    copyText,
    plural,
    currentBuild,
    watchForNewBuild,
    showUpdateBanner,
    bidResultRows,
    getAdminToken,
    setAdminToken,
    clearAdminToken
  };
})();
