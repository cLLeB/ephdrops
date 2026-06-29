'use strict';

const CACHE_NAME  = 'ephchat-shell-v2';
const OFFLINE_URL = '/offline.html';

// Assets cached at install time — must all be present for the SW to activate
const PRECACHE = [
  OFFLINE_URL,
  '/logo.svg',
  '/icons/app-192.png',
];

// ── Install: cache offline shell ─────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: purge old caches ───────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only intercept GET requests to our own origin
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Navigation: try network first, fall through to cached page, then offline
    event.respondWith(
      fetch(request)
        .catch(() =>
          caches.match(request)
            .then((cached) => cached || caches.match(OFFLINE_URL))
        )
    );
    return;
  }

  // Precached static assets: cache-first
  if (PRECACHE.some((path) => url.pathname === path)) {
    event.respondWith(
      caches.match(request)
        .then((cached) => cached || fetch(request).then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, clone));
          return res;
        }))
    );
  }
});
