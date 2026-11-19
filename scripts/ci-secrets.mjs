// Builds the secrets file for `wrangler deploy --secrets-file` in the GitHub Action.
//
// - Copies the Worker secrets Gary keeps in GitHub (only the ones that are set).
// - Generates KIOSK_TOKEN and TOKEN_ENCRYPTION_KEY the first time, and never again:
//   if the Worker already has them they are left alone, because changing either one
//   would sign the kiosk out or lose the Google Calendar connection.
//
// Usage: node scripts/ci-secrets.mjs <existing-secret-names.json> <out.json>
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [existingPath, outPath] = process.argv.slice(2);

// The workflow writes [] for a first deploy and stops on any other error, so a file
// that can't be read is a bug: fail rather than regenerate keys the kiosk depends on.
const existing = JSON.parse(readFileSync(existingPath, "utf8")).map((s) => s.name);

const FROM_GITHUB = [
	"GOOGLE_CLIENT_ID",
	"GOOGLE_CLIENT_SECRET",
	"NTFY_TOPIC",
	"NTFY_TOKEN",
	"PUSHOVER_TOKEN",
	"PUSHOVER_USER",
];

const out = {};
for (const name of FROM_GITHUB) {
	const v = process.env[name];
	if (v && v.trim()) out[name] = v.trim();
}

if (!existing.includes("KIOSK_TOKEN")) out.KIOSK_TOKEN = randomBytes(30).toString("base64url");
if (!existing.includes("TOKEN_ENCRYPTION_KEY")) out.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");

writeFileSync(outPath, JSON.stringify(out), { mode: 0o600 });
// Names only, never values.
console.log(`Secrets in this deploy: ${Object.keys(out).join(", ") || "(none new)"}`);
if (existing.length) console.log(`Already on the Worker: ${existing.join(", ")}`);
