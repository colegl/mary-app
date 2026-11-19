import type { Env } from "./env";

export async function getSetting(env: Env, key: string): Promise<string | null> {
	const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
	return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	)
		.bind(key, value)
		.run();
}

export async function deleteSetting(env: Env, key: string): Promise<void> {
	await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}

export async function getSettings(env: Env): Promise<Record<string, string>> {
	const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
	return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export function intSetting(s: Record<string, string>, key: string, fallback: number): number {
	const n = Number.parseInt(s[key] ?? "", 10);
	return Number.isFinite(n) ? n : fallback;
}
