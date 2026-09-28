// Leave By — tiny key/value store in IndexedDB, shared by the app and the service worker
// (the service worker can't read localStorage). Database "leave-by", store "kv".
(function (root) {
  'use strict';

  function open() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('leave-by', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function run(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', mode);
        var req = fn(tx.objectStore('kv'));
        tx.oncomplete = function () { db.close(); resolve(req ? req.result : undefined); };
        tx.onerror = tx.onabort = function () { db.close(); reject(tx.error); };
      });
    });
  }

  root.LeaveByKV = {
    get: function (k) { return run('readonly', function (s) { return s.get(k); }); },
    set: function (k, v) { return run('readwrite', function (s) { return s.put(v, k); }); }
  };
})(self);
