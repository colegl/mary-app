// Admin page for Gary. Sits behind Cloudflare Access; requests carry the Access cookie.

let data = null;
const $ = (s) => document.querySelector(s);

function h(tag, attrs = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === null || v === false) continue;
		if (k === "class") el.className = v;
		else if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
		else if (k in el && typeof v !== "string") el[k] = v;
		else el.setAttribute(k, v === true ? "" : v);
	}
	for (const c of children.flat()) {
		if (c === null || c === undefined || c === false) continue;
		el.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return el;
}

function toast(msg) {
	const t = $("#toast");
	t.textContent = msg;
	t.classList.add("on");
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => t.classList.remove("on"), 3500);
}

async function api(path, opts = {}) {
	const init = { ...opts };
	if (opts.json !== undefined) {
		init.method ??= "POST";
		init.headers = { "Content-Type": "application/json" };
		init.body = JSON.stringify(opts.json);
	}
	const res = await fetch(`/api/admin${path}`, init);
	if (res.status === 403) {
		// Session ended: back to the sign-in page.
		location.href = "/admin/login";
		throw new Error("signed out");
	}
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(body.error ?? `${res.status}`);
	return body;
}

const fmt = (ms, opts) =>
	ms ? new Intl.DateTimeFormat("en-US", { timeZone: data.timezone, ...opts }).format(new Date(ms)) : "";
const fmtTime = (ms) => fmt(ms, { hour: "numeric", minute: "2-digit" });
const fmtDay = (ms) => fmt(ms, { weekday: "short", month: "short", day: "numeric" });
const fmtFull = (ms) => fmt(ms, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function ago(ms) {
	if (!ms) return "never";
	const m = Math.round((Date.now() - ms) / 60000);
	if (m < 1) return "just now";
	if (m < 60) return `${m} min ago`;
	const hrs = Math.round(m / 60);
	return hrs < 48 ? `${hrs} h ago` : `${Math.round(hrs / 24)} days ago`;
}

function stat(k, v, cls = "") {
	return h("div", { class: `stat ${cls}` }, h("div", { class: "k" }, k), h("div", { class: "v" }, v));
}

function renderStatus() {
	const hb = data.heartbeats[0];
	const offline = !hb || Date.now() - hb.last_seen > 15 * 60000;
	const syncBad = data.sync.fail_count > 0 || data.calendar_source === "none";
	$("#status-grid").replaceChildren(
		stat("Kiosk last checked in", hb ? `${ago(hb.last_seen)} (v${hb.app_version || "?"})` : "not set up yet", offline ? "bad" : "good"),
		stat(
			"Calendar",
			data.calendar_source === "mock"
				? "Mock events (CALENDAR_SOURCE=mock)"
				: data.calendar_source === "none"
					? "Not connected yet (see Calendar below)"
					: `Synced ${ago(data.sync.last_ok)}${data.sync.fail_count ? ` · ${data.sync.fail_count} failures: ${data.sync.last_error}` : ""}`,
			syncBad ? "bad" : "good",
		),
		stat("Alerts go to", data.alert_provider === "pushover" ? "Pushover" : "ntfy"),
		stat("Server version", data.app_version),
	);
	// Google sign-in is the advanced route, offered only when its keys are set up.
	$("#google-connect").hidden = !data.google_available || data.calendar_source === "ical" || data.calendar_source === "mock";
	$("#google-connect").textContent = data.google_connected ? "Reconnect Google sign-in" : "Connect with Google sign-in";
	$("#google-disconnect").hidden = !data.google_connected;
	$("#sync-now").hidden = data.calendar_source === "none";
	renderCalendar();
	$("#subtitle").textContent = `Mary's time: ${fmtFull(data.now)} (${data.timezone})`;
	$("#tz").textContent = data.timezone;
}

let calEditing = false;
function renderCalendar() {
	const set = data.calendar_source === "ical";
	$("#cal-setup").hidden = set && !calEditing;
	$("#cal-done").hidden = !set || calEditing;
	if (set) {
		const next = data.events.filter((e) => !e.hidden).length;
		$("#cal-summary").textContent = data.sync.fail_count
			? `Connected, but the last ${data.sync.fail_count} syncs failed: ${data.sync.last_error}`
			: `Connected. Last synced ${ago(data.sync.last_ok)}. ${next} "(Mary)" event${next === 1 ? "" : "s"} coming up (listed under Events).`;
	}
}

function doseStatus(d) {
	if (d.confirmed_at) {
		const who = d.confirmed_by === "admin" ? "marked done by you" : "Mary tapped";
		const late = d.received_at && d.received_at - d.confirmed_at > 5 * 60000 ? ` (arrived ${fmtTime(d.received_at)})` : "";
		return `✓ ${who} at ${fmtTime(d.confirmed_at)}${late}`;
	}
	if (d.skipped_at) return `Skipped at ${fmtTime(d.skipped_at)}`;
	const now = Date.now();
	if (now < d.due_at) return "Upcoming";
	const parts = [];
	if (now < d.expires_at) parts.push("Reminder showing");
	else parts.push("Not confirmed");
	if (d.alerted_at) parts.push(`you were alerted at ${fmtTime(d.alerted_at)}`);
	return parts.join(" · ");
}

function renderPhone() {
	const n = data.ntfy;
	$("#phone").hidden = !n;
	if (!n) return;
	$("#ntfy-app").href = n.app;
	$("#ntfy-topic").textContent = n.topic;
}

function renderDoses() {
	const rows = data.doses.map((d) => {
		const open = !d.confirmed_at && !d.skipped_at;
		const act = (action) => async () => {
			await api(`/dose/${encodeURIComponent(d.id)}/${action}`, { json: {} });
			toast(action === "done" ? "Marked done" : action === "skip" ? "Marked skipped" : "Reopened");
			load();
		};
		const missed = open && Date.now() >= d.alert_at;
		return h(
			"tr",
			{ class: missed ? "bad" : "" },
			h("td", {}, fmtDay(d.due_at)),
			h("td", {}, d.dose === "test" ? "test (dry run)" : d.dose),
			h("td", {}, fmtTime(d.due_at)),
			h("td", {}, doseStatus(d)),
			h(
				"td",
				{ class: "row" },
				open ? h("button", { on: { click: act("done") } }, "Mark done") : null,
				open ? h("button", { on: { click: act("skip") } }, "Skip") : null,
				!open && (d.skipped_at || d.confirmed_by === "admin") ? h("button", { on: { click: act("reopen") } }, "Undo") : null,
			),
		);
	});
	$("#doses tbody").replaceChildren(...(rows.length ? rows : [h("tr", {}, h("td", { colspan: 5, class: "muted" }, "No doses yet. Turn on a dose in the schedule below."))]));
}

function renderSchedule() {
	const names = { morning: "Morning", noon: "Noon", evening: "Evening" };
	const rows = data.schedule.map((s) => {
		const on = h("input", { type: "checkbox", checked: Boolean(s.enabled) });
		const time = h("input", { type: "time", value: s.time });
		const again = h("input", { type: "number", value: s.remind_again_min, min: 5, max: 180 });
		const win = h("input", { type: "number", value: s.window_min, min: 5, max: 240 });
		const exp = h("input", { type: "number", value: s.expire_min, min: 5, max: 600 });
		const preview = s.pillbox_photo
			? h("img", { class: "pillbox", src: `/api/admin/r2?key=${encodeURIComponent(s.pillbox_photo)}`, alt: `${s.dose} compartment` })
			: h("span", { class: "muted" }, "none");
		const file = h("input", { type: "file", accept: "image/*", style: "max-width:180px" });
		file.addEventListener("change", async () => {
			if (!file.files?.[0]) return;
			const fd = new FormData();
			fd.append("file", file.files[0]);
			await api(`/schedule/${s.dose}/photo`, { method: "POST", body: fd });
			toast("Pillbox photo saved");
			load();
		});
		const save = h(
			"button",
			{
				class: "primary",
				on: {
					click: async () => {
						try {
							await api(`/schedule/${s.dose}`, {
								json: {
									enabled: on.checked,
									time: time.value,
									remind_again_min: Number(again.value),
									window_min: Number(win.value),
									expire_min: Number(exp.value),
								},
							});
							toast(`${names[s.dose]} dose saved`);
							load();
						} catch (e) {
							toast(String(e.message));
						}
					},
				},
			},
			"Save",
		);
		return h(
			"tr",
			{},
			h("td", {}, names[s.dose] ?? s.dose),
			h("td", {}, on),
			h("td", {}, time),
			h("td", {}, again, " min"),
			h("td", {}, win, " min"),
			h("td", {}, exp, " min"),
			h("td", { class: "row" }, preview, file),
			h("td", {}, save),
		);
	});
	$("#schedule tbody").replaceChildren(...rows);
}

function renderEvents() {
	const rows = data.events.map((e) => {
		const text = h("input", { class: "event-text", value: e.display_text ?? "", placeholder: e.title, maxlength: 200 });
		text.addEventListener("change", async () => {
			await api(`/events/${encodeURIComponent(e.id)}`, { json: { display_text: text.value } });
			toast("Saved");
		});
		const hide = h("input", { type: "checkbox", checked: Boolean(e.hidden) });
		hide.addEventListener("change", async () => {
			await api(`/events/${encodeURIComponent(e.id)}`, { json: { hidden: hide.checked } });
			toast(hide.checked ? "Hidden from Mary" : "Shown to Mary");
		});
		const when = e.all_day ? `${fmtDay(e.start_at)} · sometime that day` : `${fmtDay(e.start_at)} · ${fmtTime(e.start_at)}${e.end_at ? `–${fmtTime(e.end_at)}` : ""}`;
		return h("tr", {}, h("td", {}, when), h("td", {}, e.title), h("td", {}, text), h("td", {}, hide));
	});
	$("#events tbody").replaceChildren(...(rows.length ? rows : [h("tr", {}, h("td", { colspan: 4, class: "muted" }, 'No upcoming "(Mary)" events.'))]));
}

function renderPhotos() {
	const cards = data.photos.map((p) => {
		const cap = h("input", { value: p.caption, placeholder: "Caption", maxlength: 120 });
		const ppl = h("input", { value: p.people, placeholder: "People", maxlength: 200 });
		const active = h("input", { type: "checkbox", checked: Boolean(p.active) });
		const save = async (json, msg) => {
			await api(`/photos/${p.id}`, { json });
			toast(msg);
		};
		cap.addEventListener("change", () => save({ caption: cap.value }, "Caption saved"));
		ppl.addEventListener("change", () => save({ people: ppl.value }, "People saved"));
		active.addEventListener("change", () => save({ active: active.checked }, active.checked ? "Showing on the kiosk" : "Hidden from the kiosk").then(load));
		const del = h(
			"button",
			{
				on: {
					click: async () => {
						if (!confirm("Delete this photo for good?")) return;
						await api(`/photos/${p.id}`, { method: "DELETE" });
						toast("Deleted");
						load();
					},
				},
			},
			"Delete",
		);
		return h(
			"div",
			{ class: `photo${p.active ? "" : " off"}` },
			h("img", { src: `/api/admin/r2?key=${encodeURIComponent(p.r2_key)}`, alt: p.caption, loading: "lazy" }),
			h("div", { class: "f" }, cap, ppl, h("div", { class: "row" }, h("label", {}, active, "Show"), del)),
		);
	});
	$("#photos").replaceChildren(...(cards.length ? cards : [h("p", { class: "muted" }, "No photos yet.")]));
}

function renderSettings() {
	$("#s-look").value = String(data.settings.lookahead_days >= 7 ? 7 : 3);
	$("#s-morning").value = data.settings.morning_show;
	$("#s-pre").value = data.settings.preevent_min;
	$("#s-night").checked = data.settings.night.on;
	$("#s-night-start").value = data.settings.night.start;
	$("#s-night-end").value = data.settings.night.end;
}

function renderAlerts() {
	const rows = data.alerts.map((a) =>
		h("tr", {}, h("td", {}, fmtFull(a.at)), h("td", {}, a.kind), h("td", {}, a.message), h("td", {}, a.delivered ? "yes" : `no (${a.detail})`)),
	);
	$("#alerts tbody").replaceChildren(...(rows.length ? rows : [h("tr", {}, h("td", { colspan: 4, class: "muted" }, "No alerts yet."))]));
}

async function load() {
	try {
		data = await api("/overview");
	} catch (e) {
		$("#subtitle").textContent = `Couldn't load: ${e.message}`;
		return;
	}
	renderStatus();
	renderPhone();
	renderDoses();
	renderSchedule();
	renderEvents();
	renderPhotos();
	renderSettings();
	renderAlerts();
}

$("#ntfy-copy").addEventListener("click", async () => {
	try {
		await navigator.clipboard.writeText(data.ntfy.topic);
		toast("Copied");
	} catch {
		toast("Couldn't copy; press and hold the name to copy it");
	}
});
$("#test-alert-2").addEventListener("click", () => $("#test-alert").click());
$("#test-alert").addEventListener("click", async () => {
	const r = await api("/test-alert", { json: {} });
	toast(r.ok ? "Test alert sent. Check your phone." : "Alert didn't go through. See Recent alerts.");
	load();
});
$("#sync-now").addEventListener("click", async () => {
	const r = await api("/sync", { json: {} });
	toast(r.ok ? "Calendar synced" : `Sync failed: ${r.error}`);
	load();
});
$("#ical-save").addEventListener("click", async () => {
	const url = $("#ical-url").value.trim();
	const out = $("#cal-result");
	out.hidden = false;
	out.className = "";
	if (!url) {
		out.textContent = "The box is empty. Paste the address first.";
		return;
	}
	$("#ical-save").disabled = true;
	out.textContent = "Checking the address…";
	try {
		const r = await api("/calendar-url", { json: { url } });
		$("#ical-url").value = "";
		calEditing = false;
		out.className = "good stat";
		out.textContent = r.found
			? `It works. Found ${r.found} "(Mary)" event${r.found === 1 ? "" : "s"} in the next week, starting with: ${r.upcoming.map((e) => `${fmtDay(e.start_at)} ${e.title}`).join("; ")}.`
			: `It works, and the kiosk is now reading your calendar. There are no "(Mary)" events in the next week yet. Add one in Google Calendar, for example "(Mary) Molly visits", and it will show up here within 15 minutes.`;
		load();
	} catch (e) {
		out.className = "bad stat";
		out.textContent = `Not saved: ${e.message}`;
	} finally {
		$("#ical-save").disabled = false;
	}
});
$("#ical-change").addEventListener("click", () => {
	calEditing = true;
	$("#cal-result").hidden = true;
	renderCalendar();
	$("#ical-url").focus();
});
$("#google-disconnect").addEventListener("click", async () => {
	if (!confirm("Disconnect Google Calendar? The kiosk keeps the events it has.")) return;
	await api("/google/disconnect", { json: {} });
	load();
});
$("#test-dose").addEventListener("click", async () => {
	await api("/test-dose", {
		json: {
			in_min: Number($("#t-in").value),
			remind_again_min: Number($("#t-again").value),
			alert_min: Number($("#t-alert").value),
			expire_min: Number($("#t-expire").value),
		},
	});
	toast("Test dose scheduled. The kiosk picks it up within a minute.");
	load();
});
$("#test-cancel").addEventListener("click", async () => {
	await api("/test-dose/cancel", { json: {} });
	toast("Test doses cancelled");
	load();
});
$("#save-settings").addEventListener("click", async () => {
	try {
		await api("/settings", {
			json: {
				lookahead_days: Number($("#s-look").value),
				morning_show: $("#s-morning").value,
				preevent_min: Number($("#s-pre").value),
				night_on: $("#s-night").checked,
				night_start: $("#s-night-start").value,
				night_end: $("#s-night-end").value,
			},
		});
		toast("Settings saved");
	} catch (e) {
		toast(String(e.message));
	}
});
$("#show-link").addEventListener("click", async () => {
	const r = await api("/kiosk-link");
	$("#kiosk-link").textContent = r.url;
});
// ---------- Adding photos ----------

const MAX_EDGE = 2400; // the Chromebook's screen is 2256 × 1504
const status = (msg, cls = "") => {
	const el = $("#upload-status");
	el.hidden = !msg;
	el.className = `stat ${cls}`;
	el.textContent = msg;
};

async function sha256(blob) {
	const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A JPEG no bigger than the kiosk screen, turned the right way up. Falls back to the original. */
async function shrink(file) {
	try {
		const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
		const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
		if (scale === 1 && file.type === "image/jpeg" && file.size < 1.5e6) return file;
		const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
		canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
		bmp.close();
		const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
		return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
	} catch {
		return ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type) ? file : null;
	}
}

/** Uploads one at a time with progress. onEach(i) runs after file i is safely stored (or skipped). */
async function addPhotos(files, { caption = "", people = "", onEach = async () => {} } = {}) {
	let added = 0, dupes = 0, unreadable = 0, failed = 0;
	for (const [i, file] of files.entries()) {
		status(`Adding photo ${i + 1} of ${files.length}… keep this page open.`);
		try {
			const small = await shrink(file);
			if (!small) {
				unreadable++;
				await onEach(i);
				continue;
			}
			const fd = new FormData();
			fd.append("file", small);
			fd.append("hash", await sha256(file));
			fd.append("caption", caption);
			fd.append("people", people);
			const r = await api("/photos", { method: "POST", body: fd });
			added += r.ids.length;
			dupes += r.duplicates ?? 0;
			await onEach(i);
		} catch (e) {
			if (e.message === "signed out") throw e;
			failed++;
		}
	}
	const parts = [];
	if (added || !dupes) parts.push(`Added ${added} photo${added === 1 ? "" : "s"} to the kiosk.`);
	if (dupes) parts.push(added ? `${dupes} ${dupes === 1 ? "was" : "were"} already there.` : `${dupes === 1 ? "That photo is" : `Those ${dupes} photos are`} already on the kiosk.`);
	if (unreadable) parts.push(`${unreadable} couldn't be read (not a photo this browser can open).`);
	if (failed) parts.push(`${failed} didn't upload because the connection dropped. Open this page again to retry.`);
	if (added) parts.push("They're at the top of the list below, if you'd like to add captions.");
	status(parts.join(" "), failed || unreadable ? "bad" : "good");
	await load();
	$("#photos-section").scrollIntoView({ behavior: "smooth" });
}

$("#upload input[type=file]").addEventListener("change", async (ev) => {
	const files = [...ev.target.files];
	if (!files.length) return;
	const form = $("#upload");
	await addPhotos(files, { caption: form.caption.value.trim(), people: form.people.value.trim() });
	form.reset();
});
$("#upload").addEventListener("submit", (ev) => ev.preventDefault());

/** Photos shared from the phone wait in the service worker's cache until they're uploaded. */
async function processInbox() {
	if (!("caches" in window)) return;
	const cache = await caches.open("share-inbox");
	const keys = (await cache.keys()).sort((a, b) => a.url.localeCompare(b.url));
	if (!keys.length) return;
	const files = [];
	for (const req of keys) {
		const res = await cache.match(req);
		const blob = await res.blob();
		files.push(new File([blob], decodeURIComponent(res.headers.get("X-Name") || "photo"), { type: blob.type }));
	}
	await addPhotos(files, { onEach: (i) => cache.delete(keys[i]) });
}

// One-time install, so "Mary's kiosk" appears in the phone's Share menu.
let installPrompt = null;
const standalone = matchMedia("(display-mode: standalone)").matches;
function showInstall() {
	$("#install-done").hidden = !standalone;
	$("#install-ready").hidden = standalone || !installPrompt;
	$("#install-manual").hidden = standalone || Boolean(installPrompt);
}
window.addEventListener("beforeinstallprompt", (e) => {
	e.preventDefault();
	installPrompt = e;
	showInstall();
});
window.addEventListener("appinstalled", () => {
	installPrompt = null;
	$("#install-ready").hidden = true;
	$("#install-manual").hidden = true;
	$("#install-done").hidden = false;
});
$("#install").addEventListener("click", async () => {
	if (!installPrompt) return;
	installPrompt.prompt();
	await installPrompt.userChoice;
	installPrompt = null;
	showInstall();
});
showInstall();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/admin/sw.js", { scope: "/admin/" }).catch(() => {});

{
	const q = new URLSearchParams(location.search);
	const n = q.get("added");
	if (n !== null) status(`Added ${n} photo${n === "1" ? "" : "s"} to the kiosk.`, "good");
	if (n !== null || q.has("shared")) history.replaceState(null, "", "/admin/" + location.hash);
}

const google = new URLSearchParams(location.search).get("google");
if (google) {
	toast(google === "connected" ? "Google Calendar connected" : `Google: ${google}`);
	history.replaceState(null, "", "/admin/");
}

load().then(processInbox);
// Refresh only the read-only parts, so an edit in progress isn't wiped.
setInterval(async () => {
	try {
		data = await api("/overview");
		renderStatus();
		renderDoses();
		renderAlerts();
	} catch {
		/* try again next minute */
	}
}, 60000);
