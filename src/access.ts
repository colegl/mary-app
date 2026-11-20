// Cloudflare Access check for the admin page and the Google sign-in routes.
// Access blocks strangers at the edge; this verifies its signed JWT as well, so the
// admin routes stay closed even if the Access application is misconfigured or removed.

import type { Env } from "./env";

interface Jwk {
	kid: string;
	kty: string;
	n: string;
	e: string;
	alg?: string;
}

let certCache: { at: number; keys: Jwk[] } | undefined;

function b64urlToBytes(s: string): Uint8Array {
	const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
	return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad), (c) => c.charCodeAt(0));
}

async function certs(env: Env): Promise<Jwk[]> {
	if (certCache && Date.now() - certCache.at < 3600_000) return certCache.keys;
	const res = await fetch(`${env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "")}/cdn-cgi/access/certs`);
	if (!res.ok) throw new Error(`Access certs ${res.status}`);
	const body = (await res.json()) as { keys: Jwk[] };
	certCache = { at: Date.now(), keys: body.keys };
	return body.keys;
}

export interface AccessUser {
	email: string;
}

export async function verifyAccess(env: Env, request: Request): Promise<AccessUser | null> {
	if (env.ADMIN_DEV_BYPASS === "1" && new URL(request.url).hostname === "127.0.0.1") {
		return { email: "dev@localhost" };
	}
	// Access not set up (the default): only the password sign-in applies.
	if (!env.ACCESS_AUD || env.ACCESS_AUD.startsWith("YOUR-") || env.ACCESS_TEAM_DOMAIN.includes("YOUR-TEAM")) return null;
	const token =
		request.headers.get("Cf-Access-Jwt-Assertion") ??
		/(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get("Cookie") ?? "")?.[1];
	if (!token) return null;
	try {
		const [h, p, s] = token.split(".");
		const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as { kid: string; alg: string };
		if (header.alg !== "RS256") return null;
		const jwk = (await certs(env)).find((k) => k.kid === header.kid);
		if (!jwk) return null;
		const key = await crypto.subtle.importKey(
			"jwk",
			{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		const ok = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			b64urlToBytes(s),
			new TextEncoder().encode(`${h}.${p}`),
		);
		if (!ok) return null;
		const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as {
			aud: string | string[];
			exp: number;
			iss: string;
			email?: string;
		};
		const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!aud.includes(env.ACCESS_AUD)) return null;
		if (claims.exp * 1000 < Date.now()) return null;
		if (claims.iss !== env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "")) return null;
		return { email: claims.email ?? "unknown" };
	} catch (err) {
		console.error("access verify failed", err);
		return null;
	}
}
