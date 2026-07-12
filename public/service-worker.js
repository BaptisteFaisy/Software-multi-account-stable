const CACHE_PREFIX = "codex-terminal-static-";
const CACHE_NAME = `${CACHE_PREFIX}v5-environment-delete`;
const PRECACHE_URLS = [
  "/offline.html",
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/icons/pwa-192.png",
  "/icons/pwa-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

const isPrivateApplicationRequest = (url) =>
  url.pathname.startsWith("/api/")
  || url.pathname.startsWith("/ws/")
  || url.pathname === "/mcp";

const cachedStaticAsset = async (request) => {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isPrivateApplicationRequest(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
    return;
  }

  if (
    url.pathname.startsWith("/assets/")
    || url.pathname.startsWith("/icons/")
    || url.pathname === "/apple-touch-icon.png"
    || url.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(cachedStaticAsset(request));
  }
});
