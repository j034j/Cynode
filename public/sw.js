/* Cynode PWA service worker (minimal, safe caching). */
const CACHE = "cynode-v9";

// Core shell assets to pre-cache (pathname only; no query strings).
// We store and retrieve by a canonical key (origin + pathname, no search).
const ASSET_PATHS = [
  "/",
  "/account",
  "/pricing",
  "/desktop",
  "/analytics",
  "/account.html",
  "/index.html",
  "/desktop.html",
  "/analytics.html",
  "/pricing.html",
  "/account.js",
  "/styles.css",
  "/qrcode-node.js",
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

function isCacheableAssetResponse(req, res) {
  if (!res || !res.ok) return false;

  const url = new URL(req.url);
  const contentType = String(res.headers.get("content-type") || "").toLowerCase();

  if (url.pathname.endsWith(".js")) return contentType.includes("javascript");
  if (url.pathname.endsWith(".css")) return contentType.includes("text/css");
  if (url.pathname.endsWith(".webmanifest")) {
    return contentType.includes("application/manifest+json") || contentType.includes("application/json");
  }
  if (url.pathname.endsWith(".png")) return contentType.includes("image/png");
  if (url.pathname.endsWith(".ico")) {
    return contentType.includes("image/x-icon") || contentType.includes("image/vnd.microsoft.icon");
  }

  return true;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        Promise.all(
          ASSET_PATHS.map((path) => {
            const req = new Request(self.location.origin + path);
            return fetch(req)
              .then((res) => {
                if (isCacheableAssetResponse(req, res)) {
                  return cache.put(req, res);
                }
                return undefined;
              })
              .catch(() => {
                // Non-fatal: asset may not exist yet or network may be unavailable.
              });
          }),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
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

  // Network-first for static assets so stale/broken cached JS/CSS/manifest files
  // are repaired as soon as the browser is online again.
  if (isAssetRequest(req)) {
    event.respondWith(
      (async () => {
        const canonical = canonicalReq(req);
        const cache = await caches.open(CACHE);

        try {
          const res = await fetch(req);
          if (isCacheableAssetResponse(req, res)) {
            cache.put(canonical, res.clone());
          }
          return res;
        } catch (networkErr) {
          const cached = (await cache.match(canonical)) || (await cache.match(req));
          if (cached) return cached;

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
