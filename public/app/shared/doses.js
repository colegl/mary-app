// Dose logic shared by the kiosk and the Worker.
//
// A dose instance (one row of dose_log, as /api/state returns it):
//   { id, date, dose, due_at, remind_again_at, alert_at, expires_at,
//     confirmed_at, skipped_at, has_photo }
// All times are epoch milliseconds.
//
// `local` is the kiosk's own record of taps not yet acknowledged by the server
// ({ [doseId]: confirmedAtMs }), so a tap made offline still closes the dose.

export function isConfirmed(d, local = {}) {
	return Boolean(d.confirmed_at || local[d.id]);
}

export function isClosed(d, local = {}) {
	return Boolean(isConfirmed(d, local) || d.skipped_at);
}

/** The dose the reminder screen should show now, or null. Latest due wins. */
export function activeReminder(doses, now, local = {}) {
	let best = null;
	for (const d of doses) {
		if (isClosed(d, local)) continue;
		if (now < d.due_at || now >= d.expires_at) continue;
		if (!best || d.due_at > best.due_at) best = d;
	}
	return best;
}

/**
 * Which chime this dose is owed now: "first" at its time, "again" at the re-reminder.
 * The kiosk remembers keys it has played so each chime sounds once.
 */
export function chimeKey(d, now) {
	if (now >= d.remind_again_at) return `${d.id}:again`;
	if (now >= d.due_at) return `${d.id}:first`;
	return null;
}

/**
 * The status chip on the frame strip: the most recent dose that has come due,
 * shown as done once confirmed. It stays until the next dose comes due.
 * Missed or skipped doses show nothing: Mary never sees a failure.
 */
export function stripStatus(doses, now, local = {}) {
	let latest = null;
	for (const d of doses) {
		if (d.dose === "test") continue;
		if (d.due_at > now) continue;
		if (!latest || d.due_at > latest.due_at) latest = d;
	}
	if (latest && isConfirmed(latest, local)) return latest;
	return null;
}

/** Status of each of today's doses for the Today screen: "done" | "now" | "later" | "past". */
export function doseState(d, now, local = {}) {
	if (isConfirmed(d, local)) return "done";
	if (d.skipped_at) return "past";
	if (now < d.due_at) return "later";
	if (now < d.expires_at) return "now";
	return "past";
}
