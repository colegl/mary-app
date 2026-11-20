import { Hono, type Context, type Next } from "hono";
import { APP_VERSION, type Env } from "./env";
import { verifyAccess } from "./access";
import { checkPassword, clearCookie, hasSession, loginPage, passwordEnabled, sessionCookie } from "./password";
import { encrypt, safeEqual } from "./crypto";
import { deleteSetting, getSetting, getSettings, intSetting, setSetting } from "./db";
import { ntfyServer, ntfyTopic, sendAlert } from "./alerts";
import { calendarSource, fetchIcal, googleAuthUrl, googleCallback, syncWindow, syncWithAlerts } from "./calendar";
import { normalizeIcalUrl, parseMaryEvents } from "./ical";
import {
	cancelTestDoses,
	confirmDose,
	createTestDose,
	ensureInstances,
	getSchedule,
	kioskDoses,
	rebuildFuture,
	reopenDose,
	skipDose,
	watchDoses,
	type DoseRow,
} from "./doses";
import { addDays, localParts, zonedToUtc } from "../public/app/shared/words.js";

type App = { Bindings: Env };
const app = new Hono<App>();

const MIN = 60_000;
const OFFLINE_AFTER = 15 * MIN;
const SYNC_EVERY = 15 * MIN;

// ---------- Auth ----------

async function kioskAuth(c: Context<App>, next: Next) {
	// /api/admin/* has its own check (Cloudflare Access), not the kiosk token.
	if (c.req.path.startsWith("/api/admin/")) return next();
	const auth = c.req.header("Authorization") ?? "";
	const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
	if (!c.env.KIOSK_TOKEN || !token || !safeEqual(token, c.env.KIOSK_TOKEN)) {
		return c.json({ error: "unauthorized" }, 401);
	}
	await next();
}

/** Admin is open to a valid Cloudflare Access sign-in or a valid password session. */
async function isAdmin(c: Context<App>): Promise<boolean> {
	if (await verifyAccess(c.env, c.req.raw)) return true;
	return hasSession(c.env, c.req.raw);
}

async function adminAuth(c: Context<App>, next: Next) {
	if (await isAdmin(c)) return next();
	// Pages go to the sign-in form; API calls just get refused.
	if (c.req.method === "GET" && !c.req.path.startsWith("/api/")) {
		return passwordEnabled(c.env)
			? c.redirect("/admin/login")
			: c.text("The admin page is locked. Add an ADMIN_PASSWORD secret in GitHub and run the Deploy workflow.", 403);
	}
	return c.json({ error: "Signed out. Reload the page to sign in." }, 403);
}

// ---------- Shapes sent to the kiosk ----------

function publicDose(d: DoseRow) {
	return {
		id: d.id,
		date: d.date,
		dose: d.dose,
		due_at: d.due_at,
		remind_again_at: d.remind_again_at,
		alert_at: d.alert_at,
		expires_at: d.expires_at,
		confirmed_at: d.confirmed_at,
		skipped_at: d.skipped_at,
		has_photo: Boolean(d.pillbox_photo),
	};
}

interface EventRow {
	id: string;
	start_at: number;
	end_at: number | null;
	start_date: string;
	all_day: number;
	title: string;
	display_text: string | null;
	hidden: number;
}

async function r2Response(env: Env, key: string | null | undefined): Promise<Response> {
	if (!key) return new Response("not found", { status: 404 });
	const obj = await env.PHOTOS.get(key);
	if (!obj) return new Response("not found", { status: 404 });
	const headers = new Headers();
	obj.writeHttpMetadata(headers);
	headers.set("etag", obj.httpEtag);
	// Keys are never reused, so the kiosk can cache a photo for good.
	headers.set("Cache-Control", "private, max-age=31536000, immutable");
	return new Response(obj.body, { headers });
}

// ---------- Kiosk API ----------

const kiosk = new Hono<App>();
kiosk.use("*", kioskAuth);

kiosk.get("/state", async (c) => {
	const env = c.env;
	const now = Date.now();
	await ensureInstances(env, now);
	const settings = await getSettings(env);
	const lookahead = intSetting(settings, "lookahead_days", 3);
	const today = localParts(now, env.TIMEZONE).date;
	const from = zonedToUtc(today, "00:00", env.TIMEZONE);
	const to = zonedToUtc(addDays(today, lookahead + 1), "00:00", env.TIMEZONE);
	const { results: events } = await env.DB.prepare(
		"SELECT * FROM events WHERE hidden = 0 AND start_at >= ? AND start_at < ? ORDER BY all_day DESC, start_at",
	)
		.bind(from, to)
		.all<EventRow>();
	const doses = await kioskDoses(env, now);
	return c.json({
		now,
		timezone: env.TIMEZONE,
		app_version: APP_VERSION,
		lookahead_days: lookahead,
		morning_show: settings.morning_show ?? "08:30",
		preevent_min: intSetting(settings, "preevent_min", 60),
		events: events.map((e) => ({
			id: e.id,
			date: e.start_date,
			start_at: e.start_at,
			end_at: e.end_at,
			all_day: Boolean(e.all_day),
			text: e.display_text?.trim() || e.title,
		})),
		doses: doses.map(publicDose),
	});
});

kiosk.get("/photos", async (c) => {
	const { results } = await c.env.DB.prepare(
		"SELECT id, caption, people FROM photos WHERE active = 1 ORDER BY created_at",
	).all<{ id: string; caption: string; people: string }>();
	return c.json({
		photos: results.map((p) => ({
			id: p.id,
			caption: p.caption,
			people: p.people
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
			url: `/api/photo/${p.id}`,
		})),
	});
});

kiosk.get("/photo/:id", async (c) => {
	const row = await c.env.DB.prepare("SELECT r2_key FROM photos WHERE id = ?")
		.bind(c.req.param("id"))
		.first<{ r2_key: string }>();
	return r2Response(c.env, row?.r2_key);
});

kiosk.get("/pillbox/:doseId", async (c) => {
	const row = await c.env.DB.prepare("SELECT pillbox_photo FROM dose_log WHERE id = ?")
		.bind(c.req.param("doseId"))
		.first<{ pillbox_photo: string | null }>();
	return r2Response(c.env, row?.pillbox_photo);
});

kiosk.post("/dose/confirm", async (c) => {
	const body = await c.req.json<{ id?: string; tapped_at?: number }>().catch(() => ({}) as { id?: string; tapped_at?: number });
	if (!body.id) return c.json({ ok: false, reason: "missing id" }, 400);
	const now = Date.now();
	const result = await confirmDose(c.env, body.id, Number(body.tapped_at) || now, "kiosk", now);
	// 200 even when refused: the kiosk drops refused confirmations from its queue rather than retrying forever.
	return c.json(result.ok ? { ok: true, dose: publicDose(result.dose) } : result);
});

kiosk.post("/heartbeat", async (c) => {
	const body = await c.req
		.json<{ device_id?: string; app_version?: string }>()
		.catch(() => ({}) as { device_id?: string; app_version?: string });
	const device = (body.device_id ?? "kiosk").slice(0, 64);
	await c.env.DB.prepare(
		`INSERT INTO heartbeat (device_id, last_seen, app_version) VALUES (?, ?, ?)
		 ON CONFLICT(device_id) DO UPDATE SET last_seen = excluded.last_seen, app_version = excluded.app_version`,
	)
		.bind(device, Date.now(), (body.app_version ?? "").slice(0, 32))
		.run();
	return c.json({ ok: true, app_version: APP_VERSION });
});

// ---------- Admin API ----------

const admin = new Hono<App>();
admin.use("*", adminAuth);

admin.get("/overview", async (c) => {
	const env = c.env;
	const now = Date.now();
	await ensureInstances(env, now);
	const settings = await getSettings(env);
	const today = localParts(now, env.TIMEZONE).date;
	const [heartbeats, doses, alerts, events, photos, schedule] = await Promise.all([
		env.DB.prepare("SELECT * FROM heartbeat ORDER BY last_seen DESC").all(),
		env.DB.prepare("SELECT * FROM dose_log WHERE date >= ? ORDER BY due_at DESC LIMIT 40").bind(addDays(today, -7)).all(),
		env.DB.prepare("SELECT * FROM alerts ORDER BY at DESC LIMIT 40").all(),
		env.DB.prepare("SELECT * FROM events WHERE start_at >= ? ORDER BY start_at LIMIT 100")
			.bind(zonedToUtc(today, "00:00", env.TIMEZONE))
			.all(),
		env.DB.prepare("SELECT * FROM photos ORDER BY created_at DESC").all(),
		getSchedule(env),
	]);
	return c.json({
		now,
		timezone: env.TIMEZONE,
		app_version: APP_VERSION,
		calendar_source: await calendarSource(env),
		alert_provider: env.ALERT_PROVIDER,
		ntfy:
			env.ALERT_PROVIDER === "pushover"
				? null
				: await (async () => {
						const topic = await ntfyTopic(env);
						const server = ntfyServer(env);
						return { topic, server, web: `${server}/${encodeURIComponent(topic)}`, app: `ntfy://${new URL(server).host}/${encodeURIComponent(topic)}` };
					})(),
		google_connected: Boolean(settings.google_refresh),
		google_available: Boolean(env.GOOGLE_CLIENT_ID),
		sync: {
			last_ok: settings.last_sync_ok ? Number(settings.last_sync_ok) : null,
			fail_count: intSetting(settings, "sync_fail_count", 0),
			last_error: settings.last_sync_error ?? null,
		},
		settings: {
			lookahead_days: intSetting(settings, "lookahead_days", 3),
			morning_show: settings.morning_show ?? "08:30",
			preevent_min: intSetting(settings, "preevent_min", 60),
		},
		heartbeats: heartbeats.results,
		doses: doses.results,
		alerts: alerts.results,
		events: events.results,
		photos: photos.results,
		schedule,
	});
});

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

admin.post("/schedule/:dose", async (c) => {
	const dose = c.req.param("dose");
	const b = await c.req.json<{
		time?: string;
		enabled?: boolean;
		remind_again_min?: number;
		window_min?: number;
		expire_min?: number;
	}>();
	if (b.time !== undefined && !HHMM.test(b.time)) return c.json({ error: "time must be HH:MM (24-hour)" }, 400);
	const cur = (await getSchedule(c.env)).find((s) => s.dose === dose);
	if (!cur) return c.json({ error: "unknown dose" }, 404);
	const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
		const n = Number(v);
		return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : fallback;
	};
	const remind = clamp(b.remind_again_min, 5, 180, cur.remind_again_min);
	const windowMin = clamp(b.window_min, remind, 240, Math.max(cur.window_min, remind));
	const expire = clamp(b.expire_min, windowMin, 600, Math.max(cur.expire_min, windowMin));
	await c.env.DB.prepare(
		"UPDATE med_schedule SET time = ?, enabled = ?, remind_again_min = ?, window_min = ?, expire_min = ? WHERE dose = ?",
	)
		.bind(b.time ?? cur.time, b.enabled === undefined ? cur.enabled : b.enabled ? 1 : 0, remind, windowMin, expire, dose)
		.run();
	await rebuildFuture(c.env, Date.now());
	return c.json({ ok: true, schedule: await getSchedule(c.env) });
});

admin.post("/schedule/:dose/photo", async (c) => {
	const dose = c.req.param("dose");
	const form = await c.req.formData();
	const file = form.get("file");
	if (!(file instanceof File)) return c.json({ error: "no file" }, 400);
	const key = `pillbox/${dose}-${crypto.randomUUID()}`;
	await c.env.PHOTOS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || "image/jpeg" } });
	await c.env.DB.batch([
		c.env.DB.prepare("UPDATE med_schedule SET pillbox_photo = ? WHERE dose = ?").bind(key, dose),
		// Rows already created for upcoming doses pick up the new photo too.
		c.env.DB.prepare("UPDATE dose_log SET pillbox_photo = ? WHERE dose = ? AND expires_at > ? AND confirmed_at IS NULL").bind(
			key,
			dose,
			Date.now(),
		),
	]);
	return c.json({ ok: true, key });
});

admin.get("/r2", async (c) => r2Response(c.env, c.req.query("key")));

admin.post("/dose/:id/:action", async (c) => {
	const id = c.req.param("id");
	const action = c.req.param("action");
	const now = Date.now();
	let ok = false;
	if (action === "done") ok = (await confirmDose(c.env, id, now, "admin", now)).ok;
	else if (action === "skip") ok = await skipDose(c.env, id, now);
	else if (action === "reopen") ok = await reopenDose(c.env, id);
	else return c.json({ error: "unknown action" }, 400);
	return c.json({ ok });
});

admin.post("/test-dose", async (c) => {
	const b = await c.req.json<{ in_min?: number; remind_again_min?: number; alert_min?: number; expire_min?: number }>();
	const d = await createTestDose(c.env, Date.now(), {
		inMin: Math.max(0, Number(b.in_min ?? 1)),
		remindAgainMin: Math.max(1, Number(b.remind_again_min ?? 2)),
		alertMin: Math.max(1, Number(b.alert_min ?? 4)),
		expireMin: Math.max(1, Number(b.expire_min ?? 10)),
	});
	return c.json({ ok: true, dose: d });
});

admin.post("/test-dose/cancel", async (c) => {
	await cancelTestDoses(c.env, Date.now());
	return c.json({ ok: true });
});

admin.post("/test-alert", async (c) => {
	const ok = await sendAlert(c.env, "test", "Test alert from Mary's kiosk. If you can read this on your phone, alerts work.");
	return c.json({ ok });
});

admin.post("/events/:id", async (c) => {
	const b = await c.req.json<{ display_text?: string | null; hidden?: boolean }>();
	const id = c.req.param("id");
	if (b.display_text !== undefined) {
		const text = b.display_text?.trim() ? b.display_text.trim().slice(0, 200) : null;
		await c.env.DB.prepare("UPDATE events SET display_text = ? WHERE id = ?").bind(text, id).run();
	}
	if (b.hidden !== undefined) {
		await c.env.DB.prepare("UPDATE events SET hidden = ? WHERE id = ?").bind(b.hidden ? 1 : 0, id).run();
	}
	return c.json({ ok: true });
});

/** Stores one photo unless the same original was already added. Returns its id, or null for a duplicate. */
async function savePhoto(env: Env, file: File, caption: string, people: string, hash: string | null): Promise<string | null> {
	if (hash) {
		const dup = await env.DB.prepare("SELECT id FROM photos WHERE source_hash = ?").bind(hash).first();
		if (dup) return null;
	}
	const id = crypto.randomUUID();
	const key = `photos/${id}`;
	await env.PHOTOS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || "image/jpeg" } });
	await env.DB.prepare("INSERT INTO photos (id, r2_key, caption, people, active, created_at, source_hash) VALUES (?, ?, ?, ?, 1, ?, ?)")
		.bind(id, key, caption, people, Date.now(), hash)
		.run();
	return id;
}

const HASH = /^[0-9a-f]{64}$/;

admin.post("/photos", async (c) => {
	const form = await c.req.formData();
	const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
	if (!files.length) return c.json({ error: "no file" }, 400);
	if (files.some((f) => f.type && !f.type.startsWith("image/"))) return c.json({ error: "Only photos can be added." }, 400);
	const caption = String(form.get("caption") ?? "").slice(0, 120);
	const people = String(form.get("people") ?? "").slice(0, 200);
	// One fingerprint per file, in the same order (sent by the admin page).
	const hashes = form.getAll("hash").map(String);
	const ids: string[] = [];
	let duplicates = 0;
	for (const [i, file] of files.entries()) {
		const hash = HASH.test(hashes[i] ?? "") ? hashes[i] : null;
		const id = await savePhoto(c.env, file, caption, people, hash);
		if (id) ids.push(id);
		else duplicates++;
	}
	return c.json({ ok: true, ids, duplicates });
});

admin.post("/photos/:id", async (c) => {
	const b = await c.req.json<{ caption?: string; people?: string; active?: boolean }>();
	const id = c.req.param("id");
	const stmts: D1PreparedStatement[] = [];
	if (b.caption !== undefined) stmts.push(c.env.DB.prepare("UPDATE photos SET caption = ? WHERE id = ?").bind(b.caption.slice(0, 120), id));
	if (b.people !== undefined) stmts.push(c.env.DB.prepare("UPDATE photos SET people = ? WHERE id = ?").bind(b.people.slice(0, 200), id));
	if (b.active !== undefined) stmts.push(c.env.DB.prepare("UPDATE photos SET active = ? WHERE id = ?").bind(b.active ? 1 : 0, id));
	if (stmts.length) await c.env.DB.batch(stmts);
	return c.json({ ok: true });
});

admin.delete("/photos/:id", async (c) => {
	const id = c.req.param("id");
	const row = await c.env.DB.prepare("SELECT r2_key FROM photos WHERE id = ?").bind(id).first<{ r2_key: string }>();
	if (row) await c.env.PHOTOS.delete(row.r2_key);
	await c.env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
	return c.json({ ok: true });
});

admin.post("/settings", async (c) => {
	const b = await c.req.json<{ lookahead_days?: number; morning_show?: string; preevent_min?: number }>();
	if (b.lookahead_days !== undefined) {
		await setSetting(c.env, "lookahead_days", String(Math.min(Math.max(Math.round(Number(b.lookahead_days)) || 3, 1), 14)));
	}
	if (b.morning_show !== undefined) {
		if (!HHMM.test(b.morning_show)) return c.json({ error: "morning_show must be HH:MM" }, 400);
		await setSetting(c.env, "morning_show", b.morning_show);
	}
	if (b.preevent_min !== undefined) {
		await setSetting(c.env, "preevent_min", String(Math.min(Math.max(Math.round(Number(b.preevent_min)) || 0, 0), 240)));
	}
	return c.json({ ok: true });
});

admin.post("/sync", async (c) => {
	const now = Date.now();
	if ((await calendarSource(c.env)) === "none") {
		return c.json({ ok: false, error: "No calendar connected yet. Paste the calendar's secret address first." });
	}
	await setSetting(c.env, "last_sync_attempt", String(now));
	await syncWithAlerts(c.env, now);
	const s = await getSettings(c.env);
	return c.json({ ok: !s.last_sync_error, error: s.last_sync_error ?? null });
});

// The calendar's "Secret address in iCal format". Checked by downloading it before saving.
admin.post("/calendar-url", async (c) => {
	const env = c.env;
	const body = await c.req.json<{ url?: string }>().catch(() => ({}) as { url?: string });
	const url = normalizeIcalUrl(body.url ?? "");
	if (!url) return c.json({ ok: false, error: "That doesn't look like a web address. Copy the whole \"Secret address in iCal format\"." }, 400);
	if (/calendar\/ical\/.*\/public\//.test(url)) {
		return c.json({ ok: false, error: "That's the public address, which only works if the calendar is made public. Use the \"Secret address in iCal format\" just below it." }, 400);
	}
	const now = Date.now();
	let found: number;
	let upcoming: { title: string; start_at: number; all_day: boolean }[];
	try {
		const { from, to } = await syncWindow(env, now);
		const events = parseMaryEvents(await fetchIcal(url), from, to, env.TIMEZONE);
		found = events.length;
		upcoming = events.slice(0, 5).map((e) => ({ title: e.title, start_at: e.start_at, all_day: e.all_day }));
	} catch (e) {
		return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
	}
	await setSetting(env, "ical_url", await encrypt(env.TOKEN_ENCRYPTION_KEY, url));
	await setSetting(env, "last_sync_attempt", String(now));
	await syncWithAlerts(env, now);
	return c.json({ ok: true, found, upcoming });
});

admin.delete("/calendar-url", async (c) => {
	await deleteSetting(c.env, "ical_url");
	return c.json({ ok: true });
});

admin.post("/google/disconnect", async (c) => {
	await deleteSetting(c.env, "google_refresh");
	await deleteSetting(c.env, "google_access");
	return c.json({ ok: true });
});

admin.get("/kiosk-link", (c) => {
	// The token travels in the fragment, so it never reaches server logs.
	return c.json({ url: `${new URL("/", c.env.PUBLIC_URL).href}#setup=${encodeURIComponent(c.env.KIOSK_TOKEN)}` });
});

// ---------- Routing ----------

app.route("/api/admin", admin);
app.route("/api", kiosk);

app.get("/oauth/google/start", adminAuth, async (c) => c.redirect(await googleAuthUrl(c.env)));
app.get("/oauth/google/callback", adminAuth, async (c) => {
	const err = c.req.query("error");
	if (err) return c.redirect(`/admin/?google=${encodeURIComponent(err)}`);
	try {
		await googleCallback(c.env, c.req.query("code") ?? "", c.req.query("state") ?? "");
		await syncWithAlerts(c.env, Date.now());
		return c.redirect("/admin/?google=connected");
	} catch (e) {
		return c.redirect(`/admin/?google=${encodeURIComponent(String(e))}`);
	}
});

app.get("/admin", (c) => c.redirect("/admin/"));
app.get("/admin/login", async (c) => {
	if (await isAdmin(c)) return c.redirect("/admin/");
	if (!passwordEnabled(c.env)) return c.text("The admin page is locked. Add an ADMIN_PASSWORD secret in GitHub and run the Deploy workflow.", 403);
	return c.html(loginPage());
});
app.post("/admin/login", async (c) => {
	if (!passwordEnabled(c.env)) return c.text("No admin password is set.", 403);
	const form = await c.req.formData();
	const result = await checkPassword(c.env, String(form.get("password") ?? ""), Date.now());
	if (result === "ok") {
		c.header("Set-Cookie", await sessionCookie(c.env));
		return c.redirect("/admin/");
	}
	// Slow down guessing.
	await new Promise((r) => setTimeout(r, 1000));
	const msg = result === "locked" ? "Too many wrong tries. Wait 15 minutes and try again." : "That password didn't match.";
	return c.html(loginPage(msg), 401);
});
app.get("/admin/logout", (c) => {
	c.header("Set-Cookie", clearCookie());
	return c.redirect("/admin/login");
});
// The phone's share menu ("Share → Mary's kiosk") posts photos here. Normally the admin
// page's service worker catches the post and hands the photos to the page, which shrinks
// them before uploading; this is the fallback for when it isn't running.
app.post("/admin/share", async (c) => {
	if (!(await isAdmin(c))) return c.redirect("/admin/login", 303);
	const form = await c.req.formData().catch(() => null);
	const files = (form?.getAll("file") ?? []).filter((f): f is File => f instanceof File && f.size > 0 && f.type.startsWith("image/"));
	let added = 0;
	for (const file of files) if (await savePhoto(c.env, file, "", "", null)) added++;
	return c.redirect(`/admin/?added=${added}#photos`, 303);
});
// The install files must load without the sign-in cookie (browsers fetch manifests without it).
for (const path of ["/admin/manifest.webmanifest", "/admin/sw.js"]) app.get(path, (c) => c.env.ASSETS.fetch(c.req.raw));
app.all("/admin/*", adminAuth, (c) => c.env.ASSETS.fetch(c.req.raw));

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// ---------- Cron ----------

async function checkHeartbeat(env: Env, now: number): Promise<void> {
	const row = await env.DB.prepare("SELECT MAX(last_seen) AS last FROM heartbeat").first<{ last: number | null }>();
	if (!row?.last) return; // kiosk not set up yet
	const alerted = (await getSetting(env, "offline_alerted")) === "1";
	if (now - row.last > OFFLINE_AFTER && !alerted) {
		await setSetting(env, "offline_alerted", "1");
		const mins = Math.round((now - row.last) / MIN);
		await sendAlert(
			env,
			"offline",
			`Mary's kiosk hasn't checked in for ${mins} minutes. It may be off, asleep, off Wi-Fi, or stuck at the sign-in screen.`,
		);
	} else if (now - row.last <= OFFLINE_AFTER && alerted) {
		await deleteSetting(env, "offline_alerted");
		await sendAlert(env, "online", "Mary's kiosk is checking in again.");
	}
}

async function scheduled(env: Env, now: number): Promise<void> {
	await watchDoses(env, now);
	await checkHeartbeat(env, now);
	const lastAttempt = Number((await getSetting(env, "last_sync_attempt")) ?? "0");
	if (now - lastAttempt >= SYNC_EVERY - 30_000) {
		await setSetting(env, "last_sync_attempt", String(now));
		await syncWithAlerts(env, now);
	}
}

export default {
	fetch: app.fetch,
	async scheduled(controller, env, ctx) {
		ctx.waitUntil(scheduled(env, controller.scheduledTime));
	},
} satisfies ExportedHandler<Env>;
