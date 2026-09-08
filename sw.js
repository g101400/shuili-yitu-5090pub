// 水利工程一张图 PWA Service Worker（离线缓存 App Shell）
const CACHE = 'shuili-map-pwa-v1-sec';
const ASSETS = ['./', './index.html', './app.js', './secure/dat.enc.js', './secure_gate.js', './jszip.min.js',
  './leaflet/leaflet.css', './leaflet/leaflet.js', './leaflet/images/'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(ASSETS).catch(function () {});
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(function (r) {
      if (r) return r;
      return fetch(e.request).then(function (resp) {
        var cp = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, cp); });
        return resp;
      }).catch(function () { return caches.match('./index.html'); });
    })
  );
});
