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
	const syncBad = data.sync.fail_count > 0 || (data.calendar_source === "google" && !data.google_connected);
	$("#status-grid").replaceChildren(
		stat("Kiosk last checked in", hb ? `${ago(hb.last_seen)} (v${hb.app_version || "?"})` : "not set up yet", offline ? "bad" : "good"),
		stat(
			"Calendar",
			data.calendar_source === "mock"
				? "Mock events (CALENDAR_SOURCE=mock)"
				: data.google_connected
					? `Synced ${ago(data.sync.last_ok)}${data.sync.fail_count ? ` · ${data.sync.fail_count} failures: ${data.sync.last_error}` : ""}`
					: "Not connected",
			syncBad ? "bad" : "good",
		),
		stat("Alerts go to", data.alert_provider === "pushover" ? "Pushover" : "ntfy"),
		stat("Server version", data.app_version),
	);
	$("#google-connect").hidden = data.calendar_source === "mock";
	$("#google-connect").textContent = data.google_connected ? "Reconnect Google Calendar" : "Connect Google Calendar";
	$("#google-disconnect").hidden = !data.google_connected;
	$("#subtitle").textContent = `Mary's time: ${fmtFull(data.now)} (${data.timezone})`;
	$("#tz").textContent = data.timezone;
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
			json: { lookahead_days: Number($("#s-look").value), morning_show: $("#s-morning").value, preevent_min: Number($("#s-pre").value) },
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
$("#upload").addEventListener("submit", async (ev) => {
	ev.preventDefault();
	const form = ev.target;
	await api("/photos", { method: "POST", body: new FormData(form) });
	form.reset();
	toast("Uploaded");
	load();
});

const google = new URLSearchParams(location.search).get("google");
if (google) {
	toast(google === "connected" ? "Google Calendar connected" : `Google: ${google}`);
	history.replaceState(null, "", "/admin/");
}

load();
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
