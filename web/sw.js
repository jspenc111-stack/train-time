// Service worker: keeps the app itself available offline (the data is cached by app.js),
// and shows notifications. The script sends an empty push (a "doorbell"); we then fetch the
// real message from the script ourselves, so the push service never sees event details.
importScripts('kv.js');

const CACHE = 'leave-by-v6';
const ASSETS = ['./', 'index.html', 'app.js', 'links.js', 'kv.js', 'styles.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
const KV = self.LeaveByKV;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Our own files: network first (so updates show up), fall back to cache when offline.
// Anything else (the Apps Script API): straight to the network.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});

// ── Notifications ──

function scriptUrl(conn, params) {
  const q = new URLSearchParams(Object.assign({ key: conn.key }, params));
  return conn.url + (conn.url.indexOf('?') >= 0 ? '&' : '?') + q.toString();
}

async function fetchJson(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function show(m) {
  const trip = m.kind === 'trip' || m.kind === 'change';
  const actions = [{ action: 'open', title: 'Open' }];
  if (trip && m.planKey) actions.push({ action: 'skip', title: 'Skip this event' });
  return self.registration.showNotification(m.title, {
    body: m.body,
    tag: m.planKey || String(m.id),
    renotify: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    silent: !!m.silent,
    requireInteraction: m.stage === 'now',
    data: { planKey: m.planKey || null, kind: m.kind },
    actions
  });
}

async function onPush() {
  let shown = 0;
  try {
    const conn = await KV.get('conn');
    if (conn && conn.url && conn.key) {
      const since = (await KV.get('lastInboxId')) || 0;
      const data = await fetchJson(scriptUrl(conn, { action: 'inbox', since: String(since) }), 8000);
      let last = since;
      for (const m of data.messages || []) {
        await show(m);
        shown++;
        last = Math.max(last, m.id);
      }
      await KV.set('lastInboxId', last);
    }
  } catch (err) {
    // fall through to the fallback below
  }
  // Chrome requires a visible notification for every push.
  if (!shown) {
    await self.registration.showNotification('Leave By — time to check your trips', {
      tag: 'leave-by-fallback', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: {}
    });
  }
}

self.addEventListener('push', (e) => { e.waitUntil(onPush()); });

async function openApp() {
  const scope = self.registration.scope;
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of wins) {
    if (w.url.indexOf(scope) === 0 && 'focus' in w) return w.focus();
  }
  return self.clients.openWindow(scope);
}

async function skip(planKey) {
  const conn = await KV.get('conn');
  if (!conn || !conn.url || !conn.key || !planKey) return openApp();
  try {
    await fetchJson(scriptUrl(conn, { action: 'skip', id: planKey }), 8000);
  } catch (err) {
    return openApp(); // couldn't reach the script: let me skip from the app instead
  }
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil(e.action === 'skip' ? skip(data.planKey) : openApp());
});

function keyBytes(b64) {
  const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// The browser replaced our subscription (e.g. it expired): register the new one with the script.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const [conn, pub] = await Promise.all([KV.get('conn'), KV.get('pushPublicKey')]);
    if (!conn || !conn.url || !conn.key || !pub) return;
    const sub = (e.newSubscription) ||
      await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pub) });
    await fetch(conn.url, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: conn.key, action: 'subscribe', endpoint: sub.endpoint })
    });
  })());
});
