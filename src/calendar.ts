// Calendar: Google OAuth (read-only scope), the 15-minute sync of "(Mary)" events,
// and the mock source used in phase 2 and local dev.

import type { Env } from "./env";
import { decrypt, encrypt } from "./crypto";
import { deleteSetting, getSetting, getSettings, intSetting, setSetting } from "./db";
import { sendAlert } from "./alerts";
import { addDays, localParts, zonedToUtc } from "../public/app/shared/words.js";
import mock from "../mock/events.json";

const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const PREFIX = /^\s*\(mary\)\s*/i;

export interface SyncedEvent {
	id: string;
	start_at: number;
	end_at: number | null;
	start_date: string;
	all_day: boolean;
	title: string;
	display_text?: string;
}

// ---------- Google OAuth ----------

function redirectUri(env: Env): string {
	return new URL("/oauth/google/callback", env.PUBLIC_URL).href;
}

export async function googleAuthUrl(env: Env): Promise<string> {
	if (!env.GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID is not set");
	const state = crypto.randomUUID();
	await setSetting(env, "google_oauth_state", `${state}|${Date.now() + 10 * 60_000}`);
	const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	u.search = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID,
		redirect_uri: redirectUri(env),
		response_type: "code",
		scope: SCOPE,
		access_type: "offline",
		prompt: "consent",
		state,
	}).toString();
	return u.href;
}

export async function googleCallback(env: Env, code: string, state: string): Promise<void> {
	const saved = await getSetting(env, "google_oauth_state");
	await deleteSetting(env, "google_oauth_state");
	const [want, exp] = (saved ?? "").split("|");
	if (!want || want !== state || Date.now() > Number(exp)) throw new Error("Sign-in expired or didn't match; try again");

	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		body: new URLSearchParams({
			code,
			client_id: env.GOOGLE_CLIENT_ID ?? "",
			client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
			redirect_uri: redirectUri(env),
			grant_type: "authorization_code",
		}),
	});
	const body = (await res.json()) as { refresh_token?: string; error?: string; error_description?: string };
	if (!res.ok || !body.refresh_token) {
		throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
	}
	await setSetting(env, "google_refresh", await encrypt(env.TOKEN_ENCRYPTION_KEY, body.refresh_token));
	await deleteSetting(env, "google_access");
}

async function accessToken(env: Env): Promise<string> {
	const cached = await getSetting(env, "google_access");
	if (cached) {
		const [tok, exp] = cached.split("|");
		if (Date.now() < Number(exp) - 60_000) return tok;
	}
	const sealed = await getSetting(env, "google_refresh");
	if (!sealed) throw new Error("Google Calendar is not connected");
	const refresh = await decrypt(env.TOKEN_ENCRYPTION_KEY, sealed);
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		body: new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID ?? "",
			client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
			refresh_token: refresh,
			grant_type: "refresh_token",
		}),
	});
	const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
	if (!res.ok || !body.access_token) throw new Error(`Google token refresh failed: ${body.error ?? res.status}`);
	// Access tokens live about an hour; keep it so 4 syncs an hour share one.
	await setSetting(env, "google_access", `${body.access_token}|${Date.now() + (body.expires_in ?? 3600) * 1000}`);
	return body.access_token;
}

// ---------- Sources ----------

interface GoogleEvent {
	id: string;
	status?: string;
	summary?: string;
	start?: { date?: string; dateTime?: string };
	end?: { date?: string; dateTime?: string };
}

async function fetchGoogle(env: Env, fromMs: number, toMs: number): Promise<SyncedEvent[]> {
	const token = await accessToken(env);
	const out: SyncedEvent[] = [];
	let pageToken: string | undefined;
	do {
		const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.CALENDAR_ID)}/events`);
		u.search = new URLSearchParams({
			timeMin: new Date(fromMs).toISOString(),
			timeMax: new Date(toMs).toISOString(),
			singleEvents: "true",
			orderBy: "startTime",
			maxResults: "250",
			...(pageToken ? { pageToken } : {}),
		}).toString();
		const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
		if (!res.ok) throw new Error(`Calendar API ${res.status}: ${(await res.text()).slice(0, 200)}`);
		const body = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
		for (const e of body.items ?? []) {
			if (e.status === "cancelled" || !e.summary || !PREFIX.test(e.summary)) continue;
			const title = e.summary.replace(PREFIX, "").trim();
			if (e.start?.date) {
				out.push({
					id: e.id,
					all_day: true,
					start_date: e.start.date,
					start_at: zonedToUtc(e.start.date, "00:00", env.TIMEZONE),
					end_at: e.end?.date ? zonedToUtc(e.end.date, "00:00", env.TIMEZONE) : null,
					title,
				});
			} else if (e.start?.dateTime) {
				const start = Date.parse(e.start.dateTime);
				out.push({
					id: e.id,
					all_day: false,
					start_date: localParts(start, env.TIMEZONE).date,
					start_at: start,
					end_at: e.end?.dateTime ? Date.parse(e.end.dateTime) : null,
					title,
				});
			}
		}
		pageToken = body.nextPageToken;
	} while (pageToken);
	return out;
}

interface MockEvent {
	day: number;
	start?: string;
	end?: string;
	all_day?: boolean;
	title: string;
	display_text?: string;
}

export function mockEvents(env: Env, now: number): SyncedEvent[] {
	const today = localParts(now, env.TIMEZONE).date;
	return (mock.events as MockEvent[]).map((m, i) => {
		const date = addDays(today, m.day);
		const allDay = Boolean(m.all_day || !m.start);
		return {
			id: `mock-${date}-${i}`,
			all_day: allDay,
			start_date: date,
			start_at: zonedToUtc(date, allDay ? "00:00" : m.start!, env.TIMEZONE),
			end_at: allDay
				? zonedToUtc(addDays(date, 1), "00:00", env.TIMEZONE)
				: m.end
					? zonedToUtc(date, m.end, env.TIMEZONE)
					: null,
			title: m.title.replace(PREFIX, "").trim(),
			display_text: m.display_text,
		};
	});
}

// ---------- Sync ----------

/** Pull events for today through the lookahead window and store them. */
export async function syncCalendar(env: Env, now: number): Promise<{ count: number }> {
	const settings = await getSettings(env);
	const days = Math.max(intSetting(settings, "lookahead_days", 3), 7) + 1;
	const today = localParts(now, env.TIMEZONE).date;
	const from = zonedToUtc(today, "00:00", env.TIMEZONE);
	const to = zonedToUtc(addDays(today, days), "00:00", env.TIMEZONE);

	const events = env.CALENDAR_SOURCE === "mock" ? mockEvents(env, now) : await fetchGoogle(env, from, to);
	const calendarId = env.CALENDAR_SOURCE === "mock" ? "mock" : env.CALENDAR_ID;

	const stmts: D1PreparedStatement[] = events.map((e) =>
		env.DB.prepare(
			`INSERT INTO events (id, calendar_id, start_at, end_at, start_date, all_day, title, display_text, hidden, synced_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
			 ON CONFLICT(id) DO UPDATE SET calendar_id = excluded.calendar_id, start_at = excluded.start_at,
			   end_at = excluded.end_at, start_date = excluded.start_date, all_day = excluded.all_day,
			   title = excluded.title, synced_at = excluded.synced_at,
			   display_text = COALESCE(events.display_text, excluded.display_text)`,
		).bind(e.id, calendarId, e.start_at, e.end_at, e.start_date, e.all_day ? 1 : 0, e.title, e.display_text ?? null, now),
	);
	// Events in the window that the calendar no longer returns were deleted or renamed.
	stmts.push(
		env.DB.prepare("DELETE FROM events WHERE start_at >= ? AND start_at < ? AND synced_at < ?").bind(from, to, now),
	);
	// Keep a month of history for the admin page, no more.
	stmts.push(env.DB.prepare("DELETE FROM events WHERE start_at < ?").bind(from - 30 * 86_400_000));
	await env.DB.batch(stmts);
	return { count: events.length };
}

/** Cron wrapper: tracks consecutive failures and alerts Gary after two in a row. */
export async function syncWithAlerts(env: Env, now: number): Promise<void> {
	try {
		await syncCalendar(env, now);
		await setSetting(env, "last_sync_ok", String(now));
		await setSetting(env, "sync_fail_count", "0");
		await deleteSetting(env, "last_sync_error");
		if ((await getSetting(env, "sync_alerted")) === "1") {
			await deleteSetting(env, "sync_alerted");
			await sendAlert(env, "sync_ok", "Calendar sync is working again.");
		}
	} catch (err) {
		const fails = Number((await getSetting(env, "sync_fail_count")) ?? "0") + 1;
		await setSetting(env, "sync_fail_count", String(fails));
		await setSetting(env, "last_sync_error", String(err).slice(0, 500));
		console.error("calendar sync failed", err);
		if (fails >= 2 && (await getSetting(env, "sync_alerted")) !== "1") {
			await setSetting(env, "sync_alerted", "1");
			await sendAlert(
				env,
				"sync_failed",
				`Calendar sync failed ${fails} times in a row. The kiosk keeps showing the last good data. Error: ${String(err).slice(0, 200)}`,
			);
		}
	}
}
