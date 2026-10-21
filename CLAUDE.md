# mod — Welcome Pickups CRM extension (Chrome MV3)

## Token budget (most important)
The user has a tight budget. Keep replies short, read only the code you need (grep first, never whole files), and avoid re-reading. Tests: "quick" (default for small changes) = syntax check + one targeted stand-in; "full" only when asked or for auto-cancel / anything that sends messages.

## Basics
- CRM: https://crm.welcomepickups.com. The assistant is called "mod" (lower case) in everything the user sees; code identifiers keep old names (wpDirector…, wp_director_*).
- Files: content.js (~43k lines: main IIFE + a "transfer tab" IIFE driven by URL params; runs on /admin/transfers/* only), background.js, manifest.json, popup.html/js, wp-whatsapp.js (WhatsApp Web, also inside the side panel frame), wp-whatsapp-main.js (page world: leave-page guard + Mute), wa-panel.html/js (side panel: WhatsApp + Slack button), wp-hub.js, offscreen.js, wp-tours.js (tour pages + Confluence S-rides sync; was a Tampermonkey script). phone_relay/ (Cloudflare worker) only if the relay changes.
- Keep the Tailscale support (ts.net in manifest, content.js, background.js).
- Comments mark changes with the version ("// 1.7.296: …").

## Every build
1. Bump "version" in manifest.json (name stays "mod").
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
- Never send passenger or driver note text to the relay.
- WhatsApp messages containing 🆘 or 🚨 must not be altered.

## Current behaviour worth knowing
- Auto-cancel (wpAutoTopRuleCheck / wpTopLimitFor): Booking.com at 2:02, drop-offs 1:10, pickups 0:40. Appeared already under its limit: cancelled at 1:00 if first seen at 1:01+, else 0:30 (wp_top_late_v1, item.firstTbo). Rows show "cancel in Nm" in the last 30 min; Terminal warns 10 min before.
- Heroes: from the EM Project sheet "Active Heroes List (dynamic)". 1 hour before Final BC, unassigned → heroes with a fitting car (none written = sent too), note "sent to heroes" (wpAutoHeroesSweep). A city's due transfers (+10 min) go together, one message per hero; a hero messaged in the last 12 h gets "Hi again! … too?".
- WhatsApp contacts: First name = hero name, Last name = "<City> <car type>". WhatsApp Business quirks: button text contains icon names (use innerText / aria-label); save = div role=button aria-label "Save contact" (never touch "Delete contact"); name boxes are Lexical (select text, wait ~250 ms, insertText); numbers in the contact panel are split across elements (read innerText).
- A/C Off: never for a transfer with a Final BC note; before turning it off, all notes are re-read fresh.
- Barcelona group messages start with "@all".
- Known, not fixed: on long lists (~135) re-checks for raises/BC can be hours late (6 read per round, nearest first).
