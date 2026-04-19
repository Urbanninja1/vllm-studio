// STARGATE: service worker DISABLED.
//
// Upstream vllm-studio shipped a PWA service worker that aggressively cached
// HTML + JS chunks. On iOS Safari this caused stale UI after our patches —
// users kept seeing the v9-cached pre-Stargate dashboard even after the app
// was updated. Studio is an always-online LAN app; PWA offline caching
// provides no value and creates surprise.
//
// This SW UNREGISTERS ITSELF on install, purges all caches, and claims all
// clients so they load fresh HTML on next navigation.

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => caches.delete(n)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => caches.delete(n)));
    await self.clients.claim();
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: "window" });
    for (const client of clients) {
      client.navigate(client.url);  // force reload each open tab
    }
  })());
});

// Never intercept fetches. Everything goes to network.
self.addEventListener("fetch", () => { /* noop */ });
