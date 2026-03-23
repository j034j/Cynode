/* Cynode PWA service worker (minimal, safe caching). */
const CACHE = "cynode-v2";
const ASSETS = [
  "/",
  "/pricing",
  "/desktop",
  "/index.html",
  "/desktop.html",
  "/pricing.html",
  "/styles.css",
  "/script.js",
  "/play.js",
  "/pricing.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

function isAssetRequest(req) {
  const url = new URL(req.url);
  return url.origin === self.location.origin && (
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".webmanifest")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Cache-first for static assets.
  if (isAssetRequest(req)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // Network-first for documents (so shares and auth feel live), fallback to cache.
  const accept = req.headers.get("accept") || "";
  if (accept.includes("text/html")) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
        return res;
      } catch (_) {
        return (await caches.match(req)) || (await caches.match("/")) || new Response("Offline", { status: 200 });
      }
    })());
  }
});
