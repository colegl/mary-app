export interface Env {
	DB: D1Database;
	PHOTOS: R2Bucket;
	ASSETS: Fetcher;

	PUBLIC_URL: string;
	TIMEZONE: string;
	CALENDAR_SOURCE: "google" | "mock";
	CALENDAR_ID: string;
	ALERT_PROVIDER: "ntfy" | "pushover";
	NTFY_SERVER: string;
	ACCESS_TEAM_DOMAIN: string;
	ACCESS_AUD: string;

	// Secrets
	KIOSK_TOKEN: string;
	TOKEN_ENCRYPTION_KEY: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	NTFY_TOPIC?: string;
	NTFY_TOKEN?: string;
	PUSHOVER_TOKEN?: string;
	PUSHOVER_USER?: string;
	ADMIN_PASSWORD?: string;
	ADMIN_DEV_BYPASS?: string;
}

/** App version the kiosk compares against to know when to reload (at 3 AM). Bump on deploy. */
export const APP_VERSION = "0.1.1";
