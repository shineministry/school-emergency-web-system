const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem('se_token') || null,
  user: null,
  currentAlert: null,
  sirenOn: false,
  vibTimer: null,
  es: null,
  swReg: null
};

const ICONS = { fire: '🔥', evacuation: '🏃', lockdown: '🔒', medical: '🚑', danger: '⚠️', drill: '📋' };

async function api(path, options = {}) {
  const opts = Object.assign({ headers: {} }, options);
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
  if (state.token) opts.headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('Request failed (' + res.status + ')'));
  return body;
}

function showView(id) {
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== id;
}

const OVERLAYS = ['emergency-view', 'safe-view', 'clear-view'];

function openOverlay(id) {
  for (const o of OVERLAYS) $(o).hidden = o !== id;
}

function closeOverlay() {
  for (const o of OVERLAYS) $(o).hidden = true;
}

function authError(msg) {
  const el = $('auth-error');
  el.textContent = msg;
  el.hidden = !msg;
}

/* ---------------- Auth ---------------- */

$('tab-login').addEventListener('click', () => setTab('login'));
$('tab-register').addEventListener('click', () => setTab('register'));

function setTab(tab) {
  $('tab-login').classList.toggle('active', tab === 'login');
  $('tab-register').classList.toggle('active', tab === 'register');
  $('login-form').hidden = tab !== 'login';
  $('register-form').hidden = tab !== 'register';
  authError('');
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  authError('');
  try {
    const body = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('login-email').value, password: $('login-password').value })
    });
    await adoptSession(body);
  } catch (err) {
    authError(err.message);
  }
});

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  authError('');
  try {
    const body = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        schoolId: $('reg-school').value,
        name: $('reg-name').value,
        group: $('reg-group').value || 'students',
        email: $('reg-email').value,
        password: $('reg-password').value
      })
    });
    await adoptSession(body);
  } catch (err) {
    authError(err.message);
  }
});

async function adoptSession(body) {
  unlockAudio();
  state.token = body.token;
  state.user = body.user;
  localStorage.setItem('se_token', state.token);
  persistUser();
  await cacheTokenForSW(state.token);
  startApp();
}

function persistUser() {
  try {
    localStorage.setItem('se_user', JSON.stringify(state.user));
  } catch (_) {}
}

function sessionExpired() {
  localStorage.removeItem('se_token');
  localStorage.removeItem('se_user');
  state.token = null;
  state.user = null;
  if (state.es) state.es.close();
  showView('auth-view');
  loadSchools().catch(() => {});
}

$('logout-btn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  localStorage.removeItem('se_token');
  localStorage.removeItem('se_user');
  state.token = null;
  state.user = null;
  if (state.es) state.es.close();
  if (state.swReg) {
    try { await navigator.serviceWorker.ready.then((r) => r.active && r.active.postMessage({ type: 'clear-alerts' })); } catch (_) {}
  }
  stopSiren();
  stopVibration();
  closeOverlay();
  showView('auth-view');
});

async function loadSchools() {
  const res = await api('/api/auth/schools');
  $('reg-school').innerHTML = res.schools.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- Session bootstrap ---------------- */

async function init() {
  if ('serviceWorker' in navigator) {
    state.swReg = await navigator.serviceWorker.register('../sw.js');
    navigator.serviceWorker.addEventListener('message', onSWMessage);
  }

  if (!state.token) {
    showView('auth-view');
    loadSchools().catch(() => {});
    return;
  }

  const cachedUser = localStorage.getItem('se_user');
  if (cachedUser) {
    try { state.user = JSON.parse(cachedUser); } catch (_) { state.user = null; }
  }

  if (state.user) {
    startApp().catch(() => {});
    try {
      const res = await api('/api/auth/me');
      state.user = res.user;
      persistUser();
      $('school-name').textContent = state.user.school || '';
      $('user-name').textContent = state.user.name;
      await cacheTokenForSW(state.token);
    } catch (_) {
      sessionExpired();
    }
  } else {
    try {
      const res = await api('/api/auth/me');
      state.user = res.user;
      persistUser();
      await cacheTokenForSW(state.token);
      await startApp();
    } catch (_) {
      sessionExpired();
    }
  }
}

function onSWMessage(event) {
  const msg = event.data || {};
  if (msg.type === 'safe-done' && state.currentAlert && Number(state.currentAlert.alertId) === Number(msg.alertId)) {
    showSafe({ id: msg.alertId, title: state.currentAlert.title });
  }
}

async function cacheTokenForSW(token) {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('auth');
    await cache.put('/token', new Response(token));
  } catch (_) {}
}

async function startApp() {
  $('school-name').textContent = state.user.school || '';
  $('user-name').textContent = state.user.name;
  showView('app-view');

  connectStream();
  await ensurePush();
  await checkActiveAlerts();
}

/* ---------------- Push ---------------- */

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function ensurePush() {
  const banner = $('push-banner');
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    banner.hidden = false;
    $('enable-push').textContent = 'Not supported on this browser';
    $('enable-push').disabled = true;
    return;
  }
  if (Notification.permission === 'granted') {
    banner.hidden = true;
    await subscribeDevice();
    return;
  }
  banner.hidden = false;
  $('enable-push').disabled = false;
  $('enable-push').textContent = 'Enable notifications';
}

$('enable-push').addEventListener('click', async () => {
  try {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      await subscribeDevice();
      $('push-banner').hidden = true;
    }
  } catch (err) {
    console.error(err);
  }
});

async function subscribeDevice() {
  if (!state.swReg) state.swReg = await navigator.serviceWorker.register('../sw.js');
  const keyRes = await api('/api/push/public-key');
  let sub = await state.swReg.pushManager.getSubscription();
  if (!sub) {
    sub = await state.swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyRes.publicKey)
    });
  }
  await api('/api/alerts/devices', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
}

/* ---------------- Live stream ---------------- */

function connectStream() {
  if (state.es) state.es.close();
  const es = new EventSource('/api/alerts/stream?token=' + encodeURIComponent(state.token));
  state.es = es;

  es.addEventListener('alert', (e) => {
    const data = JSON.parse(e.data);
    if (document.hidden && state.swReg) {
      const payload = Object.assign({}, data, { school: (state.user && state.user.school) || data.school });
      try { state.swReg.active && state.swReg.active.postMessage({ type: 'show-local', payload: payload }); } catch (_) {}
    }
    if (state.currentAlert && state.currentAlert.alertId === data.alertId) return;
    showEmergency(data, { alreadyAcked: false });
  });

  es.addEventListener('all_clear', (e) => {
    const data = JSON.parse(e.data);
    if (state.swReg) {
      try { state.swReg.active && state.swReg.active.postMessage({ type: 'clear-alerts' }); } catch (_) {}
    }
    handleAllClear(data);
  });
}

/* ---------------- Alerts ---------------- */

async function checkActiveAlerts() {
  const params = new URLSearchParams(location.search);
  const wanted = params.get('alert');
  try {
    const res = await api('/api/alerts/active');
    if (!res.alerts.length) return;
    const alert = wanted ? res.alerts.find((a) => String(a.id) === wanted) : null;
    const chosen = alert || res.alerts[0];
    if (chosen.my_state === 'safe') {
      showSafe(chosen);
      return;
    }
    showEmergency(
      {
        alertId: chosen.id,
        type: chosen.type,
        title: chosen.title,
        message: chosen.message,
        drill: !!chosen.drill
      },
      { alreadyAcked: chosen.my_state === 'notified' }
    );
  } catch (_) {}
}

async function showEmergency(data, opts) {
  state.currentAlert = data;
  $('emergency-icon').textContent = ICONS[data.type] || '🚨';
  $('emergency-title').textContent = data.title;
  renderBody($('emergency-message'), data.message);
  $('drill-badge').hidden = !data.drill;
  $('emergency-time').textContent = 'Reported ' + new Date().toLocaleString();
  $('emergency-school').textContent = (state.user && state.user.school) || '';
  $('safe-btn').dataset.alertId = data.alertId;

  openOverlay('emergency-view');
  startSiren();
  startVibration();

  if (!opts || !opts.alreadyAcked) {
    api('/api/alerts/' + data.alertId + '/ack', { method: 'POST' }).catch(() => {});
  }
}

function renderBody(el, text) {
  el.innerHTML = String(text || '')
    .split(/\n+/)
    .filter((line) => line.trim())
    .map((line) => '<p>' + escapeHtml(line.trim()) + '</p>')
    .join('');
}

$('alarm-btn').addEventListener('click', () => startSiren(true));

$('safe-btn').addEventListener('click', async () => {
  const id = $('safe-btn').dataset.alertId;
  try {
    await api('/api/alerts/' + id + '/safe', { method: 'POST' });
    showSafe({ id, title: state.currentAlert.title });
  } catch (err) {
    alert(err.message);
  }
});

function showSafe(alert) {
  stopSiren();
  stopVibration();
  state.currentAlert = null;
  $('safe-detail').textContent = (alert.title || 'The alert') + ' — the school has been notified that you are safe.';
  openOverlay('safe-view');
}

$('safe-back').addEventListener('click', () => {
  stopSiren();
  stopVibration();
  state.currentAlert = null;
  closeOverlay();
});

$('clear-back').addEventListener('click', () => {
  stopSiren();
  stopVibration();
  state.currentAlert = null;
  closeOverlay();
  $('status-card').className = 'status-card calm';
  $('status-icon').textContent = '🟢';
  $('status-title').textContent = 'No active emergency';
  $('status-text').textContent = 'You are registered and will be alerted immediately if your school reports an emergency.';
});

function handleAllClear(data) {
  stopSiren();
  stopVibration();
  state.currentAlert = null;
  $('clear-detail').textContent = data.message || 'The emergency is over. Return to normal activities unless staff tell you otherwise.';
  openOverlay('clear-view');
}

/* ---------------- Siren & vibration ---------------- */

const siren = $('siren');
const alarmBtn = $('alarm-btn');

function unlockAudio() {
  try {
    const wasMuted = siren.muted;
    siren.muted = true;
    const p = siren.play();
    if (p && p.then) {
      p.then(() => {
        siren.pause();
        siren.currentTime = 0;
        siren.muted = wasMuted;
      }).catch(() => {
        siren.muted = wasMuted;
      });
    }
  } catch (_) {}
}

function markAlarmBlocked(blocked) {
  alarmBtn.classList.toggle('needs-gesture', !!blocked);
  alarmBtn.textContent = blocked ? '🔊 TAP TO SOUND THE ALARM' : '🔊 SOUND ALARM';
}

function startSiren(retry) {
  if (!state.currentAlert) return;
  siren.loop = true;
  siren.muted = false;
  const p = siren.play();
  if (p && p.catch) {
    p.then(() => {
      if (!state.currentAlert) {
        try { siren.pause(); siren.currentTime = 0; } catch (_) {}
        state.sirenOn = false;
        return;
      }
      state.sirenOn = true;
      markAlarmBlocked(false);
    }).catch(() => {
      state.sirenOn = false;
      if (!state.currentAlert) return;
      markAlarmBlocked(true);
      if (retry !== false) setTimeout(() => startSiren(false), 600);
    });
  } else {
    state.sirenOn = true;
  }
}

function stopSiren() {
  siren.pause();
  siren.currentTime = 0;
  state.sirenOn = false;
  markAlarmBlocked(false);
}

function startVibration() {
  stopVibration();
  const buzz = () => {
    if (navigator.vibrate) navigator.vibrate([900, 300]);
  };
  buzz();
  state.vibTimer = setInterval(buzz, 1200);
}

function stopVibration() {
  if (state.vibTimer) clearInterval(state.vibTimer);
  state.vibTimer = null;
  if (navigator.vibrate) navigator.vibrate(0);
}

alarmBtn.addEventListener('click', () => {
  markAlarmBlocked(false);
  startSiren(false);
});

document.addEventListener('click', () => {
  if (!state.sirenOn && state.currentAlert) startSiren(false);
}, true);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.currentAlert && !state.sirenOn) startSiren();
});

document.addEventListener('pointerdown', function unlockOnce() {
  document.removeEventListener('pointerdown', unlockOnce);
  unlockAudio();
}, { once: true });

init();
