// Service worker: keeps the kiosk app itself available offline.
// Network first (so updates arrive), cache as fallback. API calls and photos are
// handled by the page, not here.
const SHELL = "shell-v1";
const FILES = [
	"/",
	"/app/app.js",
	"/app/style.css",
	"/app/shared/words.js",
	"/app/shared/doses.js",
	"/fonts/atkinson-400.woff2",
	"/fonts/atkinson-700.woff2",
	"/icon.svg",
	"/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k.startsWith("shell-") && k !== SHELL).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== "GET" || url.origin !== location.origin) return;
	if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin") || url.pathname.startsWith("/oauth/")) return;
	const key = event.request.mode === "navigate" ? "/" : url.pathname;
	event.respondWith(
		(async () => {
			const cache = await caches.open(SHELL);
			try {
				const ctrl = new AbortController();
				const timer = setTimeout(() => ctrl.abort(), 5000);
				const res = await fetch(event.request, { signal: ctrl.signal });
				clearTimeout(timer);
				if (res.ok) cache.put(key, res.clone());
				return res;
			} catch {
				const hit = await cache.match(key);
				return hit ?? Response.error();
			}
		})(),
	);
});
