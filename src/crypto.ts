// AES-GCM for the one secret kept in D1: the Google Calendar refresh token.

function b64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function unb64(s: string): Uint8Array {
	return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
	const raw = unb64(secret);
	if (raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be base64 of 32 bytes");
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(secret: string, plain: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), new TextEncoder().encode(plain)),
	);
	return `${b64(iv)}.${b64(ct)}`;
}

export async function decrypt(secret: string, sealed: string): Promise<string> {
	const [iv, ct] = sealed.split(".");
	const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(secret), unb64(ct));
	return new TextDecoder().decode(pt);
}

/** Constant-time string comparison for the kiosk token. */
export function safeEqual(a: string, b: string): boolean {
	const ea = new TextEncoder().encode(a);
	const eb = new TextEncoder().encode(b);
	if (ea.length !== eb.length) return false;
	let diff = 0;
	for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
	return diff === 0;
}
