// Mary's kiosk. One page, six screens: frame (home), menu, today, coming up, reminder, done.
//
// Rules from the spec, enforced here:
//  - Day, part of day, date and time are on every screen.
//  - At most three big buttons; no scrolling or swiping.
//  - Every screen Mary opens goes back to the frame after 60 s without a touch.
//  - The medication reminder interrupts anything, and stays until it's tapped or the dose window ends.
//  - Mary never sees an error: everything falls back to the last good data in local storage.

import {
	capitalize,
	clockText,
	dayAndPart,
	dayLabel,
	doseWords,
	isNight,
	localParts,
	monthDay,
	rangeWords,
	timeWords,
	weekdayName,
} from "./shared/words.js";
import { activeReminder, chimeKey, doseState, isClosed, stripStatus } from "./shared/doses.js";

const APP_VERSION = "0.2.0";
const SEC = 1000;
const MIN = 60 * SEC;
const IDLE_MS = 60 * SEC;
const DONE_MS = 10 * SEC;
const PHOTO_MS = 30 * SEC;
const STATE_MS = 1 * MIN;
const PHOTOS_LIST_MS = 5 * MIN;
const HEARTBEAT_MS = 5 * MIN;
const MAX_TODAY_ROWS = 5;
const MAX_COMING_CARDS = 4;
const NIGHT_AWAKE_MS = 15 * SEC; // a tap at night shows the message this long

// ---------- Local storage (never throws) ----------

const store = {
	get(key, fallback) {
		try {
			const v = localStorage.getItem(`kiosk.${key}`);
			return v === null ? fallback : JSON.parse(v);
		} catch {
			return fallback;
		}
	},
	set(key, value) {
		try {
			localStorage.setItem(`kiosk.${key}`, JSON.stringify(value));
		} catch {
			/* storage full or blocked: carry on in memory */
		}
	},
};

// One-time setup: open https://<worker>/#setup=<KIOSK_TOKEN> on the Chromebook.
(() => {
	const hash = new URLSearchParams(location.hash.slice(1));
	const setup = hash.get("setup");
	if (setup) {
		store.set("token", setup);
		history.replaceState(null, "", "/");
	}
})();

let deviceId = store.get("device_id", "");
if (!deviceId) {
	deviceId = `kiosk-${Math.random().toString(36).slice(2, 10)}`;
	store.set("device_id", deviceId);
}

let state = store.get("state", null); // last good /api/state
let photos = store.get("photos", []); // last good /api/photos list
// Photos Gary just added are shown next, once each, before the slideshow carries on.
let seenPhotos = store.get("seenPhotos", null); // ids already on this kiosk; null until the first list arrives
let freshPhotos = store.get("freshPhotos", []); // ids waiting for their first showing
let pending = store.get("pending", {}); // doseId -> tapped_at, not yet acknowledged by the server
let chimed = store.get("chimed", {}); // chime key -> time played
let shown = store.get("shown", {}); // proactive Today shows already done: key -> time

const token = () => store.get("token", "");
const tz = () => state?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
const doses = () => state?.doses ?? [];
const events = () => state?.events ?? [];

// ---------- Network (failures are silent) ----------

async function api(path, init = {}) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 15 * SEC);
	try {
		const res = await fetch(path, {
			...init,
			signal: ctrl.signal,
			headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
		});
		if (!res.ok) throw new Error(`${path} ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

async function refreshState() {
	if (!token()) return;
	try {
		const s = await api("/api/state");
		state = s;
		store.set("state", s);
		onDataChanged();
	} catch {
		/* keep showing the cached state */
	}
}

function noteNewPhotos() {
	const ids = photos.map((p) => p.id);
	if (seenPhotos === null) {
		seenPhotos = ids; // first run: everything counts as already seen
	} else {
		const known = new Set([...seenPhotos, ...freshPhotos]);
		for (const id of ids) if (!known.has(id)) freshPhotos.push(id);
		const live = new Set(ids);
		seenPhotos = seenPhotos.filter((id) => live.has(id));
		freshPhotos = freshPhotos.filter((id) => live.has(id));
	}
	store.set("seenPhotos", seenPhotos);
	store.set("freshPhotos", freshPhotos);
}

/** The next photo: a brand-new one if any are waiting, otherwise the regular order. */
function nextPhoto(order, take) {
	const fresh = freshPhotos.length ? photos.find((p) => p.id === freshPhotos[0]) : null;
	if (fresh) {
		if (take) {
			freshPhotos.shift();
			seenPhotos.push(fresh.id);
			store.set("freshPhotos", freshPhotos);
			store.set("seenPhotos", seenPhotos);
		}
		return fresh;
	}
	const p = order[photoIndex % order.length];
	if (take) photoIndex++;
	return p;
}

async function refreshPhotos() {
	if (!token()) return;
	try {
		const body = await api("/api/photos");
		photos = body.photos ?? [];
		store.set("photos", photos);
		noteNewPhotos();
		pruneBlobCache();
	} catch {
		/* keep the cached list */
	}
}

async function flushPending() {
	if (!token()) return;
	for (const [id, tappedAt] of Object.entries(pending)) {
		try {
			const r = await api("/api/dose/confirm", { method: "POST", body: JSON.stringify({ id, tapped_at: tappedAt }) });
			if (r.ok && r.dose && state) {
				state.doses = doses().map((d) => (d.id === id ? r.dose : d));
				store.set("state", state);
			}
			// Acknowledged or refused: either way the server has decided, so stop sending it.
			delete pending[id];
			store.set("pending", pending);
		} catch {
			return; // offline: try again later
		}
	}
}

async function heartbeat() {
	if (!token()) return;
	try {
		const r = await api("/api/heartbeat", {
			method: "POST",
			body: JSON.stringify({ device_id: deviceId, app_version: APP_VERSION }),
		});
		if (r.app_version && r.app_version !== APP_VERSION) store.set("update_waiting", r.app_version);
	} catch {
		/* the server notices the silence and tells Gary */
	}
}

// ---------- Photos (fetched with the device token, cached for offline) ----------

const blobUrls = new Map(); // photo url -> object URL

async function photoSrc(url) {
	if (blobUrls.has(url)) return blobUrls.get(url);
	let res;
	try {
		const cache = await caches.open("photos-v1");
		res = await cache.match(url);
		if (!res) {
			const fresh = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
			if (!fresh.ok) return null;
			await cache.put(url, fresh.clone());
			res = fresh;
		}
	} catch {
		try {
			res = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
			if (!res.ok) return null;
		} catch {
			return null;
		}
	}
	const objectUrl = URL.createObjectURL(await res.blob());
	blobUrls.set(url, objectUrl);
	return objectUrl;
}

async function pruneBlobCache() {
	const keep = new Set(photos.map((p) => p.url));
	for (const [url, objectUrl] of blobUrls) {
		if (!keep.has(url) && !url.startsWith("/api/pillbox/")) {
			URL.revokeObjectURL(objectUrl);
			blobUrls.delete(url);
		}
	}
	try {
		const cache = await caches.open("photos-v1");
		for (const req of await cache.keys()) {
			const path = new URL(req.url).pathname;
			if (path.startsWith("/api/photo/") && !keep.has(path)) await cache.delete(req);
		}
	} catch {
		/* ignore */
	}
}

/** Photos tied to people in today's events (e.g. Molly on the days she visits) come up every other turn. */
function photoOrder(now) {
	const today = localParts(now, tz()).date;
	const todayText = events()
		.filter((e) => e.date === today)
		.map((e) => e.text.toLowerCase())
		.join(" ");
	const featured = [];
	const rest = [];
	for (const p of photos) {
		const match = (p.people ?? []).some((name) => {
			const n = name.toLowerCase().trim();
			return n && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(todayText);
		});
		(match ? featured : rest).push(p);
	}
	if (!featured.length || !rest.length) return [...featured, ...rest];
	const out = [];
	const n = Math.max(featured.length, rest.length);
	for (let i = 0; i < n; i++) {
		out.push(featured[i % featured.length], rest[i % rest.length]);
	}
	return out;
}

// ---------- Chime (Web Audio, so there's no file to fail to load) ----------

let audio;
function unlockAudio() {
	try {
		audio ??= new AudioContext();
		if (audio.state === "suspended") audio.resume();
	} catch {
		/* no audio */
	}
}

function chime() {
	try {
		unlockAudio();
		if (!audio) return;
		const t0 = audio.currentTime + 0.05;
		const notes = [
			[659.25, 0],
			[523.25, 0.5],
			[659.25, 1.8],
			[523.25, 2.3],
		];
		for (const [freq, at] of notes) {
			const osc = audio.createOscillator();
			const gain = audio.createGain();
			osc.type = "sine";
			osc.frequency.value = freq;
			gain.gain.setValueAtTime(0, t0 + at);
			gain.gain.linearRampToValueAtTime(0.16, t0 + at + 0.04);
			gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 1.4);
			osc.connect(gain).connect(audio.destination);
			osc.start(t0 + at);
			osc.stop(t0 + at + 1.5);
		}
	} catch {
		/* silent is fine */
	}
}

// ---------- DOM helpers ----------

function h(tag, attrs = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === null || v === false) continue;
		if (k === "class") el.className = v;
		else if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
		else el.setAttribute(k, v === true ? "" : v);
	}
	for (const c of children.flat()) {
		if (c === null || c === undefined || c === false) continue;
		el.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return el;
}

const ICONS = {
	check: ["M5 12l5 5L20 7"],
	picture: ["M21 17l-5-5-9 8"],
	calendar: ["M3 10h18M8 3v4M16 3v4"],
	next: ["M3 10h18M8 3v4M16 3v4M10 14l3 2.5-3 2.5"],
};

function icon(name) {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("class", "icon");
	svg.setAttribute("aria-hidden", "true");
	const add = (tag, attrs) => {
		const el = document.createElementNS(ns, tag);
		for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
		svg.append(el);
	};
	if (name === "picture") {
		add("rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 });
		add("circle", { cx: 9, cy: 10, r: 2 });
	}
	if (name === "calendar" || name === "next") add("rect", { x: 3, y: 5, width: 18, height: 16, rx: 2 });
	if (name === "calendar") add("circle", { cx: 12, cy: 15, r: 1.5 });
	for (const d of ICONS[name] ?? []) add("path", { d });
	return svg;
}

/** Text that updates every second on whatever screen is up. */
function orient(now) {
	const p = localParts(now, tz());
	return {
		daypart: dayAndPart(p),
		date: monthDay(p.date),
		time: clockText(p.h, p.mi),
		datetime: `${monthDay(p.date)} · ${clockText(p.h, p.mi)}`,
		full: `${dayAndPart(p)} · ${monthDay(p.date)} · ${clockText(p.h, p.mi)}`,
		today: `Today is ${weekdayName(p.date)}, ${monthDay(p.date)}`,
	};
}

function live(key, now) {
	return h("span", { "data-t": key }, orient(now)[key]);
}

function backButton() {
	return h("button", { class: "back", on: { click: () => show(home()) } }, icon("picture"), h("span", {}, "Back to pictures"));
}

// ---------- Screens ----------

let current = { name: "", data: null, since: 0 };
let lastTouch = Date.now();
const root = document.getElementById("screen");

/** Night hours from the admin page (9 PM to 7 AM unless Gary changed them). */
function nightNow(now) {
	const n = state?.night;
	if (!n?.on) return false;
	const p = localParts(now, tz());
	return isNight(p.h, p.mi, n.start, n.end);
}

/** Where to go when nothing else is up: the pictures by day, the dim night screen at night. */
const home = (now = Date.now()) => (nightNow(now) ? "night" : "frame");

function show(name, data = null) {
	current = { name, data, since: Date.now() };
	lastTouch = Date.now();
	render();
}

function render() {
	const now = Date.now();
	const page = SCREENS[current.name](now, current.data);
	root.replaceChildren(page);
	if (current.name === "frame") startFrame(now);
	else clearInterval(frameTimer);
	document.body.classList.toggle("night", current.name === "night");
	backlight(current.name === "night");
}

// Night: a dim screen with the clock, day and date. No photos, no menus. A tap says it's
// night-time, then it dims again. Reminders still come up over it.
function nightScreen(now, data) {
	const awake = Boolean(data?.awake);
	return h(
		"div",
		{ class: `page night-page${awake ? " awake" : ""}`, role: "button", "aria-label": "Night-time", on: { click: () => show("night", { awake: true }) } },
		awake ? h("div", { class: "night-msg" }, "It's night-time.") : null,
		h("div", { class: "night-day" }, live("daypart", now)),
		h("div", { class: "night-clock" }, live("time", now)),
		h("div", { class: "night-date" }, live("today", now)),
		awake ? h("div", { class: "night-msg small" }, "Time to rest. The pictures come back in the morning.") : null,
	);
}

// Fully Kiosk Browser (on the Fire tablet) can turn the backlight down when its JavaScript
// Interface is on. In a plain browser this does nothing and the dark screen does the work.
let dayBrightness = null;
function backlight(night) {
	const f = window.fully;
	if (!f?.setScreenBrightness) return;
	try {
		if (night) {
			if (dayBrightness === null) dayBrightness = Number(f.getScreenBrightness?.()) || 150;
			f.setScreenBrightness(current.data?.awake ? 40 : 3);
		} else if (dayBrightness !== null) {
			f.setScreenBrightness(dayBrightness);
			dayBrightness = null;
		}
	} catch {
		/* not allowed: leave brightness alone */
	}
}

// Frame: rotating photos with captions, the orientation strip, and today's dose status.
let frameTimer = null;
let photoIndex = 0;

function frameScreen(now) {
	const done = stripStatus(doses(), now, pending);
	return h(
		"div",
		{ class: "page frame", role: "button", "aria-label": "Open the menu", on: { click: () => show("menu") } },
		h(
			"div",
			{ class: "photo-wrap" },
			h("img", { class: "photo backdrop", alt: "" }),
			h("img", { class: "photo main", alt: "" }),
			photos.length ? null : h("div", { class: "no-photos" }, live("time", now)),
			h("div", { class: "caption" }),
		),
		h(
			"div",
			{ class: "strip" },
			h("div", { class: "when" }, h("div", { class: "daypart" }, live("daypart", now)), h("div", { class: "datetime" }, live("datetime", now))),
			done ? h("div", { class: "chip" }, icon("check"), h("span", {}, `${capitalize(doseWords(done.dose))} done`)) : null,
		),
	);
}

async function showPhoto() {
	if (current.name !== "frame" || !photos.length) return;
	const order = photoOrder(Date.now());
	const p = nextPhoto(order, true);
	const src = await photoSrc(p.url);
	if (!src || current.name !== "frame") return;
	const main = root.querySelector("img.main");
	const back = root.querySelector("img.backdrop");
	const cap = root.querySelector(".caption");
	if (!main || !back) return;
	const img = new Image();
	img.onload = () => {
		main.classList.remove("on");
		back.classList.remove("on");
		cap.style.opacity = "0";
		setTimeout(() => {
			main.src = src;
			back.src = src;
			cap.textContent = p.caption ?? "";
			main.classList.add("on");
			back.classList.add("on");
			cap.style.opacity = "1";
		}, 400);
	};
	img.src = src;
	// Warm the next one so the swap is instant.
	const next = nextPhoto(order, false);
	if (next) photoSrc(next.url);
}

function startFrame() {
	clearInterval(frameTimer);
	showPhoto();
	frameTimer = setInterval(showPhoto, PHOTO_MS);
}

function menuScreen(now) {
	return h(
		"div",
		{ class: "page light" },
		h("div", { class: "header" }, h("h1", {}, live("daypart", now)), h("div", { class: "side" }, live("datetime", now))),
		h(
			"div",
			{ class: "menu-grid" },
			h("button", { class: "big today", on: { click: () => show("today") } }, icon("calendar"), h("span", {}, "Today")),
			h("button", { class: "big coming", on: { click: () => show("coming") } }, icon("next"), h("span", {}, "Coming up")),
		),
		backButton(),
	);
}

function eventWhen(e, now) {
	const z = tz();
	if (e.all_day) return { text: "Sometime today", sort: -1, start: null, end: null };
	const s = localParts(e.start_at, z);
	const end = e.end_at ?? e.start_at + 60 * MIN;
	const en = e.end_at ? localParts(e.end_at, z) : null;
	const spanText = en ? rangeWords(s.h, s.mi, en.h, en.mi) : timeWords(s.h, s.mi);
	if (e.start_at <= now && now < end) {
		return { text: en ? `Now, until ${timeWords(en.h, en.mi)}` : "Now", sort: e.start_at, start: e.start_at, end };
	}
	return { text: spanText, sort: e.start_at, start: e.start_at, end };
}

function todayItems(now) {
	const z = tz();
	const today = localParts(now, z).date;
	const items = [];
	for (const e of events()) {
		if (e.date !== today) continue;
		const w = eventWhen(e, now);
		if (w.end !== null && w.end <= now) continue; // already over
		items.push({ kind: "event", when: w.text, what: e.text, sort: w.sort, upcoming: w.start !== null });
	}
	for (const d of doses()) {
		if (d.date !== today || d.dose === "test") continue;
		const st = doseState(d, now, pending);
		if (st === "past") continue; // a missed dose is Gary's business, not an error for Mary
		const p = localParts(d.due_at, z);
		if (st === "done") {
			items.push({ kind: "dose", done: true, what: `${capitalize(doseWords(d.dose))} — `, doneWord: "done", sort: d.due_at });
		} else {
			items.push({ kind: "dose", when: timeWords(p.h, p.mi), what: capitalize(doseWords(d.dose)), sort: d.due_at, upcoming: true });
		}
	}
	items.sort((a, b) => a.sort - b.sort);
	const next = items.find((i) => i.upcoming && !i.done);
	if (next) next.next = true;
	// No scrolling: drop finished doses first, then the furthest-out items.
	while (items.length > MAX_TODAY_ROWS) {
		const doneIdx = items.findIndex((i) => i.done);
		items.splice(doneIdx >= 0 ? doneIdx : items.length - 1, 1);
	}
	return items;
}

function todayScreen(now) {
	const items = todayItems(now);
	const rows = items.map((i) =>
		h(
			"div",
			{ class: `row${i.next ? " next" : ""}${i.done ? " done" : ""}` },
			h("div", { class: "mark" }, i.done ? icon("check") : h("div", { class: "dot" })),
			h(
				"div",
				{ class: "text" },
				i.when ? h("div", { class: "when" }, i.next ? `Next · ${i.when}` : capitalize(i.when)) : null,
				h("div", { class: "what" }, i.what, i.done ? h("b", {}, i.doneWord) : null),
			),
		),
	);
	return h(
		"div",
		{ class: "page light" },
		h("div", { class: "header" }, h("h1", {}, live("today", now)), h("div", { class: "side" }, live("time", now))),
		rows.length
			? h("div", { class: "rows" }, rows)
			: h("div", { class: "empty" }, "Nothing else is planned for today."),
		backButton(),
	);
}

function comingScreen(now) {
	const z = tz();
	const today = localParts(now, z).date;
	const upcoming = events()
		.filter((e) => e.date > today)
		.sort((a, b) => a.start_at - b.start_at || Number(b.all_day) - Number(a.all_day))
		.slice(0, MAX_COMING_CARDS);
	const cards = upcoming.map((e) => {
		const label = dayLabel(e.date, today);
		let when = "Sometime that day";
		if (!e.all_day) {
			const s = localParts(e.start_at, z);
			const en = e.end_at ? localParts(e.end_at, z) : null;
			when = en ? rangeWords(s.h, s.mi, en.h, en.mi) : timeWords(s.h, s.mi);
		}
		return h(
			"div",
			{ class: "card" },
			h("div", { class: "day" }, h("div", { class: "main" }, label.main), h("div", { class: "sub" }, label.sub)),
			h("div", { class: "body" }, h("div", { class: "what" }, e.text), h("div", { class: "when" }, capitalize(when))),
		);
	});
	const days = state?.lookahead_days ?? 3;
	return h(
		"div",
		{ class: "page light" },
		h("div", { class: "header" }, h("h1", {}, days >= 7 ? "Coming up this week" : "Coming up"), h("div", { class: "side" }, live("today", now))),
		cards.length ? h("div", { class: "cards" }, cards) : h("div", { class: "empty" }, "Nothing is planned for the next few days."),
		backButton(),
	);
}

function reminderScreen(now, dose) {
	const isTest = dose.dose === "test";
	const pill = dose.has_photo ? h("img", { class: "pillbox", alt: "" }) : null;
	if (pill) {
		photoSrc(`/api/pillbox/${encodeURIComponent(dose.id)}`).then((src) => {
			if (src) pill.src = src;
			else pill.remove();
		});
	}
	return h(
		"div",
		{ class: "page reminder" },
		h("div", { class: "orient" }, live("full", now)),
		h("h1", {}, `Time for your ${doseWords(dose.dose)}`),
		isTest ? h("div", { class: "note" }, "This is a test. Tap the green button.") : null,
		h(
			"div",
			{ class: "act" },
			pill,
			h("button", { class: "took", on: { click: () => tookThem(dose) } }, icon("check"), h("span", {}, "I took them")),
		),
	);
}

function tookThem(dose) {
	if (pending[dose.id] || isClosed(dose, pending)) return;
	pending[dose.id] = Date.now();
	store.set("pending", pending);
	show("done", dose);
	flushPending();
}

function doneScreen(now, dose) {
	const z = tz();
	let thanks = "Thank you, Mary.";
	if (dose.dose !== "test") {
		const today = localParts(now, z).date;
		const later = doses()
			.filter((d) => d.date === today && d.dose !== "test" && d.due_at > dose.due_at)
			.sort((a, b) => a.due_at - b.due_at)[0];
		thanks = later ? `Thank you, Mary. Next are your ${doseWords(later.dose)}.` : "Thank you, Mary. That's all your pills for today.";
	}
	return h(
		"div",
		{ class: "page done-page", role: "button", "aria-label": "Back to pictures", on: { click: () => show(home()) } },
		h("div", { class: "check" }, icon("check")),
		h("h1", {}, `${capitalize(doseWords(dose.dose))}: done`),
		h("div", { class: "thanks" }, thanks),
		h("div", { class: "orient" }, live("full", now)),
	);
}

const SCREENS = {
	frame: frameScreen,
	menu: menuScreen,
	today: todayScreen,
	coming: comingScreen,
	reminder: reminderScreen,
	done: doneScreen,
	night: nightScreen,
};

// ---------- The loop ----------

let lastMinute = -1;

function proactiveToday(now) {
	if (!state) return false;
	const z = tz();
	const p = localParts(now, z);
	const [mh, mm] = (state.morning_show ?? "08:30").split(":").map(Number);
	const morningKey = `morning:${p.date}`;
	if (!shown[morningKey] && (p.h > mh || (p.h === mh && p.mi >= mm)) && p.h < 12) {
		shown[morningKey] = now;
		store.set("shown", shown);
		return true;
	}
	const lead = (state.preevent_min ?? 60) * MIN;
	if (lead > 0) {
		for (const e of events()) {
			if (e.all_day || e.date !== p.date) continue;
			const key = `event:${e.id}:${e.start_at}`;
			if (!shown[key] && e.start_at - lead <= now && now < e.start_at) {
				shown[key] = now;
				store.set("shown", shown);
				return true;
			}
		}
	}
	return false;
}

function tick() {
	const now = Date.now();
	const p = localParts(now, tz());

	// Live text (clock, day, date) on whatever screen is up.
	const o = orient(now);
	for (const el of root.querySelectorAll("[data-t]")) {
		const v = o[el.dataset.t];
		if (el.textContent !== v) el.textContent = v;
	}

	// The reminder interrupts anything.
	const active = activeReminder(doses(), now, pending);
	if (active) {
		if (current.name === "done" && current.data?.id === active.id) {
			/* just confirmed: let the Done screen finish */
		} else if (current.name !== "reminder" || current.data?.id !== active.id) {
			show("reminder", active);
		}
		const key = chimeKey(active, now);
		if (key && !chimed[key]) {
			chimed[key] = now;
			store.set("chimed", chimed);
			chime();
		}
	} else if (current.name === "reminder") {
		// Closed elsewhere (Gary marked it) or the window ended.
		show(home(now));
	}

	if (current.name === "done" && now - current.since > DONE_MS) show(home(now));
	const night = nightNow(now);
	if (night) {
		// Night hours: anything but a reminder or its Done screen goes to the night screen.
		if (["frame", "menu", "today", "coming"].includes(current.name)) show("night");
		else if (current.name === "night" && current.data?.awake && now - lastTouch > NIGHT_AWAKE_MS) show("night");
	} else if (current.name === "night") {
		show("frame"); // morning
	}
	if (["menu", "today", "coming"].includes(current.name) && now - lastTouch > IDLE_MS) show(home(now));

	if (current.name === "frame" && proactiveToday(now)) show("today", { auto: true });

	// Once a minute, redraw lists that depend on the time (Today rows, frame status chip).
	if (p.mi !== lastMinute) {
		lastMinute = p.mi;
		if (current.name === "today" || current.name === "coming") render();
		if (current.name === "frame") refreshChip(now);
		maybeReload(p);
	}
}

function refreshChip(now) {
	const strip = root.querySelector(".strip");
	if (!strip) return;
	const done = stripStatus(doses(), now, pending);
	const old = strip.querySelector(".chip");
	const text = done ? `${capitalize(doseWords(done.dose))} done` : "";
	if ((old?.textContent ?? "") === text) return;
	old?.remove();
	if (done) strip.append(h("div", { class: "chip" }, icon("check"), h("span", {}, text)));
}

function onDataChanged() {
	if (current.name === "today" || current.name === "coming") render();
	if (current.name === "frame") refreshChip(Date.now());
}

/** Reload once a night at 3 AM to pick up new versions and clear any slow leaks. */
function maybeReload(p) {
	if (p.h !== 3 || (current.name !== "frame" && current.name !== "night")) return;
	if (store.get("reloaded_on", "") === p.date) return;
	store.set("reloaded_on", p.date);
	location.reload();
}

function pruneMemory() {
	const cutoff = Date.now() - 3 * 24 * 60 * MIN;
	for (const obj of [chimed, shown]) for (const [k, v] of Object.entries(obj)) if (v < cutoff) delete obj[k];
	store.set("chimed", chimed);
	store.set("shown", shown);
}

// ---------- Keep the screen awake ----------

let wakeLock = null;
async function keepAwake() {
	try {
		if ("wakeLock" in navigator && !wakeLock) {
			wakeLock = await navigator.wakeLock.request("screen");
			wakeLock.addEventListener("release", () => (wakeLock = null));
		}
	} catch {
		/* ChromeOS power settings are the backstop */
	}
}

// ---------- Start ----------

document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener(
	"pointerdown",
	() => {
		lastTouch = Date.now();
		unlockAudio();
		keepAwake();
	},
	{ capture: true },
);
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") {
		keepAwake();
		refreshState();
	}
});
window.addEventListener("online", () => {
	flushPending().then(refreshState);
	heartbeat();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

pruneMemory();
show(home());
keepAwake();
setInterval(tick, SEC);
refreshState().then(() => flushPending());
refreshPhotos().then(() => current.name === "frame" && render());
heartbeat();
setInterval(() => flushPending().then(refreshState), STATE_MS);
setInterval(() => refreshPhotos(), PHOTOS_LIST_MS);
setInterval(heartbeat, HEARTBEAT_MS);
setInterval(pruneMemory, 6 * 60 * MIN);
