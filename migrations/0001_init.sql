-- Mary's helper kiosk: initial schema. Times are epoch milliseconds unless named *_date or time.

-- Events synced from Gary's Google Calendar (titles starting "(Mary)").
-- display_text and hidden are Gary's edits and survive every sync.
CREATE TABLE events (
	id TEXT PRIMARY KEY,              -- Google event id (instance id for recurring events)
	calendar_id TEXT NOT NULL,
	start_at INTEGER NOT NULL,        -- for all-day events: local midnight of start date
	end_at INTEGER,
	start_date TEXT NOT NULL,         -- local YYYY-MM-DD
	all_day INTEGER NOT NULL DEFAULT 0,
	title TEXT NOT NULL,              -- calendar title with "(Mary)" removed
	display_text TEXT,                -- shown instead of the title when set
	hidden INTEGER NOT NULL DEFAULT 0,
	synced_at INTEGER NOT NULL
);
CREATE INDEX events_start ON events (start_at);

-- Curated photos in R2.
CREATE TABLE photos (
	id TEXT PRIMARY KEY,
	r2_key TEXT NOT NULL,
	caption TEXT NOT NULL DEFAULT '',
	people TEXT NOT NULL DEFAULT '',   -- comma-separated names, matched against today's events
	active INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL
);

-- The three daily doses. Times are local HH:MM, set by Gary in the admin page.
CREATE TABLE med_schedule (
	dose TEXT PRIMARY KEY,             -- morning | noon | evening
	time TEXT NOT NULL,                -- HH:MM local
	enabled INTEGER NOT NULL DEFAULT 0,
	remind_again_min INTEGER NOT NULL DEFAULT 30,
	window_min INTEGER NOT NULL DEFAULT 60,   -- minutes before Gary is alerted
	expire_min INTEGER NOT NULL DEFAULT 180,  -- minutes the reminder stays up
	pillbox_photo TEXT                 -- R2 key of the compartment photo
);
INSERT INTO med_schedule (dose, time) VALUES ('morning', '08:00'), ('noon', '12:00'), ('evening', '18:00');

-- One row per dose per day (plus test doses). Created ahead of time so the kiosk
-- can run a day offline from its cache.
CREATE TABLE dose_log (
	id TEXT PRIMARY KEY,               -- "<date>:<dose>" or "test:<uuid>"
	date TEXT NOT NULL,
	dose TEXT NOT NULL,
	due_at INTEGER NOT NULL,
	remind_again_at INTEGER NOT NULL,
	alert_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	pillbox_photo TEXT,
	reminded_at INTEGER,               -- server saw the dose come due
	re_reminded_at INTEGER,
	confirmed_at INTEGER,              -- when Mary tapped (kiosk clock) or Gary marked done
	confirmed_by TEXT,                 -- kiosk | admin
	received_at INTEGER,               -- when the server learned of the confirmation
	skipped_at INTEGER,                -- Gary marked it skipped
	alerted_at INTEGER,                -- missed-dose alert sent
	late_notice_at INTEGER             -- "confirmed after all" follow-up sent
);
CREATE INDEX dose_log_due ON dose_log (due_at);

CREATE TABLE heartbeat (
	device_id TEXT PRIMARY KEY,
	last_seen INTEGER NOT NULL,
	app_version TEXT
);

-- Every alert sent to Gary (and test alerts), for the admin page and the dry run.
CREATE TABLE alerts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at INTEGER NOT NULL,
	kind TEXT NOT NULL,                -- missed_dose | late_confirm | offline | online | sync_failed | sync_ok | test
	message TEXT NOT NULL,
	delivered INTEGER NOT NULL DEFAULT 0,
	detail TEXT
);

-- Small key/value store: settings and watcher state.
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
	('lookahead_days', '3'),
	('morning_show', '08:30'),
	('preevent_min', '60');
