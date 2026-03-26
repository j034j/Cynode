/* Cynode PWA service worker (minimal, safe caching). */
const CACHE = "cynode-v5";

// Core shell assets to pre-cache (pathname only — no query strings).
// We store and retrieve by a canonical key (origin + pathname, no search).
const ASSET_PATHS = [
  "/",
  "/pricing",
  "/desktop",
  "/analytics",
  "/index.html",
  "/desktop.html",
  "/analytics.html",
  "/pricing.html",
  "/styles.css",
  "/script.js",
  "/play.js",
  "/play-desktop.js",
  "/analytics.js",
  "/pricing.js",
  "/vendor/chart.umd.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

/** Return a canonical Request with the query string stripped. */
function canonicalReq(req) {
  const url = new URL(req.url);
  url.search = "";
  return new Request(url.toString(), { credentials: req.credentials });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        // Pre-cache using canonical (no-query) URLs so versioned requests hit the cache.
        Promise.all(
          ASSET_PATHS.map((path) =>
            fetch(new Request(self.location.origin + path))
              .then((res) => {
                if (res.ok) {
                  const key = new Request(self.location.origin + path);
                  return c.put(key, res);
                }
              })
              .catch(() => {/* non-fatal: asset may not exist yet */}),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
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
  return (
    url.origin === self.location.origin &&
    (url.pathname.endsWith(".js") ||
      url.pathname.endsWith(".css") ||
      url.pathname.endsWith(".png") ||
      url.pathname.endsWith(".webmanifest") ||
      url.pathname.endsWith(".ico"))
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Cache-first for static assets.
  // IMPORTANT: look up by canonical (no-query) key so ?v= versioning doesn't cause misses.
  if (isAssetRequest(req)) {
    event.respondWith(
      (async () => {
        const canonical = canonicalReq(req);
        const cache = await caches.open(CACHE);

        // Try canonical key first, then the verbatim request as fallback.
        const cached = (await cache.match(canonical)) || (await cache.match(req));
        if (cached) return cached;

        // Not cached — fetch, store under the canonical key, and return.
        try {
          const res = await fetch(req);
          if (res.ok) {
            // Store under canonical so future versioned requests match.
            cache.put(canonical, res.clone());
          }
          return res;
        } catch (networkErr) {
          // Offline & not cached — return a minimal error response instead of
          // letting the promise reject (which triggers the scary SW console error).
          console.warn("[SW] Asset fetch failed (offline?):", req.url, networkErr);
          return new Response("/* offline */", {
            status: 503,
            headers: { "Content-Type": "text/javascript" },
          });
        }
      })(),
    );
    return;
  }

  // Network-first for documents (so shares and auth feel live), fallback to cache.
  const accept = req.headers.get("accept") || "";
  if (accept.includes("text/html")) {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone());
          return res;
        } catch (_) {
          return (
            (await caches.match(req)) ||
            (await caches.match("/")) ||
            new Response("Offline", { status: 200 })
          );
        }
      })(),
    );
  }
});
