import { Hono, type Context, type Next } from "hono";
import { APP_VERSION, type Env } from "./env";
import { verifyAccess } from "./access";
import { safeEqual } from "./crypto";
import { deleteSetting, getSetting, getSettings, intSetting, setSetting } from "./db";
import { sendAlert } from "./alerts";
import { googleAuthUrl, googleCallback, syncWithAlerts } from "./calendar";
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

async function adminAuth(c: Context<App>, next: Next) {
	const user = await verifyAccess(c.env, c.req.raw);
	if (!user) return c.text("Forbidden: sign in through Cloudflare Access.", 403);
	await next();
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
		calendar_source: env.CALENDAR_SOURCE,
		alert_provider: env.ALERT_PROVIDER,
		google_connected: Boolean(settings.google_refresh),
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

admin.post("/photos", async (c) => {
	const form = await c.req.formData();
	const files = form.getAll("file").filter((f): f is File => f instanceof File);
	if (!files.length) return c.json({ error: "no file" }, 400);
	const caption = String(form.get("caption") ?? "").slice(0, 120);
	const people = String(form.get("people") ?? "").slice(0, 200);
	const ids: string[] = [];
	for (const file of files) {
		const id = crypto.randomUUID();
		const key = `photos/${id}`;
		await c.env.PHOTOS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || "image/jpeg" } });
		await c.env.DB.prepare("INSERT INTO photos (id, r2_key, caption, people, active, created_at) VALUES (?, ?, ?, ?, 1, ?)")
			.bind(id, key, caption, people, Date.now())
			.run();
		ids.push(id);
	}
	return c.json({ ok: true, ids });
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
	await setSetting(c.env, "last_sync_attempt", String(now));
	await syncWithAlerts(c.env, now);
	const s = await getSettings(c.env);
	return c.json({ ok: !s.last_sync_error, error: s.last_sync_error ?? null });
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
