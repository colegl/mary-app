// Password sign-in for the admin page: the simple alternative to Cloudflare Access.
// Gary sets ADMIN_PASSWORD as a GitHub secret; the deploy copies it to the Worker.
// A successful sign-in sets a signed, HttpOnly cookie that lasts 30 days.

import type { Env } from "./env";
import { safeEqual } from "./crypto";
import { getSetting, setSetting } from "./db";

const COOKIE = "mk_admin";
const SESSION_DAYS = 30;
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60_000;

async function sign(password: string, msg: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
	return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function passwordEnabled(env: Env): boolean {
	return Boolean(env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length > 0);
}

/** True if the request carries a valid, unexpired admin session cookie. */
export async function hasSession(env: Env, request: Request): Promise<boolean> {
	if (!passwordEnabled(env)) return false;
	const raw = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(request.headers.get("Cookie") ?? "")?.[1];
	if (!raw) return false;
	const [exp, sig] = raw.split(".");
	if (!exp || !sig || Number(exp) < Date.now()) return false;
	return safeEqual(sig, await sign(env.ADMIN_PASSWORD!, `admin:${exp}`));
}

export async function sessionCookie(env: Env): Promise<string> {
	const exp = Date.now() + SESSION_DAYS * 86_400_000;
	const value = `${exp}.${await sign(env.ADMIN_PASSWORD!, `admin:${exp}`)}`;
	// Lax (not Strict) so the cookie comes along when Google sends you back after connecting the calendar.
	return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearCookie(): string {
	return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Checks a password, with a lockout after too many wrong tries. */
export async function checkPassword(
	env: Env,
	attempt: string,
	now: number,
): Promise<"ok" | "wrong" | "locked"> {
	const [countStr, startStr] = ((await getSetting(env, "login_fails")) ?? "0|0").split("|");
	let count = Number(countStr) || 0;
	let start = Number(startStr) || 0;
	if (now - start > FAIL_WINDOW_MS) {
		count = 0;
		start = now;
	}
	if (count >= MAX_FAILS) return "locked";
	if (passwordEnabled(env) && safeEqual(attempt, env.ADMIN_PASSWORD!)) {
		await setSetting(env, "login_fails", `0|${now}`);
		return "ok";
	}
	await setSetting(env, "login_fails", `${count + 1}|${start}`);
	return "wrong";
}

export function loginPage(message = ""): string {
	const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mary's kiosk admin</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
@font-face { font-family: "Atkinson Hyperlegible"; src: url("/fonts/atkinson-400.woff2") format("woff2"); font-weight: 400; }
@font-face { font-family: "Atkinson Hyperlegible"; src: url("/fonts/atkinson-700.woff2") format("woff2"); font-weight: 700; }
:root { --bg: #f6f2ea; --card: #fff; --ink: #1e2b33; --soft: #55606a; --line: #e2dccf; --teal: #1d6b66; --warn: #9a3412; }
@media (prefers-color-scheme: dark) { :root { --bg: #11181d; --card: #1a242b; --ink: #e8edf0; --soft: #9aa6af; --line: #2c3a43; --teal: #4fb3a9; --warn: #f4a36b; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--ink); font: 17px/1.45 "Atkinson Hyperlegible", system-ui, sans-serif; }
form { width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 24px; display: grid; gap: 14px; }
h1 { margin: 0; font-size: 24px; }
label { display: grid; gap: 6px; color: var(--soft); }
input { font: inherit; padding: 10px 12px; border-radius: 9px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
button { font: inherit; padding: 11px; border-radius: 9px; border: 0; background: var(--teal); color: #fff; font-weight: 700; cursor: pointer; }
.msg { color: var(--warn); margin: 0; }
</style>
</head>
<body>
<form method="post" action="/admin/login">
<h1>Mary's kiosk</h1>
${message ? `<p class="msg" role="alert">${esc(message)}</p>` : ""}
<label>Admin password <input type="password" name="password" autocomplete="current-password" required autofocus></label>
<button>Sign in</button>
</form>
</body>
</html>`;
}
