// Reads Gary's calendar from its private iCal address ("Secret address in iCal format"
// in Google Calendar settings). This needs no Google Cloud project or sign-in: Gary
// pastes the address into the admin page once.
//
// The feed holds the whole calendar, years of it. To stay well inside a Worker's CPU
// budget, plain string scanning first keeps only the "(Mary)" events and the time zone
// definitions, and only that small remainder is parsed and expanded by ical.js.

import ICAL from "ical.js";
import type { SyncedEvent } from "./calendar";
import { localParts, zonedToUtc } from "../public/app/shared/words.js";

const PREFIX = /^\s*\(mary\)\s*/i;
const MAX_OCCURRENCES = 500;
const MAX_STEPS = 50_000; // a daily event that started 100 years ago
const SLACK = 31 * 86_400_000;

/** Keep the calendar header, every VTIMEZONE, and only VEVENTs whose title starts with "(Mary)". */
export function prefilter(ics: string): string {
	const text = ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, ""); // unfold lines
	const out: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//mary-kiosk//prefilter//EN"];
	const blockRe = /BEGIN:(VTIMEZONE|VEVENT)\n[\s\S]*?\nEND:\1/g;
	for (const m of text.matchAll(blockRe)) {
		const block = m[0];
		if (m[1] === "VTIMEZONE") {
			out.push(block);
			continue;
		}
		const summary = /^SUMMARY(?:;[^:\n]*)?:(.*)$/m.exec(block)?.[1] ?? "";
		if (PREFIX.test(unescapeText(summary))) out.push(block);
	}
	out.push("END:VCALENDAR");
	return out.join("\r\n");
}

function unescapeText(s: string): string {
	return s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");
}

function dateString(t: ICAL.Time): string {
	return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

/** Epoch ms for an ICAL.Time. Floating times (no zone) are read in Mary's time zone. */
function toMs(t: ICAL.Time, tz: string): number {
	if (t.isDate) return zonedToUtc(dateString(t), "00:00", tz);
	if (t.zone && t.zone.tzid === "floating") {
		return zonedToUtc(dateString(t), `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`, tz);
	}
	return t.toJSDate().getTime();
}

function toEvent(uid: string, summary: string, start: ICAL.Time, end: ICAL.Time | null, tz: string): SyncedEvent {
	const startMs = toMs(start, tz);
	const allDay = start.isDate;
	return {
		// One id per occurrence, stable across syncs, so Gary's display text sticks to it.
		id: `ical:${uid}:${allDay ? dateString(start) : new Date(startMs).toISOString()}`,
		all_day: allDay,
		start_date: allDay ? dateString(start) : localParts(startMs, tz).date,
		start_at: startMs,
		end_at: end ? toMs(end, tz) : null,
		title: summary.replace(PREFIX, "").trim(),
	};
}

/** "(Mary)" events (recurrences expanded) that overlap [fromMs, toMs). */
export function parseMaryEvents(ics: string, fromMs: number, toMs_: number, tz: string): SyncedEvent[] {
	const root = new ICAL.Component(ICAL.parse(prefilter(ics)));
	for (const vtz of root.getAllSubcomponents("vtimezone")) {
		try {
			ICAL.TimezoneService.register(new ICAL.Timezone(vtz));
		} catch {
			/* a bad zone definition: events in it fall back to UTC */
		}
	}

	const masters = new Map<string, ICAL.Event>();
	const exceptions: ICAL.Event[] = [];
	for (const v of root.getAllSubcomponents("vevent")) {
		const ev = new ICAL.Event(v);
		if (ev.isRecurrenceException()) exceptions.push(ev);
		else masters.set(ev.uid, ev);
	}
	for (const ex of exceptions) masters.get(ex.uid)?.relateException(ex);

	const out: SyncedEvent[] = [];
	const cancelled = (c: ICAL.Component) => String(c.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";

	for (const ev of masters.values()) {
		if (cancelled(ev.component)) continue;
		if (!ev.isRecurring()) {
			const e = toEvent(ev.uid, ev.summary ?? "", ev.startDate, ev.endDate ?? null, tz);
			if (overlaps(e, fromMs, toMs_)) out.push(e);
			continue;
		}
		// Walk occurrences cheaply until near the window; a moved occurrence (an exception)
		// can land up to SLACK away from its original slot, so look a little either side.
		const it = ev.iterator();
		for (let i = 0, next = it.next(); next && i < MAX_STEPS; i++, next = it.next()) {
			const slotMs = next.toUnixTime() * 1000; // floating times read as UTC: hours off, well inside SLACK
			if (slotMs < fromMs - SLACK) continue;
			if (slotMs >= toMs_ + SLACK) break;
			const d = ev.getOccurrenceDetails(next);
			if (cancelled(d.item.component)) continue;
			const summary = d.item.summary ?? ev.summary ?? "";
			if (!PREFIX.test(summary)) continue; // an occurrence renamed away from "(Mary)"
			const e = toEvent(ev.uid, summary, d.startDate, d.endDate ?? null, tz);
			if (overlaps(e, fromMs, toMs_)) out.push(e);
			if (out.length >= MAX_OCCURRENCES) break;
		}
	}
	return out.sort((a, b) => a.start_at - b.start_at);
}

function overlaps(e: SyncedEvent, fromMs: number, toMs_: number): boolean {
	const end = e.end_at ?? e.start_at;
	return e.start_at < toMs_ && (end > fromMs || e.start_at >= fromMs);
}

/** Accepts the address as Google shows it (https or webcal) and checks it looks like a calendar feed. */
export function normalizeIcalUrl(raw: string): string | null {
	let url = raw.trim();
	if (url.startsWith("webcal://")) url = `https://${url.slice("webcal://".length)}`;
	try {
		const u = new URL(url);
		if (u.protocol !== "https:") return null;
		return u.href;
	} catch {
		return null;
	}
}
