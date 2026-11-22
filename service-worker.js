const CACHE_NAME = 'zawadi-gift-shop-v5';
const ASSETS = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('push', (event) => {
  let payload = {
    title: 'Zawadi Gift Shop · Order update',
    body: 'Your order status has been updated.',
    tag: 'zawadi-order-update',
    url: './#orders'
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') {
        payload = {
          title: typeof parsed.title === 'string' && parsed.title ? parsed.title : payload.title,
          body: typeof parsed.body === 'string' && parsed.body ? parsed.body : payload.body,
          tag: typeof parsed.tag === 'string' && parsed.tag ? parsed.tag : payload.tag,
          url: typeof parsed.url === 'string' && parsed.url ? parsed.url : payload.url,
          orderId: parsed.orderId || null,
          status: parsed.status || null
        };
      }
    } catch {
      const text = event.data.text();
      if (text) payload.body = text;
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: './icon.svg',
      badge: './icon.svg',
      tag: payload.tag,
      renotify: true,
      data: {
        url: payload.url,
        orderId: payload.orderId,
        status: payload.status
      }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || './#orders', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate?.(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isCacheableAsset = ['font', 'image', 'manifest', 'script', 'style'].includes(request.destination);
  if (request.mode !== 'navigate' && !isCacheableAsset) return;
  if (!isSameOrigin && !isCacheableAsset) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put('./index.html', response.clone());
        }
        return response;
      } catch (error) {
        const cachedPage = await caches.match('./index.html');
        if (cachedPage) return cachedPage;
        throw error;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) return cachedResponse;

    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
