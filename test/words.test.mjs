import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, dayLabel, localParts, partOfDay, rangeWords, timeWords, zonedToUtc, dayAndPart, clockText } from "../public/app/shared/words.js";

test("time words read naturally", () => {
	assert.equal(timeWords(11, 30), "11:30 in the morning");
	assert.equal(timeWords(15, 0), "3 in the afternoon");
	assert.equal(timeWords(12, 0), "12 noon");
	assert.equal(timeWords(12, 30), "12:30 in the afternoon");
	assert.equal(timeWords(0, 0), "midnight");
	assert.equal(timeWords(22, 0), "10 at night");
	assert.equal(timeWords(18, 15), "6:15 in the evening");
});

test("ranges drop a repeated part of day", () => {
	assert.equal(rangeWords(11, 30, 15, 0), "11:30 in the morning until 3 in the afternoon");
	assert.equal(rangeWords(14, 0, 16, 0), "2 until 4 in the afternoon");
	assert.equal(rangeWords(10, 0, 12, 0), "10 in the morning until 12 noon");
});

test("part of day and clock", () => {
	assert.equal(partOfDay(9), "morning");
	assert.equal(partOfDay(13), "afternoon");
	assert.equal(partOfDay(19), "evening");
	assert.equal(partOfDay(23), "night");
	assert.equal(partOfDay(3), "night");
	assert.equal(clockText(0, 5), "12:05");
	assert.equal(clockText(21, 42), "9:42");
});

test("zoned times round-trip, including DST days", () => {
	const tz = "America/Los_Angeles";
	for (const [date, hhmm] of [["2026-12-01", "09:42"], ["2026-03-08", "08:00"], ["2026-11-01", "08:00"], ["2026-07-04", "23:59"]]) {
		const ms = zonedToUtc(date, hhmm, tz);
		const p = localParts(ms, tz);
		assert.equal(p.date, date);
		assert.equal(`${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`, hhmm);
	}
	assert.equal(new Date(zonedToUtc("2026-12-01", "12:00", tz)).toISOString(), "2026-12-01T20:00:00.000Z");
	assert.equal(new Date(zonedToUtc("2026-07-01", "12:00", tz)).toISOString(), "2026-07-01T19:00:00.000Z");
});

test("strip wording", () => {
	const p = localParts(Date.parse("2026-12-01T17:42:00Z"), "America/Los_Angeles");
	assert.equal(dayAndPart(p), "Tuesday morning");
});

test("day labels", () => {
	assert.deepEqual(dayLabel("2026-12-02", "2026-12-01"), { main: "Tomorrow", sub: "Wednesday" });
	assert.deepEqual(dayLabel("2026-12-04", "2026-12-01"), { main: "Friday", sub: "December 4" });
	assert.deepEqual(dayLabel("2026-12-08", "2026-12-01"), { main: "Next Tuesday", sub: "December 8" });
	assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});
