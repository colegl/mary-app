// Push alerts to Gary's Pixel through ntfy or Pushover. Every alert is also logged in D1,
// so the admin page shows what was sent even if delivery failed.

import type { Env } from "./env";

export type AlertKind =
	| "missed_dose"
	| "late_confirm"
	| "offline"
	| "online"
	| "sync_failed"
	| "sync_ok"
	| "test";

const URGENT: AlertKind[] = ["missed_dose", "offline"];

const TITLES: Record<AlertKind, string> = {
	missed_dose: "Mary: dose not confirmed",
	late_confirm: "Mary: dose confirmed late",
	offline: "Mary's kiosk is offline",
	online: "Mary's kiosk is back",
	sync_failed: "Mary's kiosk: calendar sync failing",
	sync_ok: "Mary's kiosk: calendar sync recovered",
	test: "Mary's kiosk: test alert",
};

async function deliver(env: Env, kind: AlertKind, message: string): Promise<{ ok: boolean; detail: string }> {
	const title = TITLES[kind];
	const urgent = URGENT.includes(kind);
	const adminUrl = new URL("/admin/", env.PUBLIC_URL).href;

	if (env.ALERT_PROVIDER === "pushover") {
		if (!env.PUSHOVER_TOKEN || !env.PUSHOVER_USER) return { ok: false, detail: "Pushover secrets not set" };
		const body = new URLSearchParams({
			token: env.PUSHOVER_TOKEN,
			user: env.PUSHOVER_USER,
			title,
			message,
			priority: urgent ? "1" : "0",
			url: adminUrl,
			url_title: "Open the kiosk admin",
		});
		const res = await fetch("https://api.pushover.net/1/messages.json", { method: "POST", body });
		return { ok: res.ok, detail: `pushover ${res.status}` };
	}

	if (!env.NTFY_TOPIC) return { ok: false, detail: "NTFY_TOPIC not set" };
	const headers: Record<string, string> = {
		Title: title,
		Priority: urgent ? "high" : "default",
		Tags: urgent ? "warning" : kind === "test" ? "test_tube" : "information_source",
		Click: adminUrl,
	};
	if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
	const server = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
	const res = await fetch(`${server}/${encodeURIComponent(env.NTFY_TOPIC)}`, {
		method: "POST",
		headers,
		body: message,
	});
	return { ok: res.ok, detail: `ntfy ${res.status}` };
}

export async function sendAlert(env: Env, kind: AlertKind, message: string): Promise<boolean> {
	let result: { ok: boolean; detail: string };
	try {
		result = await deliver(env, kind, message);
	} catch (err) {
		result = { ok: false, detail: String(err) };
	}
	await env.DB.prepare("INSERT INTO alerts (at, kind, message, delivered, detail) VALUES (?, ?, ?, ?, ?)")
		.bind(Date.now(), kind, message, result.ok ? 1 : 0, result.detail)
		.run();
	if (!result.ok) console.error("alert not delivered", kind, result.detail);
	return result.ok;
}
