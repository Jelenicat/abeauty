// public/service-worker.js
self.addEventListener('install', (event) => {
  // čim se instalira, preuzmi mesto starom SW-u
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // odmah preuzmi sve otvorene tabove
  event.waitUntil(self.clients.claim());
});
