/* Shared admin shell: auth guard, navigation, real-time admin state */
(function () {
  'use strict';
  const { API, toast } = window.App;

  const listeners = new Set();
  let adminState = null;
  let me = null;
  let realtime = null;

  let redirecting = false;
  let checking = false;
  function redirectToLogin() {
    if (redirecting) return;
    redirecting = true;
    const next = encodeURIComponent(location.pathname + location.search);
    window.location.replace(`/admin-login?next=${next}&expired=1`);
  }

  /* A "session expired" banner instead of a hard redirect. Losing an in-progress admin
     action because of one flaky request is worse than showing a re-login prompt. */
  function showExpiredBanner() {
    if (document.getElementById('session-expired')) return;
    const bar = document.createElement('div');
    bar.id = 'session-expired';
    bar.style.cssText =
      'position:sticky;top:0;z-index:9999;display:flex;gap:10px;align-items:center;justify-content:center;' +
      'flex-wrap:wrap;padding:10px 14px;background:#7a1020;color:#fff;font:600 14px/1.4 system-ui,sans-serif;' +
      'box-shadow:0 6px 18px rgba(0,0,0,.35)';
    bar.innerHTML =
      '<span>Your admin session ended (or the database was waking up). Nothing was lost.</span>' +
      '<button id="session-retry" style="cursor:pointer;border:0;border-radius:999px;padding:8px 16px;' +
      'background:#ffd166;color:#10182e;font:700 13px system-ui,sans-serif">Reconnect</button>' +
      '<a href="/admin-login" style="color:#ffd166;font-weight:700">Sign in again</a>';
    document.body.prepend(bar);
    bar.querySelector('#session-retry').addEventListener('click', async () => {
      bar.remove();
      const res = await guard({ silent: true });
      if (res) {
        loadState();
        if (realtime) realtime.poke();
      }
    });
  }

  /**
   * Confirm we are signed in. Never logs out on a transient failure:
   *  - 401 twice  -> session really is gone: prompt (or redirect on first load)
   *  - 503/network -> database waking up / offline: retry, keep the page alive
   */
  async function guard({ silent = false, allowRedirect = true } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await API.get('/api/admin/me');
        me = res.admin;
        const bar = document.getElementById('session-expired');
        if (bar) bar.remove();
        return res;
      } catch (err) {
        lastErr = err;
        if (err.status === 401) {
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 700));
            continue;
          }
          if (allowRedirect) redirectToLogin();
          else showExpiredBanner();
          return null;
        }
        // 503 / network / timeout: wait and retry — do NOT sign the admin out
        await new Promise((r) => setTimeout(r, 800 + attempt * 700));
      }
    }
    if (!silent) showExpiredBanner();
    return null;
  }

  function paintAdminName() {
    document.querySelectorAll('[data-admin-name]').forEach((el) => {
      el.textContent = me ? me.displayName || me.username : '';
    });
  }

  async function paintBuild() {
    try {
      const h = await API.get('/api/health');
      window.App.watchForNewBuild({ intervalMs: 60000 });
      document.querySelectorAll('[data-build]').forEach((el) => {
        el.textContent = `build ${h.build || '?'}${h.features && h.features.adminTokenHeader ? ' · token-auth' : ''}`;
        el.title = 'If this does not match the version you just deployed, the deployment is stale.';
      });
    } catch {
      /* non-fatal */
    }
  }

  function markActiveNav() {
    const path = location.pathname.replace(/\/$/, '') || '/admin';
    document.querySelectorAll('[data-nav]').forEach((el) => {
      const href = el.getAttribute('href');
      el.classList.toggle('active', href === path);
    });
  }

  function wireLogout() {
    document.querySelectorAll('[data-logout]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await window.App.confirmDialog({
          title: 'Sign out of admin?',
          message: 'Polling keeps running. Participants are not affected.',
          confirmText: 'Sign out',
          danger: true
        });
        if (!ok) return;
        try {
          await API.post('/api/admin/logout');
        } catch {
          /* ignore */
        }
        window.App.clearAdminToken();
        window.location.href = '/admin-login';
      });
    });
  }

  function emit() {
    listeners.forEach((cb) => {
      try {
        cb(adminState);
      } catch (err) {
        console.error(err);
      }
    });
  }

  async function loadState() {
    try {
      adminState = await API.get('/api/admin/state');
      paintEvent(adminState.settings);
      emit();
    } catch (err) {
      // Background refresh failed: 401 -> prompt re-login instead of nuking the page.
      if (err.status === 401) showExpiredBanner();
    }
  }

  function paintEvent(settings) {
    if (!settings) return;
    document.querySelectorAll('[data-event-name]').forEach((el) => {
      el.textContent = settings.event_name || 'Cricket Auction Live Polls';
    });
    document.querySelectorAll('[data-event-tagline]').forEach((el) => {
      el.textContent = settings.event_tagline || '';
    });
  }

  function setConn(online) {
    const dot = document.getElementById('admin-conn');
    if (!dot) return;
    dot.innerHTML = online
      ? '<span class="pill pill-green-soft">● Live</span>'
      : '<span class="pill pill-ghost">● Reconnecting…</span>';
  }

  function connect() {
    realtime = window.App.createRealtime({
      url: '/api/admin/state',
      activeInterval: 3000,
      idleInterval: 6000, // admin panel: always reasonably fresh
      onData: (payload) => {
        setConn(true);
        adminState = payload;
        paintEvent(payload.settings);
        emit();
      },
      onStatus: setConn,
      onError: (err) => {
        setConn(false);
        if (err && err.status === 401) showExpiredBanner();
        // 503 / offline: createRealtime keeps polling; the banner only appears if it never recovers.
      }
    });
  }

  /* A single 401 anywhere in the panel triggers one verification attempt (not a logout). */
  window.addEventListener('app:unauthorized', () => {
    if (checking) return;
    checking = true;
    setTimeout(async () => {
      checking = false;
      if (document.getElementById('session-expired')) return;
      await guard({ silent: true, allowRedirect: false });
    }, 400);
  });

  async function boot() {
    const res = await guard({ allowRedirect: true });
    if (!res) return;
    paintAdminName();
    paintBuild();
    markActiveNav();
    wireLogout();
    await loadState();
    connect();
    if (res.defaultPasswordInUse) {
      const banner = document.getElementById('password-banner');
      if (banner) banner.classList.remove('hidden');
    }
  }

  /* Password change wipes old sessions; adopt the fresh token so we don't self-logout. */
  window.addEventListener('app:new-admin-token', (e) => {
    if (e.detail && e.detail.token) {
      window.App.setAdminToken(e.detail.token);
      me = me || {};
    }
  });

  window.AdminShell = {
    boot,
    ready: null,
    onChange(cb) {
      listeners.add(cb);
      if (adminState) cb(adminState);
      return () => listeners.delete(cb);
    },
    get state() {
      return adminState;
    },
    get admin() {
      return me;
    },
    refresh: () => {
      loadState();
      if (realtime) realtime.poke();
    },
    poke: () => realtime && realtime.poke(),
    toast
  };

  // Page scripts can await window.AdminShell.ready
  window.AdminShell.ready = boot();
})();
