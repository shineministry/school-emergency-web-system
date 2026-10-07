const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem('se_admin_token') || null,
  user: null,
  types: {},
  selectedType: 'fire',
  activeAlert: null,
  pollTimer: null,
  confirmTimer: null,
  armed: false
};

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- Auth ---------------- */

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('auth-error');
  errEl.hidden = true;
  try {
    const body = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('login-email').value, password: $('login-password').value })
    });
    if (body.user.role === 'student') throw new Error('Students cannot access the staff dashboard');
    state.token = body.token;
    state.user = body.user;
    localStorage.setItem('se_admin_token', state.token);
    startDashboard();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

$('logout-btn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  localStorage.removeItem('se_admin_token');
  state.token = null;
  state.user = null;
  if (state.pollTimer) clearInterval(state.pollTimer);
  showView('auth-view');
});

/* ---------------- Dashboard ---------------- */

async function init() {
  if (!state.token) return showView('auth-view');
  try {
    const res = await api('/api/auth/me');
    if (res.user.role === 'student') throw new Error('Students cannot access the staff dashboard');
    state.user = res.user;
    startDashboard();
  } catch (_) {
    state.token = null;
    localStorage.removeItem('se_admin_token');
    showView('auth-view');
  }
}

async function startDashboard() {
  $('school-name').textContent = state.user.school || '';
  $('user-name').textContent = `${state.user.name} (${state.user.role})`;
  showView('dash-view');

  const [typesRes, groupsRes] = await Promise.all([
    api('/api/alerts/types').catch(() => ({ types: {} })),
    api('/api/alerts/groups').catch(() => ({ groups: [] }))
  ]);
  state.types = typesRes.types;

  const datalist = $('group-list');
  datalist.innerHTML =
    '<option value="all">Everyone</option>' +
    groupsRes.groups.map((g) => `<option value="${escapeHtml(g.group_name)}">${g.count} people</option>`).join('');

  selectType(state.selectedType);
  loadHistory();
  restoreActive();
  setupPush();
}

function selectType(type) {
  state.selectedType = type;
  document.querySelectorAll('.type-btn').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  const preset = state.types[type];
  if (preset && !$('message-input').dataset.touched) {
    $('message-input').value = preset.defaultMessage;
  }
}

document.querySelectorAll('.type-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('message-input').dataset.touched = '';
    selectType(btn.dataset.type);
  });
});

$('message-input').addEventListener('input', () => {
  $('message-input').dataset.touched = '1';
});

/* ---------------- Send alert ---------------- */

$('send-btn').addEventListener('click', () => {
  if (!state.armed) {
    state.armed = true;
    const btn = $('send-btn');
    btn.classList.add('confirm');
    btn.textContent = '⚠️ PRESS AGAIN TO CONFIRM SEND';
    state.confirmTimer = setTimeout(() => {
      state.armed = false;
      btn.classList.remove('confirm');
      btn.textContent = '🚨 SEND EMERGENCY ALERT';
    }, 4000);
    return;
  }
  sendAlert();
});

async function sendAlert() {
  clearTimeout(state.confirmTimer);
  state.armed = false;
  const btn = $('send-btn');
  btn.disabled = true;
  try {
    const res = await api('/api/alerts', {
      method: 'POST',
      body: JSON.stringify({
        type: state.selectedType,
        target: $('target-input').value.trim() || 'all',
        message: $('message-input').value.trim(),
        drill: $('drill-toggle').checked
      })
    });
    btn.textContent = '🚨 SEND EMERGENCY ALERT';
    const status = $('send-status');
    status.textContent = `Alert #${res.alert.id} sent to ${res.recipients} recipient(s).`;
    status.hidden = false;
    setTimeout(() => (status.hidden = true), 6000);
    activatePanel(res.alert);
    loadHistory();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- Active alert panel ---------------- */

function activatePanel(alert) {
  state.activeAlert = alert;
  $('active-panel').hidden = false;
  $('active-icon').textContent = ({ fire: '🔥', evacuation: '🏃', lockdown: '🔒', medical: '🚑', danger: '⚠️' })[alert.type] || '🚨';
  $('active-title').textContent = alert.title + (alert.drill ? '' : ' – ACTIVE');
  $('trigger-panel').hidden = true;
  pollStatus();
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(pollStatus, 3000);
}

async function restoreActive() {
  try {
    const res = await api('/api/alerts');
    const active = res.alerts.find((a) => a.status === 'active');
    if (active) {
      activatePanel({
        id: active.id,
        type: active.type,
        title: active.title,
        drill: !!active.drill
      });
    }
  } catch (_) {}
}

async function pollStatus() {
  if (!state.activeAlert) return;
  try {
    const res = await api('/api/alerts/' + state.activeAlert.id + '/status');
    renderStatus(res);
  } catch (_) {}
}

function renderStatus(res) {
  const t = res.totals;
  $('c-safe').textContent = t.safe;
  $('c-notified').textContent = t.notified;
  $('c-pending').textContent = t.pending;
  $('c-total').textContent = t.total;
  $('progress-bar').style.width = t.total ? Math.round(((t.safe + t.notified) / t.total) * 100) + '%' : '0%';

  const cols = { safe: $('list-safe'), notified: $('list-notified'), pending: $('list-pending') };
  for (const key of Object.keys(cols)) cols[key].innerHTML = '';
  for (const p of res.people) {
    const li = document.createElement('li');
    const label = p.role === 'student' ? p.group_name : p.role;
    li.innerHTML = `<span>${escapeHtml(p.name)}</span><em>${escapeHtml(label)}</em>`;
    cols[p.state].appendChild(li);
  }
  for (const key of Object.keys(cols)) {
    if (!cols[key].children.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'None';
      cols[key].appendChild(li);
    }
  }

  if (res.alert.status === 'closed') deactivatePanel();
}

$('close-alert').addEventListener('click', async () => {
  if (!state.activeAlert) return;
  if (!confirm('Send ALL CLEAR and close this alert?')) return;
  try {
    await api('/api/alerts/' + state.activeAlert.id + '/close', { method: 'POST' });
    deactivatePanel();
    loadHistory();
  } catch (err) {
    alert(err.message);
  }
});

function deactivatePanel() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  state.activeAlert = null;
  $('active-panel').hidden = true;
  $('trigger-panel').hidden = false;
}

/* ---------------- History ---------------- */

async function loadHistory() {
  try {
    const res = await api('/api/alerts');
    const body = $('history-body');
    if (!res.alerts.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">No alerts yet</td></tr>';
      return;
    }
    body.innerHTML = res.alerts
      .map((a) => {
        const when = new Date(a.created_at + 'Z').toLocaleString();
        const status = a.status === 'active' ? '<span class="tag active">ACTIVE</span>' : '<span class="tag closed">CLOSED</span>';
        const drill = a.drill ? ' <span class="tag drill">DRILL</span>' : '';
        return `<tr>
          <td>${a.id}</td>
          <td>${escapeHtml(when)}</td>
          <td>${escapeHtml(a.title)}${drill}</td>
          <td>${escapeHtml(a.target)}</td>
          <td>${a.counts.safe}</td>
          <td>${a.counts.notified}</td>
          <td>${a.counts.pending}</td>
          <td>${status}</td>
        </tr>`;
      })
      .join('');
  } catch (_) {}
}

/* ---------------- Push on staff device ---------------- */

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function setupPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  if (Notification.permission === 'granted') return;
  const btn = $('enable-push');
  btn.hidden = false;
  btn.addEventListener('click', async () => {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      const reg = (await navigator.serviceWorker.register('/sw.js')) || navigator.serviceWorker.ready;
      const keyRes = await api('/api/push/public-key');
      const sub =
        (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(keyRes.publicKey) }));
      await api('/api/alerts/devices', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
      btn.hidden = true;
    }
  });
}

init();
