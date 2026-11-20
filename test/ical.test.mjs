import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIcalUrl, parseMaryEvents, prefilter } from "../src/ical.ts";
import { zonedToUtc } from "../public/app/shared/words.js";

const TZ = "America/New_York";

// Shaped like Google's export: folded lines, CRLF, a VTIMEZONE, and plenty of non-Mary events.
const ICS = [
	"BEGIN:VCALENDAR",
	"PRODID:-//Google Inc//Google Calendar 70.9054//EN",
	"VERSION:2.0",
	"X-WR-TIMEZONE:America/New_York",
	"BEGIN:VTIMEZONE",
	"TZID:America/New_York",
	"BEGIN:DAYLIGHT",
	"TZOFFSETFROM:-0500",
	"TZOFFSETTO:-0400",
	"TZNAME:EDT",
	"DTSTART:19700308T020000",
	"RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
	"END:DAYLIGHT",
	"BEGIN:STANDARD",
	"TZOFFSETFROM:-0400",
	"TZOFFSETTO:-0500",
	"TZNAME:EST",
	"DTSTART:19701101T020000",
	"RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
	"END:STANDARD",
	"END:VTIMEZONE",
	// Weekly on Tuesdays 10:00 from Oct 27, minus Nov 17 (EXDATE), and Nov 24 moved to 14:00.
	"BEGIN:VEVENT",
	"DTSTART;TZID=America/New_York:20261027T100000",
	"DTEND;TZID=America/New_York:20261027T110000",
	"RRULE:FREQ=WEEKLY;BYDAY=TU",
	"EXDATE;TZID=America/New_York:20261117T100000",
	"UID:weekly@google.com",
	"SUMMARY:(Mary) Hair\\, then lunch",
	"END:VEVENT",
	"BEGIN:VEVENT",
	"DTSTART;TZID=America/New_York:20261124T140000",
	"DTEND;TZID=America/New_York:20261124T150000",
	"RECURRENCE-ID;TZID=America/New_York:20261124T100000",
	"UID:weekly@google.com",
	"SUMMARY:(Mary) Hair\\, then lunch",
	"END:VEVENT",
	// All-day.
	"BEGIN:VEVENT",
	"DTSTART;VALUE=DATE:20261126",
	"DTEND;VALUE=DATE:20261127",
	"UID:thanks@google.com",
	"SUMMARY:(mary) Thanksgiving at Molly's",
	"END:VEVENT",
	// UTC time, title folded across lines.
	"BEGIN:VEVENT",
	"DTSTART:20261123T150000Z",
	"DTEND:20261123T160000Z",
	"UID:doctor@google.com",
	"SUMMARY:(Mary) Dr. Patel che",
	" ckup",
	"END:VEVENT",
	// Not Mary's.
	"BEGIN:VEVENT",
	"DTSTART:20261123T170000Z",
	"DTEND:20261123T180000Z",
	"UID:gary@google.com",
	"SUMMARY:Gary dentist",
	"END:VEVENT",
	// Cancelled.
	"BEGIN:VEVENT",
	"DTSTART:20261125T170000Z",
	"UID:cancelled@google.com",
	"STATUS:CANCELLED",
	"SUMMARY:(Mary) Called off",
	"END:VEVENT",
	// Long past.
	"BEGIN:VEVENT",
	"DTSTART:20190101T170000Z",
	"UID:old@google.com",
	"SUMMARY:(Mary) Old",
	"END:VEVENT",
	"END:VCALENDAR",
	"",
].join("\r\n");

const from = zonedToUtc("2026-11-16", "00:00", TZ);
const to = zonedToUtc("2026-11-30", "00:00", TZ);

test("prefilter keeps only Mary events and time zones", () => {
	const out = prefilter(ICS);
	assert.match(out, /BEGIN:VTIMEZONE/);
	assert.doesNotMatch(out, /Gary dentist/);
	assert.match(out, /Dr\. Patel checkup/);
});

test("expands recurrences, applies exceptions, and reads time zones", () => {
	const events = parseMaryEvents(ICS, from, to, TZ);
	const rows = events.map((e) => [e.start_date, e.all_day ? "all day" : new Date(e.start_at).toISOString(), e.title]);
	assert.deepEqual(rows, [
		["2026-11-23", "2026-11-23T15:00:00.000Z", "Dr. Patel checkup"],
		["2026-11-24", "2026-11-24T19:00:00.000Z", "Hair, then lunch"], // moved to 2 PM EST
		["2026-11-26", "all day", "Thanksgiving at Molly's"],
	]);
	const thanks = events.find((e) => e.all_day);
	assert.equal(thanks.start_at, zonedToUtc("2026-11-26", "00:00", TZ));
	assert.equal(thanks.end_at, zonedToUtc("2026-11-27", "00:00", TZ));
});

test("ids stay stable per occurrence", () => {
	const a = parseMaryEvents(ICS, from, to, TZ).map((e) => e.id);
	const b = parseMaryEvents(ICS, from, to, TZ).map((e) => e.id);
	assert.deepEqual(a, b);
	assert.equal(new Set(a).size, a.length);
});

test("daylight time: an October occurrence is at 10 AM EDT", () => {
	const oct = parseMaryEvents(ICS, zonedToUtc("2026-10-27", "00:00", TZ), zonedToUtc("2026-10-28", "00:00", TZ), TZ);
	assert.equal(oct.length, 1);
	assert.equal(new Date(oct[0].start_at).toISOString(), "2026-10-27T14:00:00.000Z");
});

test("normalizeIcalUrl", () => {
	assert.equal(normalizeIcalUrl(" webcal://calendar.google.com/x/basic.ics "), "https://calendar.google.com/x/basic.ics");
	assert.equal(normalizeIcalUrl("http://example.com/a.ics"), null);
	assert.equal(normalizeIcalUrl("not a url"), null);
});

test("an old daily repeating event is still found, quickly", () => {
	const daily = ICS.replace(
		"END:VCALENDAR",
		[
			"BEGIN:VEVENT",
			"DTSTART;TZID=America/New_York:20100101T090000",
			"DTEND;TZID=America/New_York:20100101T091500",
			"RRULE:FREQ=DAILY",
			"UID:daily@google.com",
			"SUMMARY:(Mary) Morning walk",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n"),
	);
	const t0 = performance.now();
	const walks = parseMaryEvents(daily, from, to, TZ).filter((e) => e.title === "Morning walk");
	const ms = performance.now() - t0;
	assert.equal(walks.length, 14);
	assert.equal(new Date(walks[0].start_at).toISOString(), "2026-11-16T14:00:00.000Z");
	assert.ok(ms < 1000, `took ${ms} ms`);
	console.log(`# daily since 2010: ${ms.toFixed(0)} ms`);
});
