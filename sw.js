// Offline shell: the app loads without a connection; job data is always fetched fresh when online.
const CACHE = "jobfinder-v10";
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Network first for everything, falling back to cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && !url.pathname.includes("/api/")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});

// Push alerts, e.g. "Documents ready". Payload: { title, body, url, tag }.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Job Finder", {
    body: d.body || "", tag: d.tag || undefined, icon: "icon.svg", badge: "icon.svg",
    data: { url: d.url || "./" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope);
  if (target.origin !== self.location.origin) return; // only ever open this app
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const key = target.searchParams.get("job");
    for (const w of wins) {
      if (new URL(w.url).pathname.startsWith(new URL(self.registration.scope).pathname)) {
        await w.focus();
        if (key) w.postMessage({ type: "open-job", key });
        return;
      }
    }
    await clients.openWindow(target.href);
  })());
});
