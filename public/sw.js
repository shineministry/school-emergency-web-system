const CACHE = 'school-emergency-v8';
const SHELL = [
  '/app/',
  '/app/index.html',
  '/app/app.js',
  '/app/app.css',
  '/manifest.json',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/siren.wav'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url)))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok && (url.pathname.startsWith('/app') || url.pathname.startsWith('/assets'))) {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        }
        return res;
      });
    })
  );
});

async function getToken() {
  try {
    const cache = await caches.open('auth');
    const res = await cache.match('/token');
    return res ? await res.text() : null;
  } catch (_) {
    return null;
  }
}

/* ---------------- Emergency-styled notifications ---------------- */

function displayTitle(data) {
  const school = data.school || 'School Emergency';
  if (data.kind === 'all_clear') return '✅ ' + school + ' — ALL CLEAR';
  const drill = data.drill ? ' (DRILL)' : '';
  return '🚨 ' + school + ' — ' + (data.title || 'EMERGENCY') + drill;
}

function shortBody(data) {
  const msg = String(data.message || 'Open the app for details.');
  const lines = msg.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.slice(0, 3).join(' — ').slice(0, 300);
}

function notificationOptions(data, extra) {
  return Object.assign(
    {
      body: shortBody(data),
      tag: 'school-alert-' + data.alertId,
      renotify: true,
      requireInteraction: true,
      vibrate: [700, 200, 700, 200, 700, 200, 700],
      color: '#e30613',
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      image: '/assets/icon-512.png',
      data: { url: data.url, alertId: data.alertId },
      actions: [
        { action: 'safe', title: '✅ I AM SAFE' },
        { action: 'open', title: 'Open app' }
      ]
    },
    extra || {}
  );
}

async function showAlertNotification(data) {
  await self.registration.showNotification(displayTitle(data), notificationOptions(data));
}

async function alertStillOpen(alertId) {
  const token = await getToken();
  if (!token) return false;
  try {
    const res = await fetch('/api/alerts/' + alertId + '/mystate?token=' + encodeURIComponent(token));
    if (!res.ok) return false;
    const info = await res.json();
    return info.status === 'active' && info.state === 'pending';
  } catch (_) {
    return false;
  }
}

function scheduleRepeats(data) {
  let count = 0;
  const tick = () => {
    if (count >= 8) return;
    count += 1;
    setTimeout(async () => {
      const stillOpen = await alertStillOpen(data.alertId);
      if (!stillOpen) return;
      try {
        await showAlertNotification(data);
      } catch (_) {
        return;
      }
      tick();
    }, 15000);
  };
  tick();
}

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data.json();
  } catch (_) {
    data = { title: 'School Emergency', message: 'Open the app for details.', url: '/app/' };
  }
  event.waitUntil(
    (async () => {
      if (data.kind === 'all_clear') {
        const notes = await self.registration.getNotifications();
        for (const n of notes) n.close();
        await self.registration.showNotification(displayTitle(data), {
          body: shortBody(data),
          tag: 'school-allclear',
          renotify: true,
          vibrate: [200, 100, 200],
          color: '#16a34a',
          icon: '/assets/icon-192.png',
          badge: '/assets/icon-192.png',
          data: { url: data.url }
        });
        return;
      }
      await showAlertNotification(data);
      scheduleRepeats(data);
    })()
  );
});

/* ---------------- Actions: I AM SAFE straight from the notification ---------------- */

async function markSafeFromNotification(alertId) {
  const token = await getToken();
  if (!token || !alertId) return;
  try {
    const res = await fetch('/api/alerts/' + alertId + '/safe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: '{}'
    });
    if (!res.ok) return;
    await self.registration.showNotification('✅ You are marked SAFE', {
      body: 'The school has been notified that you are safe.',
      tag: 'school-safe-' + alertId,
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      vibrate: [150, 100, 150]
    });
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: 'safe-done', alertId: alertId });
  } catch (_) {}
}

self.addEventListener('notificationclick', (event) => {
  const data = (event.notification && event.notification.data) || {};
  if (event.action === 'safe') {
    event.notification.close();
    event.waitUntil(markSafeFromNotification(data.alertId));
    return;
  }
  event.notification.close();
  const url = data.url || '/app/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(url);
          return;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'clear-alerts') {
    self.registration.getNotifications().then((notes) => notes.forEach((n) => n.close()));
  }
  if (msg.type === 'show-local' && msg.payload) {
    const payload = msg.payload;
    if (payload.kind === 'all_clear') {
      self.registration.getNotifications().then((notes) => notes.forEach((n) => n.close()));
      self.registration.showNotification(displayTitle(payload), {
        body: shortBody(payload),
        tag: 'school-allclear',
        renotify: true,
        vibrate: [200, 100, 200],
        color: '#16a34a',
        icon: '/assets/icon-192.png',
        badge: '/assets/icon-192.png',
        data: { url: payload.url }
      });
      return;
    }
    self.registration.showNotification(displayTitle(payload), notificationOptions(payload));
    scheduleRepeats(payload);
  }
});
