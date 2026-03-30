const CACHE = 'mhw-v1';

self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', function(e) {
  e.respondWith(
    caches.open(CACHE).then(function(cache) {
      return cache.match(e.request).then(function(cached) {
        var fetched = fetch(e.request).then(function(res) {
          if (res && res.status === 200) cache.put(e.request, res.clone());
          return res;
        }).catch(function() { return cached; });
        return cached || fetched;
      });
    })
  );
});
