import { test } from "node:test";
import assert from "node:assert/strict";
import { activeReminder, chimeKey, doseState, stripStatus } from "../public/app/shared/doses.js";

const M = 60_000;
const T = Date.parse("2026-12-01T20:00:00Z"); // noon in Los Angeles
const dose = (id, due, extra = {}) => ({
	id, dose: id.split(":")[1], date: "2026-12-01",
	due_at: due, remind_again_at: due + 30 * M, alert_at: due + 60 * M, expires_at: due + 180 * M,
	confirmed_at: null, skipped_at: null, ...extra,
});

test("reminder appears at dose time and not before", () => {
	const d = [dose("2026-12-01:noon", T)];
	assert.equal(activeReminder(d, T - 1, {}), null);
	assert.equal(activeReminder(d, T, {})?.id, "2026-12-01:noon");
	assert.equal(activeReminder(d, T + 179 * M, {})?.id, "2026-12-01:noon");
	assert.equal(activeReminder(d, T + 180 * M, {}), null);
});

test("double-dose guard: once confirmed, the reminder can't reappear", () => {
	const d = [dose("2026-12-01:noon", T, { confirmed_at: T + 5 * M })];
	assert.equal(activeReminder(d, T + 10 * M, {}), null);
	// Confirmed offline: only the kiosk knows so far.
	const d2 = [dose("2026-12-01:noon", T)];
	assert.equal(activeReminder(d2, T + 10 * M, { "2026-12-01:noon": T + 5 * M }), null);
});

test("skipped doses don't remind", () => {
	assert.equal(activeReminder([dose("2026-12-01:noon", T, { skipped_at: T })], T + M, {}), null);
});

test("chime once at the time, again at 30 minutes", () => {
	const d = dose("2026-12-01:noon", T);
	assert.equal(chimeKey(d, T - 1), null);
	assert.equal(chimeKey(d, T + M), "2026-12-01:noon:first");
	assert.equal(chimeKey(d, T + 30 * M), "2026-12-01:noon:again");
});

test("strip shows the last dose as done until the next one comes due", () => {
	const morning = dose("2026-12-01:morning", T - 4 * 60 * M, { confirmed_at: T - 230 * M });
	const noon = dose("2026-12-01:noon", T);
	assert.equal(stripStatus([morning, noon], T - M, {})?.id, morning.id);
	assert.equal(stripStatus([morning, noon], T + M, {}), null); // noon due, not yet confirmed
	assert.equal(stripStatus([morning, noon], T + 2 * M, { [noon.id]: T + M })?.id, noon.id);
});

test("dose states for the Today screen", () => {
	const d = dose("2026-12-01:noon", T);
	assert.equal(doseState(d, T - M), "later");
	assert.equal(doseState(d, T + M), "now");
	assert.equal(doseState(d, T + 200 * M), "past");
	assert.equal(doseState(d, T + 200 * M, { [d.id]: T }), "done");
});
