/* Shared admin shell: auth guard, navigation, real-time admin state */
(function () {
  'use strict';
  const { API, toast } = window.App;

  const listeners = new Set();
  let adminState = null;
  let me = null;
  let realtime = null;

  function redirectToLogin() {
    const next = encodeURIComponent(location.pathname + location.search);
    window.location.replace(`/admin-login?next=${next}`);
  }

  async function guard() {
    try {
      const res = await API.get('/api/admin/me');
      me = res.admin;
      return res;
    } catch (err) {
      if (err.status === 401) {
        redirectToLogin();
        return null;
      }
      throw err;
    }
  }

  function paintAdminName() {
    document.querySelectorAll('[data-admin-name]').forEach((el) => {
      el.textContent = me ? me.displayName || me.username : '';
    });
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
      if (err.status === 401) redirectToLogin();
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
        if (err && err.status === 401) redirectToLogin();
      }
    });
  }

  async function boot() {
    const res = await guard();
    if (!res) return;
    paintAdminName();
    markActiveNav();
    wireLogout();
    await loadState();
    connect();
    if (res.defaultPasswordInUse) {
      const banner = document.getElementById('password-banner');
      if (banner) banner.classList.remove('hidden');
    }
  }

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
