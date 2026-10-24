/* Horyzont — service worker: offline shell + obsługa web push */

const VERSION = 'horyzont-v1';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/fonts/instrument-sans-latin.woff2',
  '/fonts/instrument-sans-latin-ext.woff2',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/badge.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(request, res.clone())).catch(() => {});
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

/* ------------------------------------------------------------------ push */

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }

  const title = data.title || 'Oderwij wzrok';
  const body = data.body || '20 sekund patrzenia w dal.';
  const breakSec = Number(data.breakSec) || 20;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: data.tag || 'horyzont-gaze',
      renotify: false,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge.png',
      vibrate: data.vibrate || [70, 60, 70],
      timestamp: Date.now(),
      data: { url: data.url || '/?focus=1', breakSec },
      actions: [{ action: 'gaze', title: `Patrz w dal ${breakSec} s` }],
      silent: false
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/?focus=1';

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = all.find((c) => new URL(c.url).origin === location.origin);
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: 'horyzont:gaze' });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) client.postMessage({ type: 'horyzont:resubscribe' });
  })());
});
