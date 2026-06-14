// ============================================================
//  El Ashry Pro - Service Worker v4.0 - PWA احترافي
//  إصلاح المسارات لتعمل على GitHub Pages
// ============================================================

const APP_VERSION   = 'v4.0';
const CACHE_NAME    = `el-ashry-pro-${APP_VERSION}`;
const STATIC_CACHE  = `el-ashry-static-${APP_VERSION}`;
const DYNAMIC_CACHE = `el-ashry-dynamic-${APP_VERSION}`;

// تحديد المسار الأساسي تلقائياً (يعمل على الجذر وعلى المسارات الفرعية مثل GitHub Pages)
const BASE_PATH = self.location.pathname.replace(/\/sw\.js$/, '');

const STATIC_ASSETS = [
  `${BASE_PATH}/`,
  `${BASE_PATH}/index.html`,
  `${BASE_PATH}/manifest.json`,
  `${BASE_PATH}/sw.js`
];

// ===== Install Event =====
self.addEventListener('install', (event) => {
  console.log(`[SW] Installing ${APP_VERSION}... BASE_PATH=${BASE_PATH}`);
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(e => console.warn('[SW] Failed to cache:', url, e))
        )
      );
    }).then(() => {
      console.log('[SW] Static cache complete');
      return self.skipWaiting();
    })
  );
});

// ===== Activate Event =====
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter(name => name !== STATIC_CACHE && name !== DYNAMIC_CACHE)
          .map(name => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ===== Fetch Event - Stale While Revalidate =====
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip Firebase, external APIs, chrome extensions
  if (url.hostname.includes('firebase') ||
      url.hostname.includes('firebaseio') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('gstatic.com') ||
      url.protocol === 'chrome-extension:') {
    return;
  }

  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(DYNAMIC_CACHE).then(cache => cache.put(event.request, clone));
        }
        return networkResponse;
      }).catch(() => cached);

      return cached || networkFetch;
    })
  );
});

// ===== Background Sync =====
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-cases') {
    event.waitUntil(Promise.resolve());
  }
});

// ===== Push Notifications =====
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const options = {
    body:    data.body    || 'لديك إشعار جديد من El Ashry Pro',
    icon:    `${BASE_PATH}/icons/icon-192x192.png`,
    badge:   `${BASE_PATH}/icons/icon-72x72.png`,
    dir:     'rtl',
    lang:    'ar',
    vibrate: [100, 50, 100],
    tag:     'el-ashry-notification',
    renotify: true,
    data:    { url: data.url || `${BASE_PATH}/` },
    actions: [
      { action: 'open',  title: '📋 فتح التطبيق' },
      { action: 'close', title: 'إغلاق' }
    ]
  };
  event.waitUntil(
    self.registration.showNotification(data.title || 'El Ashry Pro', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'open' || !event.action) {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
        for (const client of windowClients) {
          if ('focus' in client) return client.focus();
        }
        if (clients.openWindow) return clients.openWindow(`${BASE_PATH}/`);
      })
    );
  }
});

// ===== Message Handling =====
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING')  self.skipWaiting();
  if (event.data?.type === 'GET_VERSION')   event.ports[0]?.postMessage({ version: APP_VERSION });
});
