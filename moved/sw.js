// Clean-up service worker for the old Leave By address. It replaces the old app's service worker,
// removes Leave By's own files from this phone, unregisters itself, and reloads open windows so
// they show the "moved" page. It never touches other apps' caches or storage.
self.addEventListener('install', () => { self.skipWaiting(); });

function deleteLeaveByDb() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase('leave-by');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch (e) {
      resolve();
    }
  });
}

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 1. Only caches whose names start with "leave-by".
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('leave-by')).map((k) => caches.delete(k)));
    // 2. Leave By's own IndexedDB database.
    await deleteLeaveByDb();
    // 3. Remove this service worker.
    await self.registration.unregister();
    // 4. Reload open windows so they show the moved page.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(wins.map((w) => (w.navigate ? w.navigate(w.url).catch(() => {}) : null)));
  })());
});
