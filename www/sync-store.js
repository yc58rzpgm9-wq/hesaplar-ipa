(function () {
  'use strict';

  // Records are written to this device first (works offline, instant UI),
  // then synced to the cloud database through /api/sync.
  var STORAGE_PREFIX = 'hesaplar.localdb.v1:';
  var SYNC_PREFIX = 'hesaplar.sync.v1:';
  var CURSOR_KEY = SYNC_PREFIX + 'cursor';
  var OUTBOX_KEY = SYNC_PREFIX + 'outbox';
  var LAST_SYNC_KEY = SYNC_PREFIX + 'last';
  var LOCAL_USER_ID = 'local-device';
  var PRODUCTION_ORIGIN = 'https://celiksut.netlify.app';
  var POLL_MS = 30000;
  var REQUEST_TIMEOUT_MS = 20000;
  var MAX_BATCH_COUNT = 50;
  var MAX_BATCH_BYTES = 3 * 1024 * 1024;

  var subscriptions = [];
  var panel;
  var message;
  var syncButton;
  var installPrompt = null;
  var installGuide;
  var installMessage;
  var installAction;

  // The installed iOS/Android app serves files from its own local origin, so it
  // has to talk to the deployed site. The website itself uses relative URLs.
  var API_BASE = (function () {
    var protocol = location.protocol;
    var nativeShell = protocol !== 'http:' && protocol !== 'https:' ||
      (location.hostname === 'localhost' && !location.port);
    return nativeShell ? PRODUCTION_ORIGIN : '';
  })();

  function normalizePath(path) {
    var normalized = String(path || '').replace(/^\/+|\/+$/g, '');
    if (!normalized) throw new Error('Kayıt alanı boş olamaz.');
    return normalized;
  }

  function storageKey(path) {
    return STORAGE_PREFIX + encodeURIComponent(path);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function reportStorageError(error) {
    console.error('Cihaz depolamasına erişilemedi:', error);
    setStatus('error', 'Cihaz depolamasına erişilemedi. Verileri dışa aktarabiliyorsanız yedek alın.');
  }

  function readCollection(path) {
    var raw = window.localStorage.getItem(storageKey(path));
    if (raw === null) return Object.create(null);
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Cihazdaki kayıt alanı geçersiz: ' + path);
    }
    var records = Object.create(null);
    Object.keys(parsed).forEach(function (id) {
      records[id] = parsed[id];
    });
    return records;
  }

  function writeCollection(path, records) {
    window.localStorage.setItem(storageKey(path), JSON.stringify(records));
  }

  /* ---------- Bekleyen değişiklikler (outbox) ---------- */

  function outboxKey(path, id) {
    return path + '\u0000' + id;
  }

  function readOutbox() {
    try {
      var parsed = JSON.parse(window.localStorage.getItem(OUTBOX_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function writeOutbox(outbox) {
    window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
  }

  function enqueue(path, id, data) {
    var outbox = readOutbox();
    var previous = outbox[outboxKey(path, id)];
    outbox[outboxKey(path, id)] = {
      c: path,
      id: id,
      data: data === undefined ? null : data,
      deleted: data === undefined,
      n: (previous ? previous.n : 0) + 1
    };
    writeOutbox(outbox);
  }

  function pendingCount() {
    return Object.keys(readOutbox()).length;
  }

  /* ---------- Snapshot ve dinleyiciler ---------- */

  function makeDocumentSnapshot(id, records) {
    var exists = Object.prototype.hasOwnProperty.call(records, id);
    return {
      id: id,
      exists: exists,
      data: function () {
        return exists ? clone(records[id]) : undefined;
      }
    };
  }

  function makeCollectionSnapshot(records) {
    var docs = Object.keys(records).map(function (id) {
      return makeDocumentSnapshot(id, records);
    });
    return {
      docs: docs,
      size: docs.length,
      empty: docs.length === 0,
      forEach: function (callback) {
        docs.forEach(callback);
      }
    };
  }

  function deliver(subscription) {
    if (!subscription.active) return;
    var snapshot;
    try {
      var records = readCollection(subscription.path);
      snapshot = subscription.id === null
        ? makeCollectionSnapshot(records)
        : makeDocumentSnapshot(subscription.id, records);
    } catch (error) {
      reportStorageError(error);
      notifyListenerError(subscription, error);
      return;
    }
    try {
      subscription.callback(snapshot);
    } catch (error) {
      console.error('Kayıt dinleyicisi hata verdi:', error);
      notifyListenerError(subscription, error);
    }
  }

  function notifyListenerError(subscription, error) {
    if (!subscription.onError) return;
    try {
      subscription.onError(error);
    } catch (handlerError) {
      console.error('Kayıt hata dinleyicisi hata verdi:', handlerError);
    }
  }

  // ids: an object whose keys are the changed document ids in this collection.
  function notifyPath(path, ids) {
    subscriptions.slice().forEach(function (subscription) {
      if (subscription.path === path &&
          (subscription.id === null || Object.prototype.hasOwnProperty.call(ids, subscription.id))) {
        deliver(subscription);
      }
    });
  }

  function notify(path, id) {
    var ids = {};
    ids[id] = true;
    notifyPath(path, ids);
  }

  function subscribe(path, id, callback, onError) {
    if (typeof callback !== 'function') {
      throw new TypeError('An onSnapshot callback is required.');
    }
    var subscription = {
      path: path,
      id: id,
      callback: callback,
      onError: typeof onError === 'function' ? onError : null,
      active: true
    };
    subscriptions.push(subscription);
    Promise.resolve().then(function () {
      deliver(subscription);
    });
    return function () {
      subscription.active = false;
      subscriptions = subscriptions.filter(function (item) {
        return item !== subscription;
      });
    };
  }

  function failed(error) {
    reportStorageError(error);
    return Promise.reject(error);
  }

  function trackSubscription(scope, path, id, callback, onError) {
    var unsubscribe = subscribe(path, id, callback, onError);
    if (scope) scope.add(unsubscribe);
    return function () {
      unsubscribe();
      if (scope) scope.remove(unsubscribe);
    };
  }

  /* ---------- Veritabanı arayüzü ---------- */

  function createDocumentReference(path, id, scope) {
    return {
      id: id,
      get: function () {
        return Promise.resolve().then(function () {
          return makeDocumentSnapshot(id, readCollection(path));
        }).catch(function (error) {
          reportStorageError(error);
          throw error;
        });
      },
      set: function (data, options) {
        try {
          if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new TypeError('Kayıt verisi bir nesne olmalıdır.');
          }
          var records = readCollection(path);
          var value = clone(data);
          if (options && options.merge && records[id]) {
            value = Object.assign(Object.create(null), records[id], value);
          }
          records[id] = value;
          writeCollection(path, records);
          enqueue(path, id, value);
          notify(path, id);
          scheduleSync(400);
          return Promise.resolve();
        } catch (error) {
          return failed(error);
        }
      },
      delete: function () {
        try {
          var records = readCollection(path);
          delete records[id];
          writeCollection(path, records);
          enqueue(path, id, undefined);
          notify(path, id);
          scheduleSync(400);
          return Promise.resolve();
        } catch (error) {
          return failed(error);
        }
      },
      onSnapshot: function (callback, onError) {
        return trackSubscription(scope, path, id, callback, onError);
      }
    };
  }

  function createDatabase(scope) {
    return {
      collection: function (collectionPath) {
        var path = normalizePath(collectionPath);
        return {
          doc: function (id) {
            var documentId = id == null
              ? Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
              : String(id);
            if (!documentId || documentId.indexOf('/') !== -1) {
              throw new Error('Kayıt kimliği geçersiz.');
            }
            return createDocumentReference(path, documentId, scope);
          },
          get: function () {
            return Promise.resolve().then(function () {
              return makeCollectionSnapshot(readCollection(path));
            }).catch(function (error) {
              reportStorageError(error);
              throw error;
            });
          },
          onSnapshot: function (callback, onError) {
            return trackSubscription(scope, path, null, callback, onError);
          }
        };
      }
    };
  }

  function createScope() {
    var active = true;
    var cleanups = [];
    var scope = {
      add: function (unsubscribe) {
        if (!active) {
          unsubscribe();
          return;
        }
        cleanups.push(unsubscribe);
      },
      remove: function (unsubscribe) {
        cleanups = cleanups.filter(function (cleanup) {
          return cleanup !== unsubscribe;
        });
      }
    };
    return {
      use: function (service) {
        if (!active) return Promise.reject(new Error('Bu uygulama oturumu kapandı.'));
        return useService(service, scope);
      },
      dispose: function () {
        if (!active) return;
        active = false;
        cleanups.splice(0).forEach(function (unsubscribe) {
          unsubscribe();
        });
      }
    };
  }

  function downloadProvider() {
    return {
      save: function (options) {
        try {
          var blob = new Blob([options.data], { type: 'application/octet-stream' });
          var url = URL.createObjectURL(blob);
          var anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = options.filename || 'hesaplar-dosya';
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      }
    };
  }

  window.hesaplarStorageMode = 'cloud';
  function useService(service, scope) {
    if (service === 'downloads') return Promise.resolve(downloadProvider());
    if (service === 'db') return Promise.resolve(createDatabase(scope));
    if (service === 'user') {
      return Promise.resolve({
        id: function () { return Promise.resolve(LOCAL_USER_ID); }
      });
    }
    return Promise.reject(new Error('Desteklenmeyen servis: ' + service));
  }

  window.claude = {
    use: function (service) {
      return useService(service, null);
    },
    createScope: createScope
  };

  /* ---------- Bulut eşitleme ---------- */

  var syncing = null;
  var syncAgain = false;
  var syncTimer = null;

  function request(method, path, body) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? window.setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    return fetch(API_BASE + path, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body,
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (json) {
        if (!response.ok) throw new Error(json.error || ('Sunucu yanıtı: ' + response.status));
        return json;
      });
    }).finally(function () {
      if (timer) window.clearTimeout(timer);
    });
  }

  // Sends pending local changes to the server in batches.
  function pushPending() {
    var outbox = readOutbox();
    var entries = Object.keys(outbox).map(function (key) { return outbox[key]; });
    if (!entries.length) return Promise.resolve();

    var batches = [];
    var current = [];
    var size = 0;
    entries.forEach(function (entry) {
      var entrySize = JSON.stringify(entry).length;
      if (current.length && (current.length >= MAX_BATCH_COUNT || size + entrySize > MAX_BATCH_BYTES)) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(entry);
      size += entrySize;
    });
    if (current.length) batches.push(current);

    return batches.reduce(function (chain, batch) {
      return chain.then(function () {
        var payload = batch.map(function (e) {
          return { c: e.c, id: e.id, data: e.data, deleted: e.deleted };
        });
        return request('POST', '/api/sync', JSON.stringify({ changes: payload })).then(function () {
          // Only drop entries that were not edited again while the request was in flight.
          var latest = readOutbox();
          batch.forEach(function (sent) {
            var key = outboxKey(sent.c, sent.id);
            if (latest[key] && latest[key].n === sent.n) delete latest[key];
          });
          writeOutbox(latest);
        });
      });
    }, Promise.resolve());
  }

  function fetchChanges(since) {
    var all = [];
    function page(cursor) {
      return request('GET', '/api/sync?since=' + encodeURIComponent(cursor)).then(function (result) {
        all = all.concat(result.changes || []);
        if (result.more && result.cursor > cursor) return page(result.cursor);
        return result.cursor;
      });
    }
    return page(since).then(function (cursor) {
      return { changes: all, cursor: cursor };
    });
  }

  function localCollectionPaths() {
    var paths = [];
    for (var i = 0; i < window.localStorage.length; i++) {
      var key = window.localStorage.key(i);
      if (key && key.indexOf(STORAGE_PREFIX) === 0) {
        try {
          paths.push(decodeURIComponent(key.slice(STORAGE_PREFIX.length)));
        } catch (error) { /* bozuk anahtar, atla */ }
      }
    }
    return paths;
  }

  // On the very first sync of a device, upload records that only exist here
  // (for example data saved before cloud sync was enabled).
  function queueLocalOnlyRecords(serverChanges) {
    var onServer = {};
    serverChanges.forEach(function (change) {
      onServer[outboxKey(change.c, change.id)] = true;
    });
    var outbox = readOutbox();
    var added = false;
    localCollectionPaths().forEach(function (path) {
      var records;
      try { records = readCollection(path); } catch (error) { return; }
      Object.keys(records).forEach(function (id) {
        var key = outboxKey(path, id);
        if (onServer[key] || outbox[key]) return;
        outbox[key] = { c: path, id: id, data: records[id], deleted: false, n: 1 };
        added = true;
      });
    });
    if (added) writeOutbox(outbox);
  }

  // Writes server changes into local storage and notifies listeners.
  // Documents with unsent local edits are skipped; the local edit wins.
  function applyRemote(changes) {
    if (!changes.length) return;
    var outbox = readOutbox();
    var byPath = {};
    changes.forEach(function (change) {
      if (outbox[outboxKey(change.c, change.id)]) return;
      (byPath[change.c] = byPath[change.c] || []).push(change);
    });
    Object.keys(byPath).forEach(function (path) {
      var records;
      try { records = readCollection(path); } catch (error) { records = Object.create(null); }
      var changedIds = {};
      byPath[path].forEach(function (change) {
        var exists = Object.prototype.hasOwnProperty.call(records, change.id);
        if (change.deleted) {
          if (!exists) return;
          delete records[change.id];
        } else {
          if (exists && JSON.stringify(records[change.id]) === JSON.stringify(change.data)) return;
          records[change.id] = change.data;
        }
        changedIds[change.id] = true;
      });
      if (Object.keys(changedIds).length) {
        writeCollection(path, records);
        notifyPath(path, changedIds);
      }
    });
  }

  function pull() {
    var stored = window.localStorage.getItem(CURSOR_KEY);
    var firstSync = stored === null;
    var since = firstSync ? 0 : Number(stored) || 0;
    return fetchChanges(since).then(function (result) {
      if (firstSync) queueLocalOnlyRecords(result.changes);
      applyRemote(result.changes);
      window.localStorage.setItem(CURSOR_KEY, String(result.cursor));
      return firstSync;
    });
  }

  function runSync() {
    setStatus('syncing');
    // Pull first on a fresh device so local-only records can be detected,
    // otherwise push first so the server has our latest edits.
    var firstSync = window.localStorage.getItem(CURSOR_KEY) === null;
    var steps = firstSync
      ? pull().then(pushPending)
      : pushPending().then(pull);
    return steps.then(function () {
      if (pendingCount()) return pushPending();
    }).then(function () {
      window.localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
      setStatus(pendingCount() ? 'pending' : 'ok');
    }, function (error) {
      console.warn('Bulut eşitleme başarısız:', error);
      setStatus(navigator.onLine === false ? 'offline' : 'error');
    });
  }

  function syncNow() {
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    syncing = runSync().finally(function () {
      syncing = null;
      if (syncAgain) {
        syncAgain = false;
        scheduleSync(0);
      }
    });
    return syncing;
  }

  function scheduleSync(delay) {
    if (syncTimer) window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(function () {
      syncTimer = null;
      syncNow();
    }, delay);
  }

  /* ---------- Durum paneli ---------- */

  var statusState = 'idle';

  function formatTime(iso) {
    if (!iso) return '';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function setStatus(state, override) {
    statusState = state;
    if (!message) return;
    var pending = 0;
    try { pending = pendingCount(); } catch (error) { /* yoksay */ }
    var last = formatTime(window.localStorage.getItem(LAST_SYNC_KEY));
    var text;
    var cls = 'unote';
    if (override) {
      text = override;
      cls = 'msg';
    } else if (state === 'syncing') {
      text = 'Buluta eşitleniyor…';
    } else if (state === 'ok') {
      text = 'Tüm kayıtlar bulutta ✓' + (last ? ' · Son eşitleme: ' + last : '');
    } else if (state === 'pending') {
      text = pending + ' değişiklik buluta gönderilmeyi bekliyor.';
    } else if (state === 'offline') {
      text = 'Çevrimdışı. Kayıtlar bu cihazda tutuluyor' +
        (pending ? ' (' + pending + ' değişiklik bekliyor)' : '') + '; bağlantı gelince eşitlenecek.';
    } else if (state === 'error') {
      text = 'Buluta ulaşılamadı. Kayıtlar bu cihazda güvende' +
        (pending ? ' (' + pending + ' değişiklik bekliyor)' : '') + '; tekrar denenecek.';
      cls = 'msg';
    } else {
      text = 'Kayıtlar bu cihaza yazılır ve otomatik olarak buluta eşitlenir.';
    }
    message.textContent = text;
    message.className = cls;
    if (syncButton) syncButton.disabled = state === 'syncing';
  }

  function renderPanel() {
    if (!panel) return;
    panel.replaceChildren();
    panel.className = 'card';
    panel.style.cssText = 'display:block;margin:0 0 16px;padding:14px';
    var title = document.createElement('b');
    title.textContent = 'Bulut kayıt';
    panel.appendChild(title);
    message = document.createElement('div');
    message.className = 'unote';
    message.setAttribute('aria-live', 'polite');
    panel.appendChild(message);
    syncButton = document.createElement('button');
    syncButton.className = 'pbt alt';
    syncButton.style.marginTop = '8px';
    syncButton.textContent = 'Şimdi eşitle';
    syncButton.addEventListener('click', function () { syncNow(); });
    panel.appendChild(syncButton);
    setStatus(statusState);
  }

  /* ---------- Kurulum ve service worker ---------- */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:' || API_BASE) return;
    navigator.serviceWorker.register('./service-worker.js').catch(function (error) {
      console.error('Service worker kaydedilemedi:', error);
    });
  }

  function updateInstallGuide() {
    if (!installGuide || !installMessage || !installAction) return;
    var standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    var ios = /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (standalone || navigator.standalone === true || API_BASE) {
      installGuide.hidden = true;
      return;
    }
    if (ios) {
      installGuide.hidden = false;
      installAction.hidden = true;
      installMessage.textContent = 'Safari’de Paylaş düğmesine dokunup “Ana Ekrana Ekle”yi seç.';
      return;
    }
    if (installPrompt) {
      installGuide.hidden = false;
      installAction.hidden = false;
      installMessage.textContent = 'Uygulama mağazası gerekmeden bu cihaza yüklenir.';
      return;
    }
    installGuide.hidden = true;
  }

  function setupInstallGuide() {
    installGuide = document.getElementById('install-guide');
    installMessage = document.getElementById('install-message');
    installAction = document.getElementById('install-action');
    if (!installGuide || !installMessage || !installAction) return;
    installAction.addEventListener('click', function () {
      if (!installPrompt) return;
      var prompt = installPrompt;
      installPrompt = null;
      prompt.prompt().then(function () {
        return prompt.userChoice;
      }).then(function (choice) {
        if (choice && choice.outcome === 'accepted') {
          installGuide.hidden = true;
        } else {
          updateInstallGuide();
        }
      }).catch(function (error) {
        console.error('Kurulum istemi açılamadı:', error);
        installMessage.textContent = 'Kurulum açılamadı. Tarayıcı menüsünden “Uygulamayı yükle”yi seç.';
        installAction.hidden = true;
      });
    });
    updateInstallGuide();
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    installPrompt = event;
    updateInstallGuide();
  });
  window.addEventListener('appinstalled', function () {
    installPrompt = null;
    if (installGuide) installGuide.hidden = true;
  });

  function startSyncLoop() {
    window.addEventListener('online', function () { scheduleSync(0); });
    window.addEventListener('offline', function () { setStatus('offline'); });
    window.addEventListener('focus', function () { scheduleSync(0); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') scheduleSync(0);
    });
    window.setInterval(function () {
      if (document.visibilityState === 'visible' && !syncTimer) syncNow();
    }, POLL_MS);
    syncNow();
  }

  function start() {
    var home = document.getElementById('home');
    var before = document.getElementById('go');
    if (home && before) {
      panel = document.createElement('div');
      home.insertBefore(panel, before);
    }
    renderPanel();
    setupInstallGuide();
    registerServiceWorker();
    startSyncLoop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
