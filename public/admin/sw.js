// Admin page service worker. Its one job: when Gary shares photos to "Mary's kiosk" from
// his phone, keep them in a cache and open the admin page, which shrinks and uploads them.
// Keeping them here first means nothing is lost if he has to sign in again on the way.
const INBOX = "share-inbox";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== "POST" || url.pathname !== "/admin/share") return;
	event.respondWith(
		(async () => {
			try {
				const form = await event.request.formData();
				const cache = await caches.open(INBOX);
				const stamp = Date.now();
				let i = 0;
				for (const f of form.getAll("file")) {
					if (!(f instanceof File) || !f.size) continue;
					const headers = { "Content-Type": f.type || "application/octet-stream", "X-Name": encodeURIComponent(f.name || "photo") };
					await cache.put(`/admin/__inbox/${stamp}-${String(i++).padStart(4, "0")}`, new Response(f, { headers }));
				}
			} catch {
				/* the page reports what arrived */
			}
			return Response.redirect("/admin/?shared=1#photos", 303);
		})(),
	);
});
