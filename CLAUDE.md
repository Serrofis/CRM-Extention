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
5. PC (since 23 Nov): run `crm tool\wlcm-live-update.ps1` — it copies the newest build into `crm tool\wlcm-live`, the one folder the PC's Chrome loads; wlcm reloads itself within a minute (1.7.450 self-update). Box: stage it as /home/serr/wlcm/ext.new (fresh-start.sh swaps it in at the next Chromium start).
6. Send the user the zip (and phone_relay/worker.js → Desktop\crm tool\Director_phone_relay if the relay changed).
- In a cloud session: commit + push to the session branch and send the zip; say that the Desktop copy was not possible.
- Tests use stand-ins: cut the real functions out of the source into a headless page with stubs, print "RESULT:" lines; when fixing a bug, run the old code as a negative control.

## How the user wants work done
- Minimal changes; keep existing behaviour. Don't touch colours unless asked. Style (1.7.384, wpInjectCardTheme): ghas's suggestion card everywhere: panels #1f2529 (solid again in 1.7.404), text #e8ecee, Segoe UI, round corners, pill buttons (green #2fbf71 = main action, grey = the rest), no blur, mint #8fffd5 as an accent, no pictographs.
- No question dialogs: decide sensibly and say what you decided.
- Reports in plain language: what changed, what was tested (stand-in vs real), what was not, and how to load it ("remove the old version, load the 1.7.NNN folder, refresh your CRM tabs"; laptop: download the zip and load the same folder).

## Hard rules
- CRM through a browser is read-only: never press Save, broadcast, cancel, "Perform Auto Cancellation", Hub confirm buttons or City Manager "Reset". Mask passenger data, close your tabs. Reading localStorage on a plain CRM page (e.g. /admin/dashboard) is fine.
- WhatsApp: opening it in your own tab takes over the user's session ("Use here") — only if the user says so, and send nothing. The user's WhatsApp is WhatsApp Business.
- Never send passenger or driver note text to the relay — except the Comments cards (1.7.357, wpCommentPhone): the user chose on 2026-11-01 to have them, note text and translation included, on the phone.
- WhatsApp messages containing 🆘 or 🚨 must not be altered.

## Current behaviour worth knowing
- Auto-cancel (wpAutoTopRuleCheck / wpTopLimitFor): Booking.com at 2:02, drop-offs 1:10, pickups 0:40. Appeared already under its limit: cancelled at 1:00 if first seen at 1:01+, else 0:30 (wp_top_late_v1, item.firstTbo). Rows show "cancel in Nm" in the last 30 min; Terminal warns 10 min before.
- Heroes: from the EM Project sheet "Active Heroes List (dynamic)". 2 hours before Final BC (since 1.7.378), unassigned → heroes with a fitting car (none written = sent too), note "sent to heroes" (wpAutoHeroesSweep). All of the city's open transfers (up to 8) go in the same message, one message per hero; a hero messaged in the last 12 h gets "Hi again! … too?".
- WhatsApp contacts: First name = hero name, Last name = "<City> <car type>". WhatsApp Business quirks: button text contains icon names (use innerText / aria-label); save = div role=button aria-label "Save contact" (never touch "Delete contact"); name boxes are Lexical (select text, wait ~250 ms, insertText); numbers in the contact panel are split across elements (read innerText).
- A/C Off: never for a transfer with a Final BC note; before turning it off, all notes are re-read fresh.
- City group messages start with "@all" (all cities since 1.7.376; also in image captions). typeAtAll (1.7.377): types "@" then "all", clicks the everyone entry, then tries Tab (never Enter); converted = the typed text node was replaced; still plain = not admin → selected and deleted.
- Send to all drivers (wp-tours.js, /admin/drivers lists): the live list has no phone column and /admin/drivers/<id> redirects to the dashboard; name, phone and city come from /admin/drivers/<id>/edit (read only). Plain fetch without the HTML Accept header gets "not authorized": use fetchDoc. Company drivers share phones.
- 1.7.367: phone "Message all drivers of a city" (worker command type 'drivers' → content.js wpRemoteDrivers → background tab /admin/drivers?wp_send_all=<job>, wp-tours.js runPhoneDriversJob; max 300). Gradual switch per raise in the Rules window (wpGradualPct: full % − 5% per half hour left to Final BC). Group messages held up to 20 s per city (wpGroupHold, max 60 s): 2-4 one text, more than 4 the image.
- 1.7.368: every rule in the Rules window has ON/OFF. Built-in rule off = an "off" exception with city '*' (wpRuleBuiltInSet; wpRuleExceptionFor falls back to it); your rule off = rule.off (skipped in wpRulesFor). Rows with a Controls switch (auto-cancel, heroes, tick boxes, full auto) toggle that switch.
- 1.7.369: Send to suggested hours limit (wp_auto_suggested_hours_v1, box next to the switch in Controls, phone Switches 'sug' / 'sughours'). Auto-refresh watchdog every 30 s (wpAutoRefreshWatchdog): lets go of a quickbar / City Manager hold whose element is gone, restarts a stopped countdown, clears a busy hold after 20 min with nothing visibly busy.
- 1.7.371: a group invite link that only offers "Join" is joined automatically (openedFromLink(true), group sends only) and the message still goes; "Request to join" is never pressed.
- 1.7.372: a ghas round (wpAutoTick) no longer holds the auto-refresh; the countdown keeps going and only the reload waits for the round ("Refresh after ghas check", max 5 min). The background alarm is off during a round.
- 1.7.373: no BC / HIGH VOL tags. Em Hailing columns (since 375): Price ("TC • DC", e.g. 57 • 50, DC in the raise tag colour; td.wp-tcdc-cell) | Tags | Raise (the old Price tags, td.wp-price-cell). Send to suggested rotates: drivers sent in the last 3 h go to the back (wp_sug_rot_v1, by phone).
- 1.7.376: WhatsApp side panel starts at 60% (key wp_wa_panel_zoom_v2); a WhatsApp tab ghas opens is set to 60%. Remembered BC / HIGH VOL tags (wp_last_note_tag_v1) are no longer shown.
- 1.7.378: one settings window: Terminal "☰ Settings" opens wpRulesWindow ("ghas settings": ghas, Steps in order, Raises, WhatsApp, Phone, Your rules). Controls switches are shown there through the hidden #wp-dash-controls rows (row opts.toggle = data-act, clicked). @all setting wp_at_all_mode_v1: smart (more than one transfer or Final BC, default) / always / off, applied in wpBuildBroadcastWhatsAppText only. 1.7.379: the window has the suggestion card look (Segoe UI, #1f2529, pill ON/OFF on the right).
- Long lists (~135): re-checks for raises/BC used to be hours late (6 read per round, nearest first); fixed in 1.7.547.
- 1.7.398: the local AI is gone for good: no model calls, no explanations, no note reading or translation, no chat or typed orders in the Terminal (the box takes rules and WhatsApp links). Do not add it back unless asked.
- 1.7.494: colleague watch re-reads our transfers after 90 s (checked every 20 s, was 5 min / 60 s); its pop-ups make no sound and sit in one top-right column (window.wpPopStack) under the WhatsApp alerts (#wp-wa-alerts) — they used to overlap.
- 1.7.495: Final BC "canceled in N minutes" = the row's AutoCancel timer (then the tab's _acmin, then 59). wlcm's own auto-cancel point (wpTopCancelMinutes) is no longer used for it — under 1 hour it gave "1 minute".
- 1.7.496–500: "Never" (grey, in the card's bottom row where Stop was; a button.dc-btn so the phone mirrors it). Suggestion card: that kind of suggestion never again for the transfer, any % (wp_never_suggest_v2, keys "<id>:step" = raise/BC, "<id>:final"). Heroes / suggested cards (wpDirectorConfirm with neverTitle): "<id>:heroes" / "<id>:suggested", skipped in the sweeps. Phone waiting list has Never too (relay type 'never'). Undo: its Terminal line (until the page refreshes) or Restart (clears the list). Kept 3 days. Other confirm cards (A/C off…) keep Stop.
- 1.7.499: hero / suggested sends wait (max 12 s) until the WhatsApp header is this person (chatLooksLikePhone) — WhatsApp first shows the chat that was open before; the old check failed on it, the contact-panel fallback closed the chat, and the hero was neither saved nor messaged until the 2nd try.
- Action list + leader lease (1.7.548): automations claim every step on the relay first (POST /api/act, table `actions`; keys step:/final:<id>:<hash>, heroes:/suggested:/cancel:/chain:<id>); a running or recently done key is refused, and so is any claim from a machine whose lease number (KV `lease`, +1 whenever another machine starts serving; sent in every /api/sync answer, standby = 0, kept in localStorage wp_lease_v1) is old. Taps of yours are recorded, never refused. Relay unreachable / older relay / older background: done as before (fail-open, 1 min pause of claims after a miss). Not covered yet: relay-run quick commands and phone chains (the relay hands each command out once), A/C Off / On, tick boxes.
- Box: the live copy is /home/serr/wlcm/ext (swap: copy to ext.new without CLAUDE.md, mv ext ext.1.7.NNN, mv ext.new ext, only while wlcm-chromium is stopped). Syntax checks: bun on the box (/usr/local/bin/bun). The relay's live worker.js is /srv/suite/hub/director/worker.js (git; `suite deploy director`).

## 1.7.501
- Suggested rotation (wp_sug_rot_v1, 3 h): the row details' by-hand "Send to suggested" now shows the rotated top 5 and marks who it sent to, like Full auto and the phone (both already went through wpAutoSuggestedGo, which marks).

## 1.7.502
- Fix for 1.7.487's pause EM: a new untagged transfer was tagged EM right away, then counted as tagged, so with no raise due it got nothing else (EM only). Now wp_pause_em_v1 (CRM path → time, 12 h) remembers the ones wlcm tagged; while the transfer still has only that one note (data.tasks.length === 1), wpDirectorPlanBase plans it like an untagged one with needsEm false: note "sent to BC and Group" + BC (or raise + BC / Final BC as usual, no second EM). Cleared when its step goes (status inflight). wpAutoLoad imports once (state.pauseEm502) the items already tagged in the pause before 1.7.502.

## 1.7.503
- Comment vs transfer check (wpCommentMismatches, plain rules, no AI): the traveller comment is read for times (10:00 / 10.30 / 10h30 / 10am), flight numbers ("W6 2372" form, upper case or right after "flight"), luggage counts (EN/ES/PT/IT/FR/DE/GR words, "Malas grandes: 1"), people / kids, child seats (not when they bring their own) and a wheelchair, against pickup time (card.dt), data.booking.flight and card.bk. Shown on the Comments card (box "CHECK · COMMENT VS TRANSFER"), as the phone card's first note (mm: true, skipped in the PC notes) and once per change in the Terminal ("Comment check: …", wp_comment_mm_seen_v1, 3 days). Tested on 14 real comments + 16 made-up ones (stand-in).

## 1.7.504
- Terminal header: a "Comments" button (data-act comments → wpCommentWindow) next to Settings.
- Comments card: when the CRM has only the bag total (Lug N, Checked 0, Hand 0), card.bk.chk = N, so the Checked stepper starts from the booked bags (PC and phone). card.bkCrm keeps the CRM's real Checked / Hand; wpCommentEditWant adds the other shown luggage number when one of them changes, so the CRM gets both.

## 1.7.505
- Drivers / heroes by phone failed with "could not confirm the open chat is +… (header "", 0 msg ids)". Likely cause (not seen on screen): WhatsApp wraps an unsaved number in the chat header in invisible direction marks (U+202A … U+202C), so /^[+\d\s().-]+$/ missed it; the name check and the contact-panel fallback failed and the panel closed the chat (2nd try: header ""). wp-whatsapp.js isPhoneTitle() strips those marks / no-break spaces; used in chatLooksLikePhone, chatIsPhone, the "is it saved" test before addContact and the save check. The error line now has the 1st try's view and the header's odd characters as U+ codes.

## 1.7.506
- Seen live on 2026-11-21 (driver +52 55 3109 7090): drivers with a WhatsApp Business account show their business name in the header ("Global Business Transportation · Business Account"), not the number, even unsaved; the header's [role=button].click() does not open the contact panel; the panel shows "+52 1 55 3109 7090" (Mexico adds "1"); the message box is labelled "Type a message to +52 1 55 3109 7090". composerPhoneDigits() reads that label: chatLooksLikePhone / chatIsPhone confirm the chat by it (another number in it = wrong chat, no name fallback), and "not saved yet" = header is a number OR the label has a number (so Business names get the Add-contact path, not rename).

## 1.7.507
- A days-old waiting card (Bogota raise) stuck on the tablet: the box's wlcm was Off, wpAutoTick returns at once when Off (before wpAutoTakeActions), so the phone's Skip / Never were never read, yet wpRemoteQueue still sent the stored "queued" items. wpRemoteQueue now sends no queue while wlcm is Off.

## 1.7.508
- Step 1 of the iPad app without the box: the relay reads the CRM by itself. New "cookies" permission. content.js wpCrmSessionHand() (top frame, relay set up, 20 s after load then every 5 min) asks background.js (WP_CRM_SESSION), which reads the crm.welcomepickups.com cookies and POSTs them straight to the relay /api/crmsession (Bearer PC key) when they changed or every 20 min (digest in storage.session). The cookies never reach the page or the log. Relay keeps them in KV "crmsession" {cookie, ua, at, since, from} and never returns them.

## 1.7.509
- 1.7.508 handed nothing to the relay on the box (no request arrived). For finding out why: the sync status now carries status.crmSess (the last handover result, "not tried yet", or "relay not set up here"), and the first handover runs 5 s after load (was 20 s).

## 1.7.510
- On the box 1.7.509 reported "fail:The message port closed before a response was received." for the handover (permission "cookies" is granted in Preferences; the handler works with a stand-in chrome on the PC). background.js now catches a synchronous error around chrome.cookies.getAll and reports its text, so status.crmSess names the real cause.

## 1.7.511
- Still "message port closed" on the box with 1.7.510 (the box ext/background.js has the new code). Probe: background WP_BG_PING answers {v: manifest version, code: "1.7.511", cookies: typeof chrome.cookies}; content.js sends it before each handover and puts the answer in the sync status as status.bgPing.

## 1.7.512
- FOUND: the box Chromium ran a cached background.js from 1.7.457 (Service Worker/ScriptCache, 2026-11-16) — no background change since 1.7.458 ever ran on the box; the old self-update compares manifest versions, which do update, so it never reloaded. background.js now starts with const WP_BG_BUILD (BUMP IT WITH THE MANIFEST VERSION ON EVERY BUILD); WP_BG_PING answers it. wa-panel.js (always loaded from disk) pings 4 s after opening; no answer or another build → chrome.runtime.reload() (at most every 30 min, localStorage wp_bg_reload_at_v1; why kept in storage.local wp_bg_reload_v1).

## 1.7.513
- After 1.7.512 the box ran the new background but chrome.cookies.getAll({url: crm …/admin/}) gave 0 cookies while the CRM page was signed in. The error now carries counts per lookup (url, domain crm, domain welcomepickups.com, all) and the cookie stores, no values.

## 1.7.514
- Cause of "0 cookies": the CRM sets its cookies on the domain .welcomepickups.com (seen in the box profile: 12 + 1 partitioned), and chrome.cookies only returns cookies whose domain the extension may access; https://crm.welcomepickups.com/* does not cover .welcomepickups.com. Added host permission https://*.welcomepickups.com/* (also matches welcomepickups.com).

- Result 2026-11-21: the handover works (relay kept 4 cookies). But the relay's own request to /admin/transfers/index_v2 gets HTTP 403 "Just a moment..." = Cloudflare bot check in front of the CRM; it does not accept a non-browser client even with the session. Getting around that check is not an option. So the CRM can only be read from a real browser (box Chromium or a PC).
- Also seen: after the 1.7.514 swap bgPing said "v1.7.514 code 1.7.513" = the box again kept the previous background.js; wa-panel.js reloads it, but only 30 min after its last reload.

## 1.7.515
- The user had the CRM sign-in removed: relay restored to worker.bak_507.js (no /api/crmsession), KV 'crmsession' deleted on the box. wlcm: handover gone (content.js wpCrmSessionHand, background WP_CRM_SESSION), permissions 'cookies' and https://*.welcomepickups.com/* removed. Kept: WP_BG_BUILD + WP_BG_PING + the wa-panel.js reload of a stale background, and status.bgPing (wpBgPingCheck every 5 min).

## 1.7.516
- Step 1 of the box-as-reader plan: every transfer's tablet card is preloaded. content.js wpPreloadTick (every 3 s, box only: wpIsMainMachine + relay on) builds one card at a time with wpRemoteDetail(id, true): first transfers with no card (today first, soonest pickup first), then rows whose sig changed, then due ones (3 min under 3 h to pickup, else 15 min). A tap's fresh card also refreshes the store. Changed cards go with the next /api/sync as details (<= 40 cards / ~200 KB) + detailIds (the whole list). Relay (2026-11-21): stores KV 'details' {id: {card, at}} from the main machine only, before the standby check; GET /api/details?since= for the app. App: loadDetails() with each list poll (at most every 15 s); openDetail shows the preloaded card at once, reads a fresh copy only when it is over 1 min old or on Read again (openDetail(row, true)); showDetailCard() draws a card + its buttons.

## 1.7.517
- Step 2 (background reader beside the page): new wp-reader.js (content script before content.js; no dependency on content.js, only fetch + DOMParser, so it can move to the offscreen document later). self.wpReader.read() fetches the Em Hailing list (index_v2 today_tomorrow, all cities) and parse() reads table.transfers by header names (City, TBO, Order#, Partner, DateTime, Last Transfer Task, AutoCancel); Traveler, From/To and Driver are not read. Day from the DateTime text (as wpRowPickupDay), else the table's heading (Today / Tomorrow / Later). content.js wpReaderTick: box only (wpPreloadOn), once a minute; result goes with the sync as rlist. Relay keeps KV rlist and compares it with the page list in rcmp (+ rcmphist, last 200): ids only on one side, field diffs (d l c p w n exact; m and a within 2 min after the page list's age).

## 1.7.518
- Step 3 (part 1): the reader's rows get the columns wlcm adds to the page, worked out with wlcm's own functions on the fetched (not shown) row: content.js wpReaderExtras(tr, row) -> b (setTBOState on the parsed tr), pd / lo (wpDetectLocationTypesFromText on From / To; only the kind of place is kept), pr / pk / rz / v (wpRowCrmLoad store, as wpRowCrmPaint), tg / g (wpDetectNoteTag + wpEarlierNoteTag, as wpUpdateTransferNoteTag), wk (wpWorkedState). wp-reader.js parse() also returns els (id -> parsed tr). Relay rcmp now compares those fields too. Note: the store is still filled by the page's own row loader (wpRowCrmPump); without the page the preloader must fill it.

## 1.7.519
- 1.7.518 (only ever on the box) had two regexes without their backslashes in wpReaderExtras (cut: /s+/ removed every "s", the [Task] prefix pattern) — "sugg" read "ugg", "Minibus" "Minibu". Fixed. First 1.7.518 comparison otherwise: 50 of 78 identical, the rest those two bugs plus rows that changed between the two reads.

## 1.7.520
- 1.7.519 compare: 71 of 78 identical; left: price/car the page had not painted yet (timing), and "no tag" for empty notes (getLastTransferTaskCell gave nothing on the fetched row; the reader now uses its own n). Step 3 switch (relay, 2026-11-21): GET /api/list serves the reader list (today + tomorrow, + later-days rows from the page list; cities / vol from the page list; list.src = reader) when rlist is ok and under 3 min old, else the page list (src = page).

## 1.7.521
- Tablet requests (2026-11-21): Settings "Refresh page" switch (answer set item refresh -> wpSetAutoRefreshEnabled + start/stop timers; relay allows set refresh); status.refresh.next (next reload, PC clock, 5 s steps; 0 while held) shown in the app top line ("refresh in 0:42"). status.waiting = open suggestion + the ones in line (was only queued items). status.watch {ac, rem} (A/C off list + reminders: transfer id, city, note, end) for the app Watch tab. Every browser start: all automations OFF once (background onStartup stamps wp_boot_at; content wpBootAllOff: day modes, Full auto, Send to suggested, WhatsApp auto-send, page auto-refresh; Booking.com auto-cancel left as is). Box / Start no longer turns Today to Ask me (1.7.477 off). App: actions where wlcm activity is, with a "wlcm activity" toggle; menu bar in the top bar on wide screens; the settings number box keeps what you type.

## 1.7.522
- 1.7.521 left Send to suggested + WhatsApp auto-send on after a box restart: onStartup was handled by the cached old background (the panel reloads the new one ~4 s later). Now: background sets storage.session access for content scripts; content wpBootAllOff turns everything off when the storage.session mark wp_booted is missing (cleared by every browser start and every wlcm update), retrying every 15 s while it cannot read it.

## 1.7.523
- 1.7.522 on the box still ran the 1.7.521 background: wa-panel.js reloaded at most every 30 min and had just reloaded for 1.7.521. Now it reloads once per new version (localStorage wp_bg_reload_v2 {want, at}); the same version again only after 30 min.

## 1.7.524
- wp-signin.js also runs on the Ops Hub (ops-intelligence-hub.vercel.app): on the box its sign-in page's Google / "Sign in" / "Log in" / "Continue" button is pressed (same limits: every 3 min at most, 6 a day; Google's own pages never touched, nothing typed); after the sign-in the Live Ops list is opened. The app is told "Ops Hub signed out" (background WP_SIGNIN_TELL posts /api/boxinfo {hub} with the relay settings a CRM page keeps in storage.local wp_signin_relay_v1). Relay: boxinfo hub / hubAt, machines[role].hub; app connection note. Not seen on the real Hub sign-in page yet.

## 1.7.525
- Start-up switch-off left Send to suggested and WhatsApp auto-send on: both read as ON when their key was never set (!== "0"), and wpBootAllOff only switched them off when set to "1". Now it uses wpAutoSuggestedOn() / wpWhatsAppAutoSendOn().

## 1.7.526
- Ops Hub from the relay, step 1: "cookies" permission again; background.js wpHubSessionHand (box only = Linux UA; alarm every 5 min + 15 s after start) reads the Hub cookies (need sb-*) and POSTs them to the relay /api/hubsession {main:true, cookie, ua} when changed or every 20 min, with the relay settings from storage.local wp_signin_relay_v1. Relay keeps KV hubsession (box only), never returns it, never renews it.

## 1.7.527
- 1.7.526 never handed the Hub sign-in over (cookies + relay settings were there, no error shown). The 5-min alarm is now created only when missing (it was re-created, i.e. postponed, on every service-worker start) and every try records its outcome (storage.local wp_hub_session_note) -> relay status.hubSess.

## 1.7.528
- 1.7.527 on the box: "not signed in to the Hub (0 cookies)" while the profile has the sb-* Hub cookies (unpartitioned, has_cross_site_ancestor=1). wpHubSessionHand now tries getAll by url, by domain, url + partitionKey {} and all cookies (filtered to the Hub host), uses the first with sb-*, and reports the counts per lookup in hubSess.

## 1.7.529
- At every browser start the page auto-refresh now starts ON (the user: "always open it with refresh on"); everything else still starts OFF.
- 1.7.528 on the box: every cookie lookup gave 0 Hub cookies (url, domain, url+partitions, all) although the profile has them. So: wp-signin.js on a signed-in Hub page (box) reads its own sb-* cookies (document.cookie) and sends them to background (WP_HUB_SESSION_PAGE) every 5 min -> wpHubSessionFromPage -> wpHubSessionSend (shared with the cookie lookup, digest / 20 min). wpHubTabKeep: the box keeps one Live Ops tab open in the background (created inactive when missing, after a CRM tab exists).

## 1.7.530
- The City Manager chain (hubChainRun: Select, Tag, Remove Auto-C, Broadcast, Ask best drivers, 30 s, Enable Auto-C, note, image) does its Hub steps through the relay on the box (wpIsMainMachine): background WP_RELAY_JOB creates a relay job (/api/pcjobs: check | hub action | ask) and waits for it (GET ?id, <= 4 min). Result mapped to the old Hub-tab answer shape (N succeeded / not needed / did not; all skipped = "blocked by a Hub guardrail (reason)"). Relay sign-in not usable -> the Hub tab does the rest of that chain. Transfers not in the Hub (leftOut) get, at the end, the CRM quickbar BC & Group with the note "sent to BC and Group" (wpRemoteQuick), 9 s apart. Relay (2026-11-22): job kind check, GET /api/pcjobs?id=, wlcmKeepUntil (box Chromium is not idle-closed while wlcm or Full auto is on; server.js box-idle checks it).

## 1.7.531
- First live relay chain (22 Nov, Tomorrow Full auto): Huatulco (city-managed A/C: Remove/Enable Auto-C skipped by the Hub, A/C untouched, correct) and Tallinn (tag, A/C off, broadcast, 3 driver offers, A/C on) fine. Bug fixed: a city where NONE of the untagged transfers are in the Hub stopped at Select without the CRM fallback; now all go to leftOut (CRM BC & Group + note at the end) and the message says "in the Hub list" so City Manager auto skips only that city.

## 1.7.532
- 22 Nov: the box page stayed ~10 min old (auto-refresh on but held, countdown frozen) after the CRM BC & Group fallback, so 5 new untagged transfers (3 Prague) never reached the City Manager auto (the tablet saw them via the reader). wpAutoRefreshWatchdog: a never-released hold is cleared after 5 min (was 20) when nothing is visibly busy; and if refresh is on, no countdown runs, the page is over 6 min old and nothing is visibly busy, the page is reloaded.

## 1.7.533
- wlcm activity (tablet) now also gets the City Manager / Ops Hub chain lines (wpActivityAdd prefix + "City Manager", "Ops Hub"): each step with its result, the CRM fallback, each city summary. The chain's CRM fallback logs "Automations · CRM: BC&G …" (wpRemoteQuick command.by = auto) instead of "📱 Phone".
- At every browser start WhatsApp auto-send now starts ON as well (user, 22 Nov: without it the chains' group messages / images were prepared but not sent).

## 1.7.534
- wlcm activity rework (user, 22 Nov: each line must say what was done, on which transfer, by whom, and whether it worked). Boot line "wlcm: box started (wlcm <v>) — automations OFF (were on: …), page refresh and WhatsApp auto-send ON". WP_WA_LOG keeps two-group city sends (only "(n/m)" batch labels dropped). Relay-injected quick commands log "🔁 Relay:" (command.by = 'relay'); wpActivityAdd accepts it. Tablet app (relay worker.js APP_HTML, deployed 22 Nov, backup worker.bak_533.js) actFill shows "#w-… · city", the action, ✓ / NOT sent + reason, and a you/auto/relay tag.

## 1.7.535
- 22 Nov: the box's page refresh stayed "held" 8+ min: the City Manager auto opens the City Manager window and leaves it open while it watches for new untagged transfers, and an open City Manager holds the refresh unless the old per-day "let it refresh" OK was given (it was not). wpCmAutoLetsRefresh now also lets the refresh run while the auto is only watching (state.watching); the watching step re-syncs the hold. Mid-chain the chain's busy hold still stops the refresh.

## 1.7.536
- Box: an open City Manager window holds the page refresh only while the tablet's City view uses it (last 90 s) or a City Manager chain runs (22 Nov 14:00: page 13+ min old with Today on Full auto). wpSyncAutoRefreshWithTransferOverview + wpAutoRefreshWatchdog.
- City Manager chain: when the Hub stops it before the broadcast (e.g. Tag blocked by a guardrail), the remaining transfers go to the CRM (BC & Group + note) too; transfers no longer unassigned are said ("taken by a driver or cancelled — nothing left to do") instead of skipped silently.
- Activity explains the after: "WhatsApp confirmed n of m" / "WhatsApp did NOT send to any … tried again in 15 min" now reach the tablet (were noise); the BC note line says why the group message was not sent.
- Now line: the City Manager chain's current step; "Automations are off" / "City Manager auto: watching…" + the days that are on, instead of "wlcm is off".
- Queue: with this page's wlcm off, suggestions waiting > 2 min leave the Queue (wpAutoQueueOffSweep), said once.
- Relay (same day): acthist KV keeps 26 h of activity, GET /api/activity; tablet right side shows the whole day (600 newest), never the left side on the tablet.

## 1.7.537
- City Manager chain: the CRM fallback (BC & Group + note) now runs on every machine, not only the box: on the PC a chain stopped by the Hub did nothing, and its "left out, done in the CRM at the end" transfers were never done (22 Nov 14:20 Budapest on the PC).
- City Manager auto: "the Hub is not answering" (stopped at Select, not "in the Hub list") no longer switches the auto off (state null). That city already went to the CRM; state.hubDown {at, until: +10 min, why} sends the next cities straight to the CRM (chainHubDown -> fail at Select -> hubFailed), then the Hub is tried again.
- Relay Hub jobs carry city + day (popupTitle, tabName); chain log lines name the day ("City Manager Budapest · Tomorrow → …").
- Boot line says box or PC (was always "box started"). Heroes "not sent" line says "tried twice".
- Box start (not in the extension): /home/serr/wlcm/fresh-start.sh (drop-in fresh-start.conf, ExecStartPre) sets session.restore_on_startup = 1 so the CRM's session cookie (_session_id) survives Chromium restarts, and moves the last run's Sessions / Sessions_Encrypted to *.last so no old tabs come back.
- Relay (same day): activity lines carry m = box / pc (tablet tags PC lines "PC"); finished Hub jobs kept 26 h in KV jobhist.

## 1.7.538
- User choices (22 Nov, multiple choice): the PC takes over only after a tap; by-hand work keeps the automations off that transfer for 2 min; PC keeps its own WhatsApp link; Chats tab = WhatsApp unread DMs + mentions and Slack (picked channels + DMs) read in the box's browser, replies only on tap.
- Relay: a PC (not main) is on standby unless picked (prefer = pc, app Connect → PC); standby answer why = "tap". The box still takes over by itself. Box-down push: skipped when box-idle closed it (app unused 4.5+ min, no automation keep); otherwise it says the PC waits for Connect.
- Hands-off: WP_TOUCH_LEAVE_MS = 2 min (wpAutoTick "yours", Send to suggested, City Manager chain: handsOff left out, said once per touch). wpUserTouchWatch marks a transfer on real input (isTrusted pointerdown / keydown) in its CRM row or page, not in wlcm windows ([id^="wp-"]). Sync sends touched (last 3 min); relay KV touched (3 min) is returned to the machine that works (wpUserTouchedMerge). Auto-cancel does not wait (time-critical).
- WhatsApp list: wp-whatsapp.js alertScan writes wp_wa_unread_v1 {at, list: id wu+FNV hash of the title, title, kind, count, preview} on change / every 30 s; content.js sends waList {ok, list} (sync), relay KV walist; wa open / reply find ids in that list too.
- Slack: wp-slack.js (content script on *.slack.com, box only) uses Slack's web API from its own page with the page's own sign-in (localConfig_v2 token, never sent anywhere else): client.counts (users.counts fallback), conversations.info / users.info for names, conversations.history, users.conversations (picker, 30 min), chat.postMessage for a tablet reply. background WP_SLACK_SYNC -> relay /api/slack (list, chans, chat; answers cmds + pick + fast); WP_SLACK_API = the same call from background when the page request is blocked; wpSlackTabKeep keeps one Slack tab. NOT tested against real Slack yet (the box was not signed in).
- Tablet: Chats tab (tabChats, #chats, renderChats), the WhatsApp chat view also opens Slack chats (waChatOpen.src = slack), Slack channel picker sheet (#slpick, /api/slackchans), Connect sheet opens by itself when the box is down and the PC waits.
- Relay (later, 22 Nov): the PC that serves keeps serving until the box is back online (iServe); it still never takes over by itself. Live check 16:05: box start kept the CRM sign-in (_session_id from 14:22 survived), 1.7.538 + new background on the box, Now line "Automations are off", walist 8 DMs, Slack signed in (team Welcome, 2 DMs, 49 channels), memory ~2 of 4 GB.

## 1.7.539
- wp-slack.js: Slack's linked words come as [word](url) (was the word only), so the tablet's Chats tab can open the transfer behind them. Box: fresh-start.sh now swaps a staged ext.new in before Chromium starts (old one kept as ext.<version>), so a build copied while Chromium runs goes live at the next start without a restart.

## 1.7.540
- WhatsApp list for the tablet (wp_wa_unread_v1 / waList): also every chat whose last message is today (row time HH:MM, rowTime), groups included (kind group), with tm; up to 40. The relay keeps the day's chats in KV waday (reset at midnight, Athens); the tablet groups them by city (user's choice, 23 Nov). Group unread counts do not make a badge.

## 1.7.541
- Activity lines say what happens next: AutoCancel later than the mark (wlcm cancels at X / auto-cancel off: cancel it yourself), no heroes (goes on as usual), a tablet answer too late (nothing pressed), WhatsApp retry ("trying again in 15 min, that will be try n of 3"). While you work on a transfer by hand (2 min), auto-cancel only cancels Booking.com ones; drop-offs / pickups are not cancelled then (said once). User, 23 Nov: "cancel only the booking ones".

## 1.7.542
- Slack replies from the tablet went out twice: the Slack page's own request reached Slack but its answer was blocked (CORS), so wp-slack.js sent it again through background.js. Now every Slack call goes through background.js (WP_SLACK_API) first, the page only when the background does not answer; a command key runs once; the box keeps one app.slack.com tab (extra ones closed). The relay hands each command out once (in-memory keys).
- From 23 Nov: publish every build with `Desktop\crm tool\wlcm-publish.ps1` (check on the box, stage as ext.new, commit to /srv/suite/wlcm/ext, update the PC's wlcm-live, zip).

## 1.7.543
- 1.7.542 stalled the Slack reader (background first: no answer). Back to the page first; a failed page request goes to background.js with a 10 s limit; chat.postMessage is never repeated: when the page could not read the answer, the chat is checked for the message first (landed). A Slack page that lost wlcm reloads itself, and background reloads app.slack.com tabs after an update (the reader stopped after every box start / update).

## 1.7.544
- Rebuild stage 2: the relay runs Tomorrow / 2-4 days (Ops Hub days). The box reads the 2-4 days list in the background every 5 min (wpReader24Tick, sync rlist24; wpReader.read(url), LIST_24). The cm / chain command takes day later (2-4 days tab, wpLater24Ensure(…, true) loads it even when "Also work 2-4 days" is off), exact ids (matched by transfer id; the ones still listed run) and by: relay ("🔁 Relay → Ops Hub chain (City · Tomorrow)").

## 1.7.545
- Sync with the box is back for a PC on standby (removed in 1.7.465), always on while the box is up (wpBoxUpAt from /api/mirror state machines.box.online, 30 s), no "Sync off": the box's activity lines in this PC's Terminal ("🖥 box · …"), the box's Ask me card bottom-left (answered on the box), quickbar BC&G / Final BC, day modes and Pause all sent to the box, hand work here logged on the box (pclog). Memory copy stays off. Box down: standby bar says tap Connect on this PC in the app.

## 1.7.546
- Overview page (overview.html): the top bar and the tabs (Home / Cities / Slack / Event retro / Month) stay at the top while the page scrolls (user asked); --barh set from the bar height in overview.js.

## 1.7.547
- Long lists: wpAutoTick read only the 6 most urgent due transfers per 30 s round, so far ones waited hours for raise / BC re-checks. With more than 6 due: up to 12 a round (still 2 at a time), the 8 most urgent first (wpAutoCompare: Final, no tag, nearest), the rest of the slots for the ones waiting longest (oldest nextAt). 6 or fewer due: unchanged. WP_BG_BUILD bumped (was left at 1.7.545 in 1.7.546).

## 1.7.548
- ONE action list on the relay + leader lease (review recommendations 1 and 2, user's yes 23 Nov). Relay (worker.js): SQLite table `actions` (k, kind, item, st claimed/done/failed, ep, m box/pc, by wlcm/hand, n, ttl, hold, at, up, x), POST /api/act {op: claim | done | list} (PC key; background.js allow-list has /api/act). Claim = one UPSERT: refused while claimed (hold: 10 min, heroes / suggested 3 h, chain 30 min, or until a newer lease) and for ttl after done (step 30 min, final 6 h, heroes / suggested / cancel 24 h, chain 30 min); failed = free again. auto claims with an old lease number or another machine id = refused 'stale'. KV `lease` {ep, id, role}: +1 when another machine starts serving; /api/sync answers lease {ep} (standby {ep: 0}).
- content.js: wpActClaim / wpActDone / wpActGate / wpActThen (after wpRemoteCall), wpLeaseSet on every sync answer. Claimed: wpAutoRunApproved (before wpDirectorStart; key hashes plan + DC price + WhatsApp or not; done/failed in wpAutoCheckInflight), wpAutoHeroesGo / wpAutoSuggestedGo (per transfer; refused ones left out of the messages; done/failed in wpAutoSendFinish), auto-cancel (wpAutoTopRuleCheck; refused = result 'skipped' (dup) or 'paused' (stale)), City Manager auto chain (_wpAutoChain, per transfer). Send plans remember their lease (plan.ep): wpPlanTick stops the rest of a plan when the lease number changed. Refusals: one activity line per key per 10 min.
- Tests (stand-ins, real worker.js under Bun + the real functions cut out of content.js): two tabs at once / old leader after failover / new leader with empty memory — 548 does each once, 547 twice (negative control); older relay, unreachable relay, older background, hanging relay: as before.

## 1.7.549
- Tomorrow / 2-4 days worked like Today (user, 23 Nov). The box (machine that works, reader lists) reads every listed transfer's notes (wpFetchTransferCrmDetails, 3 a round every 10 s, again after 10 min) on the days that are on (relay KV rauto, now also in every /api/sync answer → wpDayModes) and sends the step in rlist / rlist24 rows as st: 'chain' = no notes (whole chain), 'bcg' = EM tag but no "sent to BC and Group" / "sent to BC, Group" (also "only sent to BC") → BC & Group, '' = every step done (also a hero / suggested / final note) → nothing, '?' = not read yet (wpDayStepFromData, wp_day_st_v1).
- A transfer that newly appears (not in any list before, wp_day_seen_v1; the first read of a list only learns it, wp_day_base_v1) gets A/C Off at once in Ask me and Full auto (wpDayAcOff): Today's checks (cancelled / assigned, Final BC note, colleague's AutoCancel change, acoff rule), action list key acoff:<id>, Ops Hub remove_auto_c through the relay first (then on the A/C Off list with the list's AutoCancel minutes), the CRM tab (?wpQuickAcOff=1) when the Hub does not have it. 2-4 days list read every minute while 2-4 days is on (was 5).
- Relay rautoTick: groups by day + city + step from the top of the list down (Tomorrow first); '' never asked; a done step asked again after 30 min if the notes still lack it (was: once per transfer for 3 days). Older box (no st): untagged = chain, as before. Answer cm / chain carries step; Ask me card says which step.
- wpRemoteCmChain (relay, with step): notes read fresh again, only the ones that still need that step go; each booked on the action list (chain:<id> / bcg:<id>), done / failed after the run. bcg = the same Hub chain without Tag (noTag); acKeep (wlcm turned A/C off when it came in) = no Remove / Enable Auto-C, A/C stays off. CRM fallback (quickbar BC & Group, note "sent to BC and Group") now also finds the background 2-4 days rows (wpRemoteRowFor; quickbar set up on demand). Notes always in the CRM. No raises / Final BC / heroes / suggested on these days.


## 1.7.550
- Tomorrow / 2-4 days: untagged = no EM tag (a note "em" or a task labelled EM), not "no notes at all" (user, 23 Nov). A transfer with only other notes ("passenger called") gets the whole chain; EM + other notes = BC & Group; a BC & Group / suggested / hero / final note = nothing (even without EM). Today keeps its own rule (untagged = no notes, user 14 Nov, 1.7.441).

## 1.7.551
- A/C column (user, 23 Nov: "I need to re-enable these"): a transfer with AutoCancel OFF (on wlcm's A/C Off list, or OFF in wlcm's latest read: details cache / row store field ao, the newer wins; wpRowAcOff) shows its timer in Welcome green (#2fbf71, bold) or, with no timer, a green dot (span.wp-acoff-dot); no red / orange / row danger then. Tablet: list rows carry ao (page list and reader rows); app.html .acp.aoff green number, .acoffdot green dot.
- 1.7.552 (user, 23 Nov): quickbar "A/C On/Off" (CRM quickbar after A/C Off, tablet quickbar action acflip): background tab ?wpQuickAcFlip=1 flips AutoCancel (ON -> OFF, OFF -> ON), Save and Autocheck, reads the CRM again; OFF is NOT put on the A/C Off list, ON takes it off. Result told to the dashboard. Activity: a transfer newly seen on Today (not the first look at the list) gets one line "seen, Xh Ym to pickup · waiting: <why> · next look HH:MM" (paused / in line N ahead / your answer / you are working on it / its reason); not when the 3-min "new" line already said it.
- 1.7.553 (user, 23 Nov, on the PC "I only see the dots"): the CRM shows no AutoCancel timer once A/C is off, so every A/C-off row had the dot. A transfer on the A/C Off list now shows that list's countdown (re-enable in Xm) in green in the A/C cell, drawn as ::after from data-wp-ac-left (never cell text: auto-cancel timing reads that text); the dot only for A/C off and not on the list. Tablet rows carry ae (minutes left on the list); app.html shows it as the green number.
- 1.7.554 (user, 23 Nov: "make slack posts replieable"): Slack threads. wp-slack.js: a command's th (parent ts) reads that thread (conversations.replies) and a reply goes there (thread_ts; the never-twice check looks in the thread); chat messages carry ts and rc (reply count); a chat answer carries th. Relay: slack command th, slackchat / slackmsgs keep th, ts, rc (a thread is cached as id/th). Tablet: each Slack message has Reply / N replies, which opens the thread in the Chats tab (back to the channel), sent there as a thread reply. Transfer details: two buttons, Quickbar and Slack, each a pop-up (the quickbar + send now + WhatsApp groups / the Slack post), so the card has the room.
- 1.7.555 (user, 23 Nov: "show all actions ... I need to know exactly what goes on"; read of the relay's acthist found silent ends): wlcm activity keeps the steps (wpLineNoise lines get s: 1 instead of being dropped / h), 400 kept, 150 sent per sync. Heroes / suggested: each person's step line now starts "WhatsApp · " (so it reaches activity) and the run ends with ONE line in order: "sent to 2/3 heroes: 1/3 Axel ✓ · 2/3 Alejandro ✗ chat not confirmed, tried twice · 3/3 …" (plan.res / results), ok / warn / error. Silent ends now said: a heroes / suggested Yes that sends nothing (wpAutoSendRecheck: why per transfer, switch off), an A/C Off Yes that turns nothing off (none needs it / cancelled / assigned), the A/C Off tab's end (kept + list minutes, assigned, threshold warning, box not found). PC: the Terminal panel is now "Activity": every line in order (time, who, order + city, full text; steps dimmed with ↳), no merged one-line-per-transfer view.
- 1.7.556 (user, 23 Nov: "the chats that start at the start of my shift, in the order they are in WhatsApp, with the correct name; the tablet remembers them"): wp-whatsapp.js reads the chat rows in screen order (getBoundingClientRect, not page order), adds ts (the row's HH:MM as a time stamp, later than now = yesterday), and calls a city team chat (Welcomers / Dispatchers / Drivers / group / team / ops) a group. Relay KV wash {start, at, chats}: from Start shift (tablet), every chat with a message at or after the start, kept until the next Start shift (max 400); GET /api/wash, /api/state washStart / washAt, command type shift op start. Tablet: Start shift pop-up at the first open of the day (Test = not a shift start, asked again at the next open), Chats → WhatsApp = the shift's chats newest first under WhatsApp's own name (no city groups), kept in localStorage wp_wash_v1.
- 1.7.557 (user, 23 Nov: "whatsapp is too slow, why do so many suggested and heroes fail"): most failures were "could not confirm the open chat is +N (header "zs" / "Peter" / "exp")": WhatsApp now shows an unsaved number under the person's own profile name and message ids no longer carry the number, so every check failed (12 s wait + 10 s contact panel, twice = ~3 min per person). wp-whatsapp.js: the header before a person's link is kept (sessionStorage wp_wa_before_link_v1); opened fresh from the link, a chat that SWITCHED from it, is not a group, has no message id of another number and keeps its name 1.5 s = this number's chat (chatSwitchedFromBefore, also in chatLooksLikePhone so the 12 s wait ends at once). content.js plan runs: "no answer from the WhatsApp side panel" reloads WhatsApp and waits 20 s before the 2nd try.
- 1.7.558 (user, 23 Nov: "WhatsApp messages should also have a link to the transfer on the tablet like the PC; make it faster"): a chat read for the tablet (job.read) gets tr: [[transfer id, label]] per message from wp_wa_crm_links_v1 (the PC's "open in CRM" matching); relay keeps tr; the tablet shows "↗ #w-…" buttons that open the transfer. Speed: every person a message reached is remembered by their chat's name (wp_wa_person_titles_v1, last 9 digits → title); the next message opens that chat by name from the search (no WhatsApp reload), checked: same name, not a group, message box / ids name no other number, no other person with that name; otherwise (or if it does not check out) the number's link as before. Not for messages with a picture.
- 1.7.559 (user, 25 Nov: "something we changed makes WhatsApp block me immediately … make it always add them first"): since 1.7.505/506/557 numbers that are not saved contacts passed the chat check (direction marks, Business names, profile names), so wlcm messaged strangers, and when saving failed it sent anyway (1.7.281). wp-whatsapp.js: before a message to a person, the contact info is looked at unless the number is known as saved (wp_wa_saved_people_v1, last 9 digits; contactSavedState: Add / Save contact = not saved, Edit = saved, neither = not saved); not saved → saved first (addContact); saving fails → NOTHING sent ("— nothing sent (only saved contacts get messages)"); the usual 15 min retry (3 tries) tries saving again. Timing otherwise unchanged (5 s after each message; one contact-info look per new person, ~2-6 s).
- 1.7.560 (user, 25 Nov): Settings → Phone → "Work from: This PC / Box" (PC only, wpConnectTo) = the app's Connect from the PC: POST /api/mirror {path:'/api/connect', body:{to}} (relay MIRROR_PATHS + '/api/connect'; RELAY CHANGED). The standby top bar "the box is not answering" gets a "Work from this PC" button. Box down still never switches by itself (user's 22 Nov choice). Terminal / Activity font bigger (user: "can't read the small ones"): base 11 → 13px, steps 1em (opacity .72), day lines 12.5px, WHO chips 11.5px.
