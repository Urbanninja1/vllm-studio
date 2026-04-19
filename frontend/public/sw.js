// STARGATE: service worker DISABLED.
//
// Upstream vllm-studio shipped a PWA service worker that aggressively cached
// HTML + JS chunks. On iOS Safari this caused stale UI after our patches.
// Studio is an always-online LAN app — PWA offline caching provides no value.
//
// This stub unregisters itself and purges caches. No fetch interception,
// no navigation (navigating during activate caused iOS reload loops).
// Layout.tsx no longer registers this file either.

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
  })());
});

// Never intercept fetches. Everything goes to network.
self.addEventListener("fetch", () => { /* noop */ });
