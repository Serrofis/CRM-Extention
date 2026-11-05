# ghas (was "mod") — Welcome Pickups CRM extension (Chrome MV3)

## Token budget (most important)
The user has a tight budget. Keep replies short, read only the code you need (grep first, never whole files), and avoid re-reading. Tests: "quick" (default for small changes) = syntax check + one targeted stand-in; "full" only when asked or for auto-cancel / anything that sends messages.

## Basics
- CRM: https://crm.welcomepickups.com. The assistant is called "ghas" (lower case; was "mod" until 1.7.327) in everything the user sees; code identifiers keep old names (wpDirector…, wp_director_*).
- Files: content.js (~43k lines: main IIFE + a "transfer tab" IIFE driven by URL params; runs on /admin/transfers/* only), background.js, manifest.json, popup.html/js, wp-whatsapp.js (WhatsApp Web, also inside the side panel frame), wp-whatsapp-main.js (page world: leave-page guard + Mute), wa-panel.html/js (side panel: WhatsApp + Slack button), wp-hub.js, offscreen.js, wp-tours.js (tour pages + Confluence S-rides sync; was a Tampermonkey script). phone_relay/ (Cloudflare worker) only if the relay changes.
- Keep the Tailscale support (ts.net in manifest, content.js, background.js).
- Comments mark changes with the version ("// 1.7.296: …").

## Every build
1. Bump "version" in manifest.json (name stays "ghas").
2. Syntax-check every .js file on its own (new Function in a headless browser) with a negative control (apostrophes in template strings broke a build before).
3. Zip the folder Welcome_Pickups_Transfer_Assistant_1_7_NNN, check the zip opens cleanly.
4. On the user's PC: copy the zip to C:\Users\serr\Desktop\crm tool\ and extract it there. Before building, check "crm tool" for a newer version made elsewhere, diff against the previous one and merge. Headless Edge there must use --user-data-dir="%TEMP%\wpe1".
5. Send the user the zip (and phone_relay/worker.js → Desktop\crm tool\Director_phone_relay if the relay changed).
- In a cloud session: commit + push to the session branch and send the zip; say that the Desktop copy was not possible.
- Tests use stand-ins: cut the real functions out of the source into a headless page with stubs, print "RESULT:" lines; when fixing a bug, run the old code as a negative control.

## How the user wants work done
- Minimal changes; keep existing behaviour. Don't touch colours unless asked. Style: mint #8fffd5, Consolas, glass, no pictographs.
- No question dialogs: decide sensibly and say what you decided.
- Reports in plain language: what changed, what was tested (stand-in vs real), what was not, and how to load it ("remove the old version, load the 1.7.NNN folder, refresh your CRM tabs"; laptop: download the zip and load the same folder).

## Hard rules
- CRM through a browser is read-only: never press Save, broadcast, cancel, "Perform Auto Cancellation", Hub confirm buttons or City Manager "Reset". Mask passenger data, close your tabs. Reading localStorage on a plain CRM page (e.g. /admin/dashboard) is fine.
- WhatsApp: opening it in your own tab takes over the user's session ("Use here") — only if the user says so, and send nothing. The user's WhatsApp is WhatsApp Business.
- Never send passenger or driver note text to the relay — except the Comments cards (1.7.357, wpCommentPhone): the user chose on 2026-11-01 to have them, note text and translation included, on the phone.
- WhatsApp messages containing 🆘 or 🚨 must not be altered.

## Current behaviour worth knowing
- Auto-cancel (wpAutoTopRuleCheck / wpTopLimitFor): Booking.com at 2:02, drop-offs 1:10, pickups 0:40. Appeared already under its limit: cancelled at 1:00 if first seen at 1:01+, else 0:30 (wp_top_late_v1, item.firstTbo). Rows show "cancel in Nm" in the last 30 min; Terminal warns 10 min before.
- Heroes: from the EM Project sheet "Active Heroes List (dynamic)". 1 hour before Final BC, unassigned → heroes with a fitting car (none written = sent too), note "sent to heroes" (wpAutoHeroesSweep). A city's due transfers (+10 min) go together, one message per hero; a hero messaged in the last 12 h gets "Hi again! … too?".
- WhatsApp contacts: First name = hero name, Last name = "<City> <car type>". WhatsApp Business quirks: button text contains icon names (use innerText / aria-label); save = div role=button aria-label "Save contact" (never touch "Delete contact"); name boxes are Lexical (select text, wait ~250 ms, insertText); numbers in the contact panel are split across elements (read innerText).
- A/C Off: never for a transfer with a Final BC note; before turning it off, all notes are re-read fresh.
- Barcelona group messages start with "@all".
- Send to all drivers (wp-tours.js, /admin/drivers lists): the live list has no phone column and /admin/drivers/<id> redirects to the dashboard; name, phone and city come from /admin/drivers/<id>/edit (read only). Plain fetch without the HTML Accept header gets "not authorized": use fetchDoc. Company drivers share phones.
- 1.7.367: phone "Message all drivers of a city" (worker command type 'drivers' → content.js wpRemoteDrivers → background tab /admin/drivers?wp_send_all=<job>, wp-tours.js runPhoneDriversJob; max 300). Gradual switch per raise in the Rules window (wpGradualPct: full % − 5% per half hour left to Final BC). Group messages held up to 20 s per city (wpGroupHold, max 60 s): 2-4 one text, more than 4 the image.
- 1.7.368: every rule in the Rules window has ON/OFF. Built-in rule off = an "off" exception with city '*' (wpRuleBuiltInSet; wpRuleExceptionFor falls back to it); your rule off = rule.off (skipped in wpRulesFor). Rows with a Controls switch (auto-cancel, heroes, tick boxes, full auto) toggle that switch.
- 1.7.369: Send to suggested hours limit (wp_auto_suggested_hours_v1, box next to the switch in Controls, phone Switches 'sug' / 'sughours'). Auto-refresh watchdog every 30 s (wpAutoRefreshWatchdog): lets go of a quickbar / City Manager hold whose element is gone, restarts a stopped countdown, clears a busy hold after 20 min with nothing visibly busy.
- 1.7.371: a group invite link that only offers "Join" is joined automatically (openedFromLink(true), group sends only) and the message still goes; "Request to join" is never pressed.
- 1.7.372: a ghas round (wpAutoTick) no longer holds the auto-refresh; the countdown keeps going and only the reload waits for the round ("Refresh after ghas check", max 5 min). The background alarm is off during a round.
- Known, not fixed: on long lists (~135) re-checks for raises/BC can be hours late (6 read per round, nearest first).
