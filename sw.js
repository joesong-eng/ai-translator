// Service Worker for 即時翻譯 PWA
// Caches the app shell for offline use (but API calls still need internet)

const CACHE = 'tx-v1';
const SHELL = ['/', '/index.html', '/manifest.json', '/icon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; })
            .map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  // Only cache GET requests for same-origin app shell
  // Let API calls (generativelanguage.googleapis.com) go through normally
  if (e.request.method !== 'GET') return;
  if (e.request.url.indexOf('googleapis.com') !== -1) return;

  e.respondWith(
    caches.match(e.request).then(function (cached) {
      if (cached) return cached;
      return fetch(e.request).then(function (response) {
        // Cache valid responses for app shell files
        if (response && response.status === 200 && response.type === 'basic') {
          var clone = response.clone();
          caches.open(CACHE).then(function (cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      }).catch(function () {
        // If offline and not cached, return the main page
        return caches.match('/index.html');
      });
    })
  );
});
