// Push alerts to Gary's Pixel through ntfy or Pushover. Every alert is also logged in D1,
// so the admin page shows what was sent even if delivery failed.

import type { Env } from "./env";
import { getSetting, setSetting } from "./db";

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

/**
 * The ntfy topic alerts go to. An NTFY_TOPIC secret wins; otherwise the Worker makes up a
 * long random one on first use and keeps it in D1, and the admin page shows a one-tap
 * link to subscribe to it on the phone. Anyone who knows the topic can read the alerts,
 * which is why it's random and never in the repository.
 */
export async function ntfyTopic(env: Env): Promise<string> {
	if (env.NTFY_TOPIC) return env.NTFY_TOPIC;
	const saved = await getSetting(env, "ntfy_topic");
	if (saved) return saved;
	const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	const topic = `mary-kiosk-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
	await setSetting(env, "ntfy_topic", topic);
	return topic;
}

export function ntfyServer(env: Env): string {
	return (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
}

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

	const topic = await ntfyTopic(env);
	const headers: Record<string, string> = {
		Title: title,
		Priority: urgent ? "high" : "default",
		Tags: urgent ? "warning" : kind === "test" ? "test_tube" : "information_source",
		Click: adminUrl,
	};
	if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
	const res = await fetch(`${ntfyServer(env)}/${encodeURIComponent(topic)}`, {
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
