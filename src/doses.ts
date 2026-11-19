// The medication loop on the server: dose instances, the every-minute watcher,
// confirmations from the kiosk, and Gary's overrides.

import type { Env } from "./env";
import { sendAlert } from "./alerts";
import { addDays, doseWords, localParts, timeWords, zonedToUtc } from "../public/app/shared/words.js";

const MIN = 60_000;

export interface ScheduleRow {
	dose: string;
	time: string;
	enabled: number;
	remind_again_min: number;
	window_min: number;
	expire_min: number;
	pillbox_photo: string | null;
}

export interface DoseRow {
	id: string;
	date: string;
	dose: string;
	due_at: number;
	remind_again_at: number;
	alert_at: number;
	expires_at: number;
	pillbox_photo: string | null;
	reminded_at: number | null;
	re_reminded_at: number | null;
	confirmed_at: number | null;
	confirmed_by: string | null;
	received_at: number | null;
	skipped_at: number | null;
	alerted_at: number | null;
	late_notice_at: number | null;
}

export async function getSchedule(env: Env): Promise<ScheduleRow[]> {
	const { results } = await env.DB.prepare(
		"SELECT * FROM med_schedule ORDER BY CASE dose WHEN 'morning' THEN 0 WHEN 'noon' THEN 1 ELSE 2 END",
	).all<ScheduleRow>();
	return results;
}

/**
 * Create today's and tomorrow's dose rows from the schedule (idempotent). Only future doses
 * are created: a dose turned on or moved after its time has passed starts tomorrow, so a
 * schedule change never raises an alert for a time that's already gone.
 */
export async function ensureInstances(env: Env, now: number): Promise<void> {
	const today = localParts(now, env.TIMEZONE).date;
	const schedule = (await getSchedule(env)).filter((s) => s.enabled);
	const stmts: D1PreparedStatement[] = [];
	for (const date of [today, addDays(today, 1)]) {
		for (const s of schedule) {
			const due = zonedToUtc(date, s.time, env.TIMEZONE);
			if (due <= now) continue;
			stmts.push(
				env.DB.prepare(
					`INSERT OR IGNORE INTO dose_log (id, date, dose, due_at, remind_again_at, alert_at, expires_at, pillbox_photo)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				).bind(
					`${date}:${s.dose}`,
					date,
					s.dose,
					due,
					due + s.remind_again_min * MIN,
					due + s.window_min * MIN,
					due + Math.max(s.expire_min, s.window_min) * MIN,
					s.pillbox_photo,
				),
			);
		}
	}
	if (stmts.length) await env.DB.batch(stmts);
}

/** After Gary edits the schedule: rebuild rows that haven't come due yet. */
export async function rebuildFuture(env: Env, now: number): Promise<void> {
	await env.DB.prepare(
		"DELETE FROM dose_log WHERE dose != 'test' AND due_at > ? AND confirmed_at IS NULL AND skipped_at IS NULL",
	)
		.bind(now)
		.run();
	await ensureInstances(env, now);
}

/** Dose rows the kiosk needs: today, tomorrow, and any live test dose. */
export async function kioskDoses(env: Env, now: number): Promise<DoseRow[]> {
	const today = localParts(now, env.TIMEZONE).date;
	const { results } = await env.DB.prepare(
		`SELECT * FROM dose_log
		 WHERE (dose != 'test' AND date IN (?, ?)) OR (dose = 'test' AND expires_at > ?)
		 ORDER BY due_at`,
	)
		.bind(today, addDays(today, 1), now)
		.all<DoseRow>();
	return results;
}

function describeDue(env: Env, d: DoseRow): string {
	const p = localParts(d.due_at, env.TIMEZONE);
	return timeWords(p.h, p.mi);
}

/** Every minute: note doses coming due and alert Gary about unconfirmed ones. */
export async function watchDoses(env: Env, now: number): Promise<void> {
	await ensureInstances(env, now);
	await env.DB.batch([
		env.DB.prepare("UPDATE dose_log SET reminded_at = ? WHERE reminded_at IS NULL AND due_at <= ?").bind(now, now),
		env.DB.prepare("UPDATE dose_log SET re_reminded_at = ? WHERE re_reminded_at IS NULL AND remind_again_at <= ?").bind(
			now,
			now,
		),
	]);

	// Alert once per dose. Ignore anything more than 6 hours stale (e.g. the Worker was paused).
	const { results } = await env.DB.prepare(
		`SELECT * FROM dose_log
		 WHERE alerted_at IS NULL AND confirmed_at IS NULL AND skipped_at IS NULL
		   AND alert_at <= ? AND alert_at > ?`,
	)
		.bind(now, now - 6 * 60 * MIN)
		.all<DoseRow>();

	for (const d of results) {
		// Claim the row first so an overlapping cron run can't double-send.
		const claim = await env.DB.prepare("UPDATE dose_log SET alerted_at = ? WHERE id = ? AND alerted_at IS NULL")
			.bind(now, d.id)
			.run();
		if (!claim.meta.changes) continue;
		const mins = Math.round((now - d.due_at) / MIN);
		const test = d.dose === "test" ? "[TEST] " : "";
		await sendAlert(
			env,
			"missed_dose",
			`${test}Mary hasn't tapped "I took them" for her ${doseWords(d.dose)} (due ${describeDue(env, d)}, ${mins} min ago). ` +
				`Check the pillbox, then mark it done or skipped in the admin page.`,
		);
	}
}

export type ConfirmResult = { ok: true; dose: DoseRow } | { ok: false; reason: string };

/** Mary tapped "I took them" (possibly a while ago, if the kiosk was offline). */
export async function confirmDose(
	env: Env,
	id: string,
	tappedAt: number,
	source: "kiosk" | "admin",
	now: number,
): Promise<ConfirmResult> {
	const d = await env.DB.prepare("SELECT * FROM dose_log WHERE id = ?").bind(id).first<DoseRow>();
	if (!d) return { ok: false, reason: "unknown dose" };
	if (d.confirmed_at) return { ok: true, dose: d }; // already recorded: the kiosk may retry
	if (source === "kiosk" && d.skipped_at) return { ok: false, reason: "dose was skipped" };
	if (source === "kiosk" && tappedAt < d.due_at - 5 * MIN) return { ok: false, reason: "dose not due yet" };

	// Trust the kiosk's clock only within sane bounds.
	const at = Math.min(Math.max(tappedAt, d.due_at - 5 * MIN), now);
	await env.DB.prepare(
		"UPDATE dose_log SET confirmed_at = ?, confirmed_by = ?, received_at = ? WHERE id = ? AND confirmed_at IS NULL",
	)
		.bind(at, source, now, id)
		.run();
	const updated = (await env.DB.prepare("SELECT * FROM dose_log WHERE id = ?").bind(id).first<DoseRow>())!;

	// If Gary was already alerted, tell him it was confirmed after all.
	if (updated.alerted_at && !updated.late_notice_at && source === "kiosk") {
		await env.DB.prepare("UPDATE dose_log SET late_notice_at = ? WHERE id = ?").bind(now, id).run();
		const p = localParts(at, env.TIMEZONE);
		const test = d.dose === "test" ? "[TEST] " : "";
		const delayed = now - at > 5 * MIN ? " (the kiosk sent it late, it was offline)" : "";
		await sendAlert(
			env,
			"late_confirm",
			`${test}Mary tapped "I took them" for her ${doseWords(d.dose)} at ${timeWords(p.h, p.mi)}${delayed}.`,
		);
	}
	return { ok: true, dose: updated };
}

export async function skipDose(env: Env, id: string, now: number): Promise<boolean> {
	const r = await env.DB.prepare("UPDATE dose_log SET skipped_at = ? WHERE id = ? AND confirmed_at IS NULL")
		.bind(now, id)
		.run();
	return r.meta.changes > 0;
}

/** Undo Gary's done/skipped mark (not Mary's own tap). */
export async function reopenDose(env: Env, id: string): Promise<boolean> {
	const r = await env.DB.prepare(
		`UPDATE dose_log SET skipped_at = NULL,
		   confirmed_at = CASE WHEN confirmed_by = 'admin' THEN NULL ELSE confirmed_at END,
		   confirmed_by = CASE WHEN confirmed_by = 'admin' THEN NULL ELSE confirmed_by END
		 WHERE id = ?`,
	)
		.bind(id)
		.run();
	return r.meta.changes > 0;
}

/** A dry-run dose that exercises the whole loop on short timings. */
export async function createTestDose(
	env: Env,
	now: number,
	opts: { inMin: number; remindAgainMin: number; alertMin: number; expireMin: number },
): Promise<DoseRow> {
	const id = `test:${crypto.randomUUID().slice(0, 8)}`;
	const due = now + opts.inMin * MIN;
	const date = localParts(due, env.TIMEZONE).date;
	await env.DB.prepare(
		`INSERT INTO dose_log (id, date, dose, due_at, remind_again_at, alert_at, expires_at)
		 VALUES (?, ?, 'test', ?, ?, ?, ?)`,
	)
		.bind(
			id,
			date,
			due,
			due + opts.remindAgainMin * MIN,
			due + opts.alertMin * MIN,
			due + Math.max(opts.expireMin, opts.alertMin) * MIN,
		)
		.run();
	return (await env.DB.prepare("SELECT * FROM dose_log WHERE id = ?").bind(id).first<DoseRow>())!;
}

export async function cancelTestDoses(env: Env, now: number): Promise<void> {
	await env.DB.prepare(
		"UPDATE dose_log SET expires_at = ?, skipped_at = COALESCE(skipped_at, ?) WHERE dose = 'test' AND expires_at > ?",
	)
		.bind(now, now, now)
		.run();
}
