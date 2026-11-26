var CACHE_NAME = 'hesaplar-shell-v4-cloud';
var SHELL = [
  './',
  './index.html',
  './sync-store.js',
  './manifest.webmanifest',
  './app-icon.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE_NAME).then(function (cache) {
    return cache.addAll(SHELL);
  }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) {
      return key !== CACHE_NAME;
    }).map(function (key) {
      return caches.delete(key);
    }));
  }).then(function () {
    return self.clients.claim();
  }));
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Sync API must always hit the network.
  if (url.pathname.indexOf('/api/') === 0) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(function (response) {
      var copy = response.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put('./index.html', copy); });
      return response;
    }).catch(function () {
      return caches.match('./index.html');
    }));
    return;
  }
  // Network first for app files so updates arrive; cache as offline fallback.
  event.respondWith(fetch(request).then(function (response) {
    if (response.ok) {
      var copy = response.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
    }
    return response;
  }).catch(function () {
    return caches.match(request);
  }));
});
