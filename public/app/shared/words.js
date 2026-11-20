// Plain-language time and date wording, shared by the kiosk (browser) and the Worker.
// Rule from the spec: times read as "11:30 in the morning", never "11:30 AM".

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
];

const partsCache = new Map();
function formatterFor(tz) {
	let f = partsCache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			weekday: "short",
		});
		partsCache.set(tz, f);
	}
	return f;
}

const WD_SHORT = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in a time zone. */
export function localParts(ms, tz) {
	const out = {};
	for (const p of formatterFor(tz).formatToParts(new Date(ms))) out[p.type] = p.value;
	const y = Number(out.year), mo = Number(out.month), d = Number(out.day);
	const h = Number(out.hour) % 24, mi = Number(out.minute);
	return {
		y, mo, d, h, mi,
		s: Number(out.second),
		weekday: WD_SHORT[out.weekday],
		date: `${out.year}-${out.month}-${out.day}`,
	};
}

function offsetMs(ms, tz) {
	const p = localParts(ms, tz);
	return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` reads `date` (YYYY-MM-DD) `hhmm` (HH:MM). */
export function zonedToUtc(date, hhmm, tz) {
	const [y, mo, d] = date.split("-").map(Number);
	const [h, mi] = hhmm.split(":").map(Number);
	const guess = Date.UTC(y, mo - 1, d, h, mi);
	let ms = guess - offsetMs(guess, tz);
	// Second pass settles DST transitions.
	ms = guess - offsetMs(ms, tz);
	return ms;
}

/** YYYY-MM-DD plus n days (calendar arithmetic, zone-free). */
export function addDays(date, n) {
	const [y, mo, d] = date.split("-").map(Number);
	const t = new Date(Date.UTC(y, mo - 1, d + n));
	return t.toISOString().slice(0, 10);
}

export function weekdayOf(date) {
	const [y, mo, d] = date.split("-").map(Number);
	return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

export function weekdayName(date) {
	return WEEKDAYS[weekdayOf(date)];
}

export function monthDay(date) {
	const [, mo, d] = date.split("-").map(Number);
	return `${MONTHS[mo - 1]} ${d}`;
}

/** "morning" | "afternoon" | "evening" | "night" */
export function partOfDay(h) {
	if (h >= 5 && h < 12) return "morning";
	if (h >= 12 && h < 17) return "afternoon";
	if (h >= 17 && h < 21) return "evening";
	return "night";
}

/** "9:42" (12-hour clock, no AM/PM: the part of day is always beside it). */
export function clockText(h, mi) {
	const h12 = h % 12 === 0 ? 12 : h % 12;
	return `${h12}:${String(mi).padStart(2, "0")}`;
}

function bareTime(h, mi) {
	const h12 = h % 12 === 0 ? 12 : h % 12;
	return mi === 0 ? `${h12}` : `${h12}:${String(mi).padStart(2, "0")}`;
}

/** "11:30 in the morning", "3 in the afternoon", "12 noon", "midnight", "10 at night". */
export function timeWords(h, mi) {
	if (h === 12 && mi === 0) return "12 noon";
	if (h === 0 && mi === 0) return "midnight";
	const t = bareTime(h, mi);
	const part = partOfDay(h);
	if (part === "night") return `${t} at night`;
	return `${t} in the ${part}`;
}

/**
 * A time range in words. Drops the repeated part of day when both ends share it:
 * "11:30 in the morning until 3 in the afternoon", "2 until 4 in the afternoon".
 */
export function rangeWords(sh, smi, eh, emi) {
	if (eh === undefined) return timeWords(sh, smi);
	const sameDayPart = partOfDay(sh) === partOfDay(eh) && !(sh === 12 && smi === 0) && !(eh === 12 && emi === 0);
	if (sameDayPart) return `${bareTime(sh, smi)} until ${timeWords(eh, emi)}`;
	return `${timeWords(sh, smi)} until ${timeWords(eh, emi)}`;
}

/** "Tuesday morning" for the orientation strip. */
export function dayAndPart(p) {
	return `${WEEKDAYS[p.weekday]} ${partOfDay(p.h)}`;
}

/** Label for a future day relative to today: { main, sub }. */
export function dayLabel(date, today) {
	const diff = Math.round((Date.parse(date) - Date.parse(today)) / 86400000);
	const wd = weekdayName(date);
	if (diff === 0) return { main: "Today", sub: wd };
	if (diff === 1) return { main: "Tomorrow", sub: wd };
	if (diff < 7) return { main: wd, sub: monthDay(date) };
	return { main: `Next ${wd}`, sub: monthDay(date) };
}

const DOSE_WORDS = { morning: "morning pills", noon: "noon pills", evening: "evening pills", test: "test pills" };

/** "noon pills" */
export function doseWords(dose) {
	return DOSE_WORDS[dose] ?? `${dose} pills`;
}

export function capitalize(s) {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * True when h:mi is inside the night window: from `start` up to (not including) `end`,
 * both "HH:MM". The window may cross midnight (21:00 to 07:00). Equal times mean no night.
 */
export function isNight(h, mi, start, end) {
	const m = (t) => {
		const [a, b] = String(t ?? "").split(":").map(Number);
		return Number.isFinite(a) && Number.isFinite(b) ? a * 60 + b : null;
	};
	const s = m(start);
	const e = m(end);
	if (s === null || e === null || s === e) return false;
	const t = h * 60 + mi;
	return s < e ? t >= s && t < e : t >= s || t < e;
}
