# Medication loop dry run

Run this before Mary relies on the reminders. It takes about an hour spread over two days, and nothing in it is shown to Mary as anything but a labelled test. Do it with the Chromebook where it will live, on the home Wi-Fi.

Write down the result of each step. If any step fails, stop and fix it before going further.

## Day 1: the loop on short timings (about 30 minutes)

Use the **Dry run** section of the admin page. A test dose says "Time for your test pills · This is a test" on the kiosk, and every alert it raises starts with `[TEST]`.

| # | Do | Expect |
|---|---|---|
| 1 | Admin → **Send a test alert to my phone** | Within seconds, a notification on the Pixel; **Recent alerts** shows "delivered: yes". |
| 2 | Lock the Pixel and put it across the room. Start a test dose: starts in 1, remind again 2, alert 4, stays up 10. | Within about a minute the kiosk shows the reminder over the frame, with a chime. |
| 3 | Don't touch it. | At 2 minutes, a second chime. At about 4–5 minutes, a high-priority `[TEST] Mary hasn't tapped…` push that is loud enough to notice from across the room. |
| 4 | Tap **I took them**. | The Done screen for about 10 s, then the frame. Within a minute a `[TEST] Mary tapped "I took them"…` follow-up push, and the dose shows "Mary tapped at …" in **Doses**. |
| 5 | Start another test dose (starts in 0). When the reminder shows, tap **I took them** immediately. | Done screen; no alert at 4 minutes. The reminder does not come back. |
| 6 | **Offline tap.** Start a test dose (starts in 2, alert 6) and wait one minute so the kiosk picks it up. Then turn the Chromebook's Wi-Fi off. When the reminder shows, tap **I took them**. Wait until 7 minutes, then turn Wi-Fi back on. | The Done screen appears even offline. You get the `[TEST]` missed alert (the server didn't know), then within a minute of reconnecting the "confirmed late… it was offline" follow-up. Admin shows the tap time and when it arrived. |
| 7 | **Gary override.** Start a test dose; when it shows, click **Mark done** in the admin page. | The kiosk leaves the reminder within about a minute, and no alert is sent. Repeat with **Skip**. |
| 8 | **Kiosk offline.** Close the kiosk app (or turn Wi-Fi off) for 20 minutes. | "Mary's kiosk is offline" push at about 15–16 minutes; "back" push within 5 minutes of reopening. |
| 9 | **Reboot.** Restart the Chromebook and sign in. | The app reopens on its own (from Startup) and Status shows a fresh check-in. Note whether you had to make it full screen by hand. |
| 10 | **Sync failure** (optional). In Google Calendar settings, click **Reset** next to the secret address. Wait 30 minutes, then paste the new address in the admin page's Calendar box. | A "calendar sync failing" push after the second failed sync, and "recovered" after reconnecting. The kiosk kept showing the events it had. |

## Day 2: a real dose, with you there (about 20 minutes)

Set the real dose times, upload the pillbox compartment photos, and turn the doses **On**. Then pick the next dose and be in the room.

| # | Do | Expect |
|---|---|---|
| 11 | Before the dose: open **Today** on the kiosk. | The dose shows with its time ("12 noon"); the frame strip shows the previous dose as done if it was confirmed. |
| 12 | At the dose time, watch Mary (or play Mary). | Reminder with the right compartment photo, chime at a volume she notices but that doesn't startle her. |
| 13 | She taps **I took them**. | Done screen with "Next are your evening pills", then the frame with "Noon pills done" on the strip. |
| 14 | Check the pillbox. | The compartment on screen matches the one she emptied. |
| 15 | Next dose: let it go 60 minutes untapped while you're nearby (or ask her to wait). | Second chime at 30 minutes, the real (non-test) alert at 60. Mark it done or skipped from the admin page after checking. |

## After the dry run

- Leave the timings at 30 / 60 to start. Adjust **Remind again**, **Alert me after** and **Reminder stays up** per dose once you've seen a week of real use.
- Watch the **Doses** table for the first week: late taps, misses, or a pattern of taps right at the end of the window are all worth a look.
- Repeat steps 1, 2–4 and 8 after any code change to the medication loop, and once a month as a check that alerts still reach the phone.
