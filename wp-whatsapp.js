// Welcome Pickups Transfer Assistant — WhatsApp Web auto-send (1.7.123)
//
// Runs only on web.whatsapp.com. The dashboard (BC / Final BC / Raise
// suggested / city popup) queues { city, text } jobs in chrome.storage; this
// script sends each one into that city's WhatsApp group:
//   1. find the group (remembered per city; the first time it searches the
//      city name — one match is used, several/none show a chooser);
//   2. open it, paste the message, press send, check the box emptied;
//   3. report the result back to the dashboard Terminal.
// Safety: never sends to a guessed chat, never the same text to the same
// group twice within 10 minutes, one message per queued job.
(function() {
    'use strict';
    // Injected by the manifest and, for tabs opened earlier, by the
    // background: run once.
    // One live copy per tab. A copy left over from before an extension
    // update is dead (its extension context is gone), so a new one runs.
    const myRuntime = chrome.runtime;
    // 1.7.282: in a frame only inside the extension's side panel (any other
    // frame of web.whatsapp.com is left alone).
    const PANEL_ORIGIN = 'chrome-extension://' + myRuntime.id;
    const IN_PANEL = window.top !== window;
    if (IN_PANEL) {
        let parentOrigin = '';
        try { parentOrigin = location.ancestorOrigins && location.ancestorOrigins.length ? location.ancestorOrigins[0] : ''; } catch (_) {}
        if (parentOrigin !== PANEL_ORIGIN) return;
    }
    if (typeof window.__wpWhatsAppSenderAlive === 'function' && window.__wpWhatsAppSenderAlive()) return;
    window.__wpWhatsAppSenderAlive = function() {
        try { return Boolean(myRuntime && myRuntime.id); } catch (_) { return false; }
    };

    const JOBS_KEY = 'wp_wa_jobs_v1';
    // v2 (1.7.157): names are only kept once the chat was confirmed to be
    // that city's group; the older ones may be wrong, so they start fresh.
    const GROUPS_KEY = 'wp_wa_groups_v2';
    const SENT_KEY = 'wp_wa_sent_v1';
    // Shorter than the dashboard's 60s give-up, so a message you already
    // sent by hand is never sent again later by a late WhatsApp tab.
    const JOB_MAX_AGE = 55 * 1000;
    const DUPLICATE_WINDOW = 10 * 60 * 1000;
    const OPENING_KEY = 'wp_wa_opening_v1';
    // Invite code -> the group's exact name, learned the first time the
    // group is opened from its link. Afterwards the group is opened by
    // name (no reload) and only used when the open chat's name matches
    // exactly; anything else falls back to the link.
    const CODE_TITLES_KEY = 'wp_wa_code_titles_v2';
    // Every page change the extension makes: mark it first so WhatsApp's
    // "Leave site?" warning is skipped (wp-whatsapp-main.js).
    function wpWaGo(url) {
        try { document.documentElement.setAttribute('data-wp-wa-navigating', '1'); } catch (_) {}
        // 1.7.282: in the side panel the panel page loads it (the extension's
        // rule lets WhatsApp load in the frame for the panel's own requests)
        if (IN_PANEL) {
            try { window.parent.postMessage({ wpWaGo: String(url) }, PANEL_ORIGIN); } catch (_) {}
        } else {
            location.assign(url);
        }
        // If the page did not leave (e.g. blocked), stop skipping warnings.
        setTimeout(function() {
            try { document.documentElement.removeAttribute('data-wp-wa-navigating'); } catch (_) {}
        }, 5000);
    }
    (async function forgetBadTitles() {
        try {
            const bad = function(title) { return !title || /click here for|tap here for|group info|contact info/i.test(String(title)); };
            const stored = await chrome.storage.local.get([CODE_TITLES_KEY, GROUPS_KEY]);
            const titles = stored[CODE_TITLES_KEY] || {};
            const groups = stored[GROUPS_KEY] || {};
            let changed = false;
            Object.keys(titles).forEach(function(code) { if (bad(titles[code])) { delete titles[code]; changed = true; } });
            Object.keys(groups).forEach(function(city) { if (bad(groups[city])) { delete groups[city]; changed = true; } });
            if (changed) await chrome.storage.local.set({ [CODE_TITLES_KEY]: titles, [GROUPS_KEY]: groups });
        } catch (_) {}
    })();
    let running = false;
    let navigating = false;

    const sleep = function(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); };
    const norm = function(value) {
        return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toLowerCase().replace(/\s+/g, ' ').trim();
    };
    const hash = function(text) {
        let h = 0;
        const s = String(text || '');
        for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return String(h);
    };
    async function waitFor(fn, timeout, step) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeout) {
            try {
                const value = fn();
                if (value) return value;
            } catch (_) {}
            await sleep(step || 250);
        }
        return null;
    }
    async function getStore(key) {
        const result = await chrome.storage.local.get(key);
        return result[key];
    }
    async function setStore(key, value) {
        const patch = {};
        patch[key] = value;
        await chrome.storage.local.set(patch);
    }
    // 1.7.315: take jobs off the queue from a fresh read. The page used to
    // write back the copy it read before opening a chat, so a message queued
    // meanwhile (the next city of a City Manager batch) was lost.
    async function dropJobs(test) {
        const fresh = (await getStore(JOBS_KEY)) || [];
        const kept = fresh.filter(function(job) { return !test(job); });
        if (kept.length !== fresh.length) await setStore(JOBS_KEY, kept);
    }
    function report(job, ok, info, progress, extra) {
        try { console.log('[Transfer Assistant] ' + (job.label || job.city) + ': ' + info); } catch (_) {}
        try {
            chrome.runtime.sendMessage(Object.assign({
                type: 'WP_WA_RESULT', jobId: job.id, fromTabId: job.fromTabId,
                label: job.label, city: job.city, ok: ok, info: info, progress: Boolean(progress)
            }, extra || {}));
        } catch (_) {}
    }
    const progress = function(job, info) { report(job, true, info, true); };

    // ---- WhatsApp Web page parts (several selectors: WA changes its DOM) ----
    function paneSide() { return document.querySelector('#pane-side'); }
    function searchBox() {
        return document.querySelector(
            '#side div[contenteditable="true"][role="textbox"], ' +
            '#side [contenteditable="true"][data-tab="3"], ' +
            '#side input[type="text"], #side input[role="textbox"], ' +
            '[aria-label="Search input textbox"], div[title="Search input textbox"]'
        );
    }
    // Chat rows of the left panel — the chat list or the search results
    // (WhatsApp may render those outside #pane-side). `target` is the chat
    // name element: WhatsApp listens for clicks on the row's inner
    // elements, so the click goes there (a click on the row itself does
    // not reach them and the chat did not open).
    function chatRows() {
        const roots = [paneSide(), document.querySelector('#side'), document.querySelector('[aria-label*="Search results" i]')]
            .filter(Boolean);
        const out = [];
        const seenRows = new Set();
        roots.forEach(function(root) {
            Array.from(root.querySelectorAll('[role="listitem"], [role="row"], [role="option"]')).forEach(function(row) {
                if (seenRows.has(row) || row.closest('#main')) return;
                seenRows.add(row);
                const name = row.querySelector('span[title]') || row.querySelector('span[dir="auto"]');
                const title = name ? String(name.getAttribute('title') || name.textContent || '').trim() : '';
                if (title && !out.some(function(entry) { return entry.title === title; })) {
                    out.push({ row: row, title: title, target: name });
                }
            });
        });
        return out;
    }
    // The chat's name in the chat header. The header also has a second
    // line ("click here for group info", "online", "typing…", member
    // names) — never that one (1.7.143: it was read as the group's name).
    function isHeaderNoise(text) {
        // WhatsApp's own labels on the header ("Profile details" on the
        // clickable area, buttons) are not the chat's name (1.7.158).
        return /click here for (group|contact) info|tap here for|group info|contact info|^online$|typing|recording|last seen|^you$|, you$|^you,/i.test(text) ||
            /^(profile details|details|search|menu|more options|video call|voice call|call|get the app|select messages|close chat)$/i.test(text) ||
            (text.split(',').length > 2);
    }
    function headerTitle() {
        const header = document.querySelector('#main header');
        if (!header) return '';
        // The chat name is a text span (dir="auto"); not the title / aria
        // labels of WhatsApp's buttons and clickable areas.
        const candidates = Array.from(header.querySelectorAll('span[dir="auto"], span[title]'))
            .map(function(el) { return String(el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim(); })
            .filter(function(text) { return text && !isHeaderNoise(text); });
        return candidates[0] || '';
    }
    function composer() {
        return document.querySelector(
            '#main footer div[contenteditable="true"][role="textbox"], #main footer div[contenteditable="true"]'
        );
    }
    function sendButton() {
        const icon = document.querySelector(
            '#main footer button[aria-label="Send"], #main footer [data-icon="send"], ' +
            '#main footer [data-icon="wds-ic-send-filled"], #main footer [aria-label="Send"]'
        );
        return icon ? (icon.closest('button, [role="button"]') || icon) : null;
    }
    function clickEl(el) {
        const options = { bubbles: true, cancelable: true, view: window };
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function(type) {
            const Ctor = type.indexOf('pointer') === 0 && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
            el.dispatchEvent(new Ctor(type, options));
        });
    }
    function setSearch(text) {
        const box = searchBox();
        if (!box) return false;
        box.focus();
        if (box.tagName === 'INPUT') {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(box, text || '');
            box.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            if (text) document.execCommand('insertText', false, text);
        }
        return true;
    }

    // ---- Steps ----
    async function candidatesFor(city) {
        if (!setSearch(city)) return [];
        await sleep(1800);
        const wanted = norm(city);
        return chatRows().filter(function(entry) { return norm(entry.title).indexOf(wanted) >= 0; })
            .map(function(entry) { return entry.title; });
    }

    // "Which chat is Naples?" — shown when the city matches none or several
    // chats. The tab is brought to the front so it can be answered.
    function chooser(city, titles) {
        try { chrome.runtime.sendMessage({ type: 'WP_WA_FOCUS' }); } catch (_) {}
        return new Promise(function(resolve) {
            const overlay = document.createElement('div');
            Object.assign(overlay.style, {
                position: 'fixed', inset: '0', zIndex: '2147483647', background: 'rgba(0,0,0,.55)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', font: '14px Arial, sans-serif'
            });
            const box = document.createElement('div');
            Object.assign(box.style, {
                background: '#111b21', color: '#e9edef', borderRadius: '10px', padding: '18px 20px',
                width: '420px', maxWidth: '90vw', boxShadow: '0 12px 40px rgba(0,0,0,.6)'
            });
            const title = document.createElement('div');
            title.textContent = 'Transfer Assistant — which chat is the ' + city + ' group?';
            Object.assign(title.style, { fontWeight: '700', marginBottom: '10px' });
            box.appendChild(title);
            const note = document.createElement('div');
            note.textContent = titles.length
                ? 'Pick it once; it is remembered for ' + city + '.'
                : 'No chat with "' + city + '" in its name. Type the exact group name:';
            Object.assign(note.style, { color: '#8696a0', fontSize: '12px', marginBottom: '10px' });
            box.appendChild(note);
            const done = function(value) { overlay.remove(); resolve(value || null); };
            titles.slice(0, 10).forEach(function(name) {
                const option = document.createElement('button');
                option.type = 'button';
                option.textContent = name;
                Object.assign(option.style, {
                    display: 'block', width: '100%', textAlign: 'left', margin: '0 0 6px', padding: '8px 10px',
                    background: '#202c33', color: '#e9edef', border: '1px solid #2a3942', borderRadius: '6px', cursor: 'pointer'
                });
                option.addEventListener('click', function() { done(name); });
                box.appendChild(option);
            });
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'Exact group name…';
            Object.assign(input.style, {
                width: '100%', boxSizing: 'border-box', margin: '4px 0 10px', padding: '8px 10px',
                background: '#202c33', color: '#e9edef', border: '1px solid #2a3942', borderRadius: '6px'
            });
            box.appendChild(input);
            const row = document.createElement('div');
            Object.assign(row.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.textContent = 'Cancel (don\'t send)';
            const use = document.createElement('button');
            use.type = 'button';
            use.textContent = 'Use this name';
            [cancel, use].forEach(function(button) {
                Object.assign(button.style, { padding: '7px 12px', borderRadius: '6px', border: '0', cursor: 'pointer' });
            });
            cancel.style.background = '#2a3942'; cancel.style.color = '#e9edef';
            use.style.background = '#00a884'; use.style.color = '#111b21'; use.style.fontWeight = '700';
            cancel.addEventListener('click', function() { done(null); });
            use.addEventListener('click', function() { done(String(input.value || '').trim()); });
            row.appendChild(cancel);
            row.appendChild(use);
            box.appendChild(row);
            overlay.appendChild(box);
            document.body.appendChild(overlay);
        });
    }

    async function openChat(title) {
        if (norm(headerTitle()) === norm(title) && composer()) return true;
        if (!setSearch(title)) return false;
        const hit = await waitFor(function() {
            return chatRows().find(function(entry) { return norm(entry.title) === norm(title); });
        }, 8000);
        if (!hit) return false;
        clickEl(hit.target || hit.row);
        let opened = await waitFor(function() {
            return norm(headerTitle()) === norm(title) && composer();
        }, 4000);
        if (!opened) {
            // Some layouts want the click on the row's clickable wrapper.
            const wrapper = hit.target && (hit.target.closest('[tabindex], [role="gridcell"], [role="button"]') || hit.row);
            if (wrapper) clickEl(wrapper);
            opened = await waitFor(function() {
                return norm(headerTitle()) === norm(title) && composer();
            }, 5000);
        }
        return Boolean(opened);
    }

    // 1.7.296: "@all" at the start (Barcelona): typed by itself so WhatsApp
    // offers its "mention everyone" choice, which is clicked; when WhatsApp
    // offers none it stays as plain text "@all". Never presses Enter here.
    async function typeAtAll(box) {
        box.focus();
        document.execCommand('insertText', false, '@all');
        const option = await waitFor(function() {
            return Array.from(document.querySelectorAll('[role="option"], [role="listitem"], [role="button"], li, div[tabindex]'))
                .filter(function(el) { return !el.closest('#side') && !el.closest('#main header') && (el.offsetParent !== null || el.getClientRects().length); })
                .find(function(el) {
                    const value = String(el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
                    return value && value.length < 60 && (/^@?(all|everyone)\b/i.test(value) || /(notify|mention) (everyone|all)/i.test(value));
                }) || null;
        }, 2000);
        if (option) {
            clickEl(option);
            await sleep(300);
            // WhatsApp adds a space after a mention; one is added when it did not
            if (!/\s$/.test(String(box.textContent || '').replace(/\u00a0/g, ' '))) document.execCommand('insertText', false, ' ');
            return true;
        }
        document.execCommand('insertText', false, ' ');
        return false;
    }
    async function pasteAndSend(text) {
        const box = composer();
        if (!box) return 'no message box';
        box.focus();
        const atAll = String(text).match(/^@all[ \t]+/i);
        if (atAll) {
            await typeAtAll(box);
            text = String(text).slice(atAll[0].length);
        }
        const firstLine = norm(String(text).split('\n')[0]).slice(0, 24);
        const typed = function() { return norm((composer() || {}).textContent || '').indexOf(firstLine) >= 0; };
        const data = new DataTransfer();
        data.setData('text/plain', text);
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        if (!(await waitFor(typed, 4000))) {
            document.execCommand('insertText', false, text);
            if (!(await waitFor(typed, 3000))) return 'could not type the message';
        }
        const button = await waitFor(sendButton, 4000);
        if (!button) return 'no send button';
        clickEl(button);
        const emptied = await waitFor(function() {
            return !norm((composer() || {}).textContent || '');
        }, 6000);
        return emptied ? '' : 'the message box did not empty — check the chat';
    }

    // The image preview's send button (not the chat box's own one).
    // 1.7.319: only a visible one (a hidden "Send" elsewhere was pressed
    // before, so the image stayed in the preview).
    function shown(el) { return Boolean(el) && (el.offsetParent !== null || el.getClientRects().length > 0); }
    function mediaSendButton() {
        const icons = Array.from(document.querySelectorAll(
            '[data-icon="send"], [data-icon="wds-ic-send-filled"], [data-icon="send-light"], [aria-label="Send"]'
        )).filter(function(el) { return !el.closest('#main footer') && !el.closest('#side') && shown(el); });
        const icon = icons[icons.length - 1];
        return icon ? (icon.closest('button, [role="button"]') || icon) : null;
    }
    // 1.7.319: the preview's caption box.
    function mediaCaptionBox() {
        const boxes = Array.from(document.querySelectorAll('div[contenteditable="true"]'))
            .filter(function(el) { return !el.closest('#main footer') && !el.closest('#side') && shown(el); });
        return boxes.find(function(el) { return /caption/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('aria-placeholder') || '') + ' ' + (el.getAttribute('data-placeholder') || '')); }) ||
            boxes[boxes.length - 1] || null;
    }
    // 1.7.319: the text goes in as the image's caption (one message).
    // '' = typed; otherwise why not (then nothing is in the caption).
    async function typeCaption(text) {
        const box = await waitFor(mediaCaptionBox, 5000);
        if (!box) return 'no caption box';
        box.focus();
        const firstLine = norm(String(text).split('\n')[0]).slice(0, 24);
        const typed = function() { return norm((mediaCaptionBox() || {}).textContent || '').indexOf(firstLine) >= 0; };
        const data = new DataTransfer();
        data.setData('text/plain', text);
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        if (!(await waitFor(typed, 3000))) {
            document.execCommand('insertText', false, text);
            if (!(await waitFor(typed, 3000))) {
                // Leave the caption empty rather than half typed.
                if (norm(box.textContent || '')) { document.execCommand('selectAll'); document.execCommand('delete'); }
                return norm((mediaCaptionBox() || {}).textContent || '') ? 'caption could not be cleared' : 'could not type the caption';
            }
        }
        return '';
    }

    // Paste the image into the open chat, then press send in the preview.
    // 1.7.319: caption = the message text; result.captioned says if it went in.
    async function sendImage(dataUrl, caption, result) {
        result = result || {};
        const match = String(dataUrl).match(/^data:(image\/[a-z]+);base64,(.*)$/);
        if (!match) return 'bad image data';
        const binary = atob(match[2]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const file = new File([bytes], 'transfers.' + (match[1] === 'image/jpeg' ? 'jpg' : 'png'), { type: match[1] });
        const box = composer();
        if (!box) return 'no message box';
        box.focus();
        const data = new DataTransfer();
        data.items.add(file);
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        const button = await waitFor(mediaSendButton, 12000);
        if (!button) return 'the image preview did not open';
        await sleep(500);
        if (caption) {
            const captionProblem = await typeCaption(caption);
            if (captionProblem === 'caption could not be cleared') return captionProblem + ' — check the chat, nothing sent';
            result.captioned = !captionProblem;
            await sleep(300);
        }
        result.pressed = true;
        clickEl(mediaSendButton() || button);
        let closed = await waitFor(function() { return !mediaSendButton(); }, 4000);
        if (!closed) {
            // Enter in the caption box also sends the preview.
            const box = mediaCaptionBox();
            if (box) {
                box.focus();
                ['keydown', 'keypress', 'keyup'].forEach(function(type) {
                    box.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
                });
            }
            closed = await waitFor(function() { return !mediaSendButton(); }, 16000);
        }
        return closed ? '' : 'the image preview did not close — check the chat';
    }

    async function isDuplicate(job) {
        const sent = (await getStore(SENT_KEY)) || {};
        const at = sent[dupKeyFor(job)];
        return Boolean(at && Date.now() - at < DUPLICATE_WINDOW);
    }
    // Same group + same text (+ same image) = duplicate.
    function dupKeyFor(job) {
        return norm(job.city) + '|' + hash(job.text) + (job.image ? '|' + hash(job.image) : '');
    }

    // After loading web.whatsapp.com/accept?code=…: wait for that group's
    // chat to open. A dialog offering to open the chat is accepted; one
    // that only offers to JOIN is not (never joins a group by itself).
    // Returns the chat title, '' (did not open) or null (would need joining).
    async function openedFromLink() {
        const startedAt = Date.now();
        const clicked = new Set();
        while (Date.now() - startedAt < 25000) {
            if (composer() && headerTitle()) return headerTitle().trim();
            const dialog = document.querySelector('[role="dialog"], [data-animate-modal-popup="true"]');
            if (dialog) {
                const buttons = Array.from(dialog.querySelectorAll('button, [role="button"]'));
                const open = buttons.find(function(button) {
                    return /open chat|go to chat|view chat|open group|^\s*open\s*$/i.test(button.textContent || '') && !clicked.has(button);
                });
                if (open) {
                    clicked.add(open);
                    clickEl(open);
                } else if (buttons.some(function(button) { return /join/i.test(button.textContent || ''); }) || /join (this )?(group|chat)/i.test(dialog.textContent || '')) {
                    return null;
                } else if (/invalid|expired|reset|revoked|couldn.t|can.t/i.test(dialog.textContent || '')) {
                    return '';
                }
            }
            await sleep(400);
        }
        return '';
    }

    // Save the open chat's number as a WhatsApp contact (heroes): the
    // "Add" / "Add to contacts" option of an unsaved chat (banner, or the
    // contact info panel), type the name, Save. '' = saved; otherwise
    // the reason, and the caller pauses for you to add them by hand.
    function findClickable(root, pattern) {
        // 1.7.292: WhatsApp now puts its icon's name in the text ("ic-person-addAdd"),
        // so the label, the visible text and the text without icon names are all tried.
        const clean = function(value) { return String(value || '').replace(/\s+/g, ' ').trim(); };
        return Array.from((root || document).querySelectorAll('button, [role="button"], div[tabindex], span[tabindex], li'))
            .filter(function(el) { return el.offsetParent !== null || el.getClientRects().length; })
            .find(function(el) {
                const texts = [el.getAttribute('aria-label'), el.innerText, String(el.textContent || '').replace(/\b(?:wds-)?ic-[a-z0-9-]+/g, '')];
                return texts.some(function(text) { const value = clean(text); return value && pattern.test(value); });
            }) || null;
    }
    // True when the field now holds the text.
    async function setFieldText(field, text) {
        field.focus();
        if (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') {
            const proto = field.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, text);
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            return norm(field.value) === norm(text);
        }
        // 1.7.293: WhatsApp's name boxes are a text editor (Lexical) that only
        // replaces a name it has noticed is selected: the box's own text is
        // selected, the editor gets a moment to see it, then the new text is
        // typed over it (seen on WhatsApp Business: an existing name stayed).
        for (let attempt = 0; attempt < 3; attempt++) {
            field.focus();
            await sleep(150);
            try {
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(field);
                selection.removeAllRanges();
                selection.addRange(range);
                document.dispatchEvent(new Event('selectionchange'));
            } catch (_) {}
            await sleep(250 + attempt * 250);
            document.execCommand('insertText', false, text);
            await sleep(300);
            if (norm(field.textContent) === norm(text)) return true;
        }
        return false;
    }
    // 1.7.281: the contact form's text fields and what each one is for
    // ("First name" / "Last name" / phone), so the name goes in First name
    // and "<city> <car type>" in Last name.
    function formFields() {
        return Array.from(document.querySelectorAll('input[type="text"], input:not([type]), div[contenteditable="true"]'))
            .filter(function(el) { return !el.closest('#main footer') && !el.closest('#side') && (el.offsetParent !== null || el.getClientRects().length); });
    }
    function fieldLabel(el) {
        const parts = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('data-placeholder')];
        try { if (el.id) { const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (label) parts.push(label.textContent); } } catch (_) {}
        const wrap = el.closest('label');
        if (wrap) parts.push(wrap.textContent);
        // WhatsApp's floating labels: the short text of the box around the field
        let box = el.parentElement;
        for (let i = 0; i < 3 && box; i++, box = box.parentElement) {
            const own = String(box.textContent || '').replace(/\s+/g, ' ').trim();
            if (own && own.length < 40) { parts.push(own); break; }
        }
        return parts.filter(Boolean).join(' ').toLowerCase();
    }
    function nameFields() {
        const fields = formFields();
        const first = fields.find(function(el) { const label = fieldLabel(el); return /first\s*name|\bname\b/.test(label) && !/last|surname|phone|number|search/.test(label); }) || null;
        const last = fields.find(function(el) { return /last\s*name|surname/.test(fieldLabel(el)); }) || null;
        return { first: first, last: last, fields: fields };
    }
    // Fills the open contact form and presses Save. '' = pressed.
    async function fillContactForm(first, last) {
        const found = await waitFor(function() { const form = nameFields(); return form.fields.length ? form : null; }, 6000);
        if (!found) return 'the contact form did not open';
        await sleep(300);
        const form = nameFields();
        const firstField = form.first || form.fields.find(function(el) { return !/phone|number|search/.test(fieldLabel(el)); }) || null;
        if (!firstField) return 'no name field in the contact form';
        const lastField = form.last && form.last !== firstField ? form.last : null;
        // 1.7.293: never saved with a name that did not go in (an old name would be kept wrongly)
        if (!(await setFieldText(firstField, lastField ? first : (first + ' ' + last).trim()))) return 'the name could not be typed into First name';
        if (lastField && !(await setFieldText(lastField, last))) return 'the city / car type could not be typed into Last name';
        await sleep(500);
        // 1.7.292: WhatsApp Business calls it "Save contact" (shown once a name is typed)
        const save = await waitFor(function() { return findClickable(document, /^save( contact)?$/i); }, 4000);
        if (!save) return 'no Save button in the contact form';
        clickEl(save);
        return '';
    }
    function closeSidePanel() {
        try {
            const close = Array.from(document.querySelectorAll('[aria-label="Close"], [data-icon="x"], [data-icon="close"], [data-icon="x-alt"]'))
                .find(function(el) { return !el.closest('#main footer') && !el.closest('#side'); });
            if (close) clickEl(close.closest('button, [role="button"]') || close);
            else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        } catch (_) {}
    }
    async function addContact(first, last) {
        const addPattern = /^(add|add to contacts|add contact|save contact)$/i;
        let add = findClickable(document.querySelector('#main'), addPattern);
        if (!add) {
            // Contact info panel (click the chat header).
            const header = document.querySelector('#main header');
            if (header) clickEl(header.querySelector('[role="button"]') || header);
            add = await waitFor(function() { return findClickable(document, /^(add to contacts|add contact|save contact|add)$/i); }, 6000);
        }
        if (!add) { closeSidePanel(); return 'no "Add to contacts" option found'; }
        clickEl(add);
        const problem = await fillContactForm(first, last);
        if (problem) { closeSidePanel(); return problem; }
        const saved = await waitFor(function() {
            const title = headerTitle().trim();
            return title && !/^[+\d\s().-]+$/.test(title);
        }, 12000);
        try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
        return saved ? '' : 'the chat still shows the number after saving';
    }
    // 1.7.281: a saved contact with another name → its contact info, Edit,
    // the same First / Last name, Save. '' = renamed.
    async function renameContact(first, last) {
        const header = document.querySelector('#main header');
        if (!header) return 'no chat header';
        clickEl(header.querySelector('[role="button"]') || header);
        const edit = await waitFor(function() {
            const icon = Array.from(document.querySelectorAll('[data-icon], [aria-label], [title]'))
                .filter(function(el) { return !el.closest('#main') && !el.closest('#side') && (el.offsetParent !== null || el.getClientRects().length); })
                .find(function(el) {
                    return /^(pencil|edit|ic-edit|wds-ic-edit|edit-contact)/i.test(el.getAttribute('data-icon') || '') ||
                        /^edit( contact)?$/i.test(String(el.getAttribute('aria-label') || el.getAttribute('title') || '').trim());
                });
            return icon ? (icon.closest('button, [role="button"]') || icon) : findClickable(document, /^edit( contact)?$/i);
        }, 6000);
        if (!edit) { closeSidePanel(); return 'no Edit option in the contact info'; }
        clickEl(edit);
        const problem = await fillContactForm(first, last);
        if (problem) { closeSidePanel(); return problem; }
        const wanted = norm(first + ' ' + last);
        const renamed = await waitFor(function() { return norm(headerTitle()) === wanted; }, 12000);
        closeSidePanel();
        return renamed ? '' : 'the chat does not show the new name after saving';
    }
    // A rename that did not work is tried again a day later, not on every send.
    const RENAME_FAILED_KEY = 'wp_wa_rename_failed_v1';

    // ---- Is the open chat really the target? (1.7.157) ----
    // A group: WhatsApp's header says "click here for group info" or lists
    // the members; a person's chat says "contact info" / "online" / "last
    // seen". The group's name must also contain the city (job.expect, e.g.
    // "Budapest", "Heraklion"), so a driver's chat can never pass.
    const GENERIC_WORDS = /^(welcomers?|dispatchers?|welcome|group|drivers?|wp|team|the|and)$/;
    function chatIsGroup() {
        const header = document.querySelector('#main header');
        if (!header) return false;
        const text = String(header.textContent || '');
        if (/group info/i.test(text)) return true;
        if (/contact info|last seen|\bonline\b/i.test(text)) return false;
        return Array.from(header.querySelectorAll('span[title], span[dir="auto"]')).some(function(el) {
            return String(el.getAttribute('title') || el.textContent || '').split(',').length > 2;
        });
    }
    function titleMatchesCity(title, job) {
        const name = norm(title);
        const words = (Array.isArray(job.expect) && job.expect.length ? job.expect : [job.city])
            .map(norm).join(' ').split(/[^a-z0-9]+/)
            .filter(function(word) { return word.length >= 3 && !GENERIC_WORDS.test(word); });
        if (!words.length) return false;
        return words.some(function(word) { return name.indexOf(word.slice(0, Math.min(5, word.length))) >= 0; });
    }
    function isTargetGroup(job) {
        const title = headerTitle().trim();
        return Boolean(title && composer() && chatIsGroup() && titleMatchesCity(title, job));
    }
    // A person by phone: the header shows the number, or (saved contact)
    // the contact info panel does. The last 9 digits must match.
    async function chatIsPhone(phone) {
        const tail = String(phone || '').replace(/\D/g, '').slice(-9);
        if (tail.length < 7) return false;
        const title = headerTitle().trim();
        if (/^[+\d\s().-]+$/.test(title)) return title.replace(/\D/g, '').endsWith(tail);
        const header = document.querySelector('#main header');
        if (!header) return false;
        clickEl(header.querySelector('[role="button"]') || header);
        // 1.7.296 (the 1.7.295 fix): WhatsApp Business splits the number in
        // the contact panel across several elements, so whole short texts
        // that look like a phone number are read with innerText as well.
        const found = await waitFor(function() {
            return Array.from(document.querySelectorAll('span[dir="auto"], span[title], div[title], span, div'))
                .filter(function(el) { return !el.closest('#main') && !el.closest('#side') && (el.children.length === 0 || el.offsetParent !== null || el.getClientRects().length); })
                .map(function(el) {
                    const text = el.children.length === 0 ? String(el.textContent || '') : String(el.innerText || '');
                    return text.length <= 40 && /^[+\d\s().\u00a0\u200e\u200f\u202a-\u202e-]+$/.test(text.trim()) ? text.replace(/\D/g, '') : '';
                })
                .find(function(digits) { return digits.length >= 9 && digits.length <= 15 && digits.endsWith(tail); });
        }, 6000);
        closeSidePanel();
        return Boolean(found);
    }

    async function handle(job, viaLink) {
        const sent = (await getStore(SENT_KEY)) || {};
        Object.keys(sent).forEach(function(key) { if (Date.now() - sent[key] > DUPLICATE_WINDOW) delete sent[key]; });
        const cityKey = norm(job.city);
        const dupKey = dupKeyFor(job);
        if (sent[dupKey]) {
            report(job, false, 'the same message was already sent to this group in the last 10 minutes — not sent again');
            return;
        }
        // A person (hero) by phone number: the chat opened from
        // web.whatsapp.com/send?phone=… Only sent to saved contacts — a chat
        // whose header shows the bare number is not in your contacts.
        if (job.phone) {
            const chatTitle = viaLink ? await openedFromLink() : '';
            if (!chatTitle) {
                report(job, false, 'could not open the chat with +' + job.phone + ' — is the number on WhatsApp?');
                return;
            }
            // Only the chat with this exact number (not a chat that happened
            // to be open) — checked twice while the page settles.
            let isRight = await chatIsPhone(job.phone);
            if (!isRight) { await sleep(2500); isRight = await chatIsPhone(job.phone); }
            if (!isRight) {
                report(job, false, 'could not confirm the open chat is +' + job.phone + ' — nothing sent');
                return;
            }
            let contactTitle = headerTitle().trim() || chatTitle;
            // 1.7.281: heroes are saved as First name = their name, Last name
            // = "<city> <car type>"; the old one-line name when that is not given.
            const first = String(job.contactFirst || '').trim();
            const last = String(job.contactLast || '').trim();
            const wantedName = first ? (first + ' ' + last).trim() : String(job.contactName || '').trim();
            let contactNote = '';
            if (/^[+\d\s().-]+$/.test(contactTitle)) {
                // Not a saved contact: add them first, then send.
                const addProblem = wantedName ? await addContact(first || wantedName, first ? last : '') : 'no name to save';
                if (addProblem) {
                    // 1.7.281: not waiting for you — the chat is this number, so the message still goes
                    if (job.contactOnly) { report(job, false, '+' + job.phone + ': could not save as "' + wantedName + '" (' + addProblem + ')'); return; }
                    contactNote = ' (not saved as a contact: ' + addProblem + ' — save it as "' + wantedName + '" by hand)';
                    progress(job, 'could not save +' + job.phone + ' as "' + wantedName + '" (' + addProblem + ') — sending anyway');
                } else {
                    contactTitle = headerTitle().trim();
                    progress(job, 'added "' + contactTitle + '" to your contacts');
                }
            } else if (first && norm(contactTitle) !== norm(wantedName)) {
                // Saved under another name: the same format for everyone
                const failed = (await getStore(RENAME_FAILED_KEY)) || {};
                const tail = String(job.phone).slice(-9);
                if (job.contactOnly || !(failed[tail] && Date.now() - failed[tail] < 24 * 3600000)) {
                    progress(job, 'saved as "' + contactTitle + '" — renaming to "' + wantedName + '"');
                    const renameProblem = await renameContact(first, last);
                    if (renameProblem) {
                        failed[tail] = Date.now();
                        await setStore(RENAME_FAILED_KEY, failed);
                        if (job.contactOnly) { report(job, false, 'could not rename "' + contactTitle + '" to "' + wantedName + '" (' + renameProblem + ')'); return; }
                        contactNote = ' (still named "' + contactTitle + '": ' + renameProblem + ')';
                    } else {
                        if (failed[tail]) { delete failed[tail]; await setStore(RENAME_FAILED_KEY, failed); }
                        progress(job, 'renamed "' + contactTitle + '" to "' + headerTitle().trim() + '"');
                        contactTitle = headerTitle().trim();
                    }
                }
            }
            if (job.contactOnly) { report(job, true, 'saved as "' + contactTitle + '"'); return; }
            progress(job, 'chat with "' + contactTitle + '" open — typing and sending');
            const personProblem = await pasteAndSend(job.text);
            if (personProblem) {
                report(job, false, personProblem + ' (chat "' + contactTitle + '")');
                return;
            }
            sent[dupKey] = Date.now();
            await setStore(SENT_KEY, sent);
            report(job, true, 'sent to "' + contactTitle + '"' + contactNote);
            return;
        }
        const groups = (await getStore(GROUPS_KEY)) || {};
        let title = '';
        if (viaLink) {
            const opened = await openedFromLink();
            if (opened === null) {
                report(job, false, 'the ' + job.city + ' link asks to JOIN the group — you are not in it, so nothing was sent');
                return;
            }
            // The chat shown first can be another one (restored / clicked):
            // wait for THE city's group before trusting it.
            const confirmed = opened ? await waitFor(function() { return isTargetGroup(job); }, 12000, 400) : false;
            if (opened && confirmed) {
                title = headerTitle().trim();
                groups[cityKey] = title; // remembered for when the link fails
                await setStore(GROUPS_KEY, groups);
                if (job.code) {
                    const codeTitles = (await getStore(CODE_TITLES_KEY)) || {};
                    codeTitles[job.code] = title;
                    await setStore(CODE_TITLES_KEY, codeTitles);
                }
                progress(job, 'group "' + title + '" opened from its link — typing and sending');
            } else if (opened) {
                progress(job, 'the open chat "' + headerTitle().trim() + '" is not the ' + job.city + ' group — looking the group up by name');
            } else {
                progress(job, 'the link did not open the chat — looking the group up by name');
            }
        } else {
            progress(job, 'WhatsApp Web picked up the message');
        }
        if (!title) title = job.knownTitle || groups[cityKey] || '';
        if (!title) {
            if (!searchBox()) {
                report(job, false, 'WhatsApp search box not found (WhatsApp Web layout changed?)');
                return;
            }
            const found = await candidatesFor(job.city);
            // Groups with a link never ask: either exactly one match or not sent.
            if (job.code && found.length !== 1) {
                report(job, false, 'the ' + job.city + ' link did not open the group and ' + found.length + ' chats match its name — not sent');
                return;
            }
            progress(job, found.length + ' chat' + (found.length === 1 ? '' : 's') + ' named like "' + job.city + '"' + (found.length === 1 ? '' : ' — asking you in the WhatsApp tab'));
            if (found.length !== 1) job.chosenByYou = true;
            title = found.length === 1 ? found[0] : await chooser(job.city, found);
            if (!title) {
                report(job, false, 'no group chosen for ' + job.city);
                return;
            }
        }
        if (!(norm(headerTitle()) === norm(title) && composer())) {
            if (!(await openChat(title))) {
                report(job, false, 'could not open the group "' + title + '"' + (searchBox() ? '' : ' (search box not found)'));
                return;
            }
            progress(job, 'group "' + title + '" open — typing and sending');
        }
        // Last check before typing: this must be the city's group. (A chat
        // you picked in the chooser only needs to be a group.)
        const openTitle = headerTitle().trim();
        if (!(composer() && chatIsGroup() && (job.chosenByYou || titleMatchesCity(openTitle, job)))) {
            report(job, false, 'the open chat "' + openTitle + '" is not the ' + job.city + ' group — nothing sent');
            return;
        }
        if (!groups[cityKey] || groups[cityKey] !== openTitle) {
            groups[cityKey] = openTitle;
            await setStore(GROUPS_KEY, groups);
        }
        // Confirmed: next time this group opens by name, without a reload.
        if (job.code && !job.chosenByYou) {
            const codeTitles = (await getStore(CODE_TITLES_KEY)) || {};
            if (codeTitles[job.code] !== openTitle) {
                codeTitles[job.code] = openTitle;
                await setStore(CODE_TITLES_KEY, codeTitles);
            }
        }
        title = openTitle;
        // 1.7.319: with an image, the text is its caption (one message).
        // "@all" groups keep text first (the mention needs the chat box).
        if (job.image && !/^@all\b/i.test(String(job.text))) {
            progress(job, 'sending the image with the text');
            const result = {};
            const imageProblem = await sendImage(job.image, job.text, result);
            if (result.pressed) {
                sent[dupKey] = Date.now();
                await setStore(SENT_KEY, sent);
            }
            if (imageProblem) {
                report(job, false, (result.pressed ? 'send pressed in "' + title + '" but ' : '') + imageProblem + (result.pressed ? '' : ' — open the image from the Terminal, copy it and paste it'));
                return;
            }
            if (result.captioned) {
                report(job, true, 'sent to "' + title + '" (image with the text)');
                return;
            }
            // Caption did not take: the image is out, the text goes after it.
            const textProblem = await pasteAndSend(job.text);
            report(job, !textProblem, textProblem ? 'image sent to "' + title + '" but the text was not: ' + textProblem : 'sent to "' + title + '" (image, then the text)');
            return;
        }
        const problem = await pasteAndSend(job.text);
        if (problem) {
            report(job, false, problem + ' (group "' + title + '")');
            return;
        }
        // The text is out: never resend it, even if the image fails.
        sent[dupKey] = Date.now();
        await setStore(SENT_KEY, sent);
        if (job.image) {
            progress(job, 'text sent — sending the image');
            const imageProblem = await sendImage(job.image);
            if (imageProblem) {
                report(job, false, 'text sent to "' + title + '" but the image was not: ' + imageProblem + ' — open the image from the Terminal, copy it and paste it');
                return;
            }
            report(job, true, 'and image sent to "' + title + '"');
            return;
        }
        report(job, true, 'sent to "' + title + '"');
    }

    // 1.7.282: while the side panel's WhatsApp is open and logged in, it
    // sends; a WhatsApp tab leaves the jobs to it.
    const BOX_KEY = 'wp_wa_box_alive_v1';
    const BOX_FRESH = 60000;
    async function panelTakesJobs() {
        if (IN_PANEL) return false;
        let box = null;
        try { box = await getStore(BOX_KEY); } catch (_) {}
        return Boolean(box && box.ready && Date.now() - Number(box.at) < BOX_FRESH);
    }

    async function runJobs() {
        if (running) return;
        running = true;
        try {
            if (await panelTakesJobs()) return;
            // Logged in and the chat list is there. 1.7.293: a tab that shows
            // "WhatsApp is open in another window" takes WhatsApp back (Use here),
            // as mod has messages to send from it.
            // Only when a message is still waiting after 25 s (no other
            // WhatsApp tab took them), so two tabs never pull it back and forth.
            const waitStart = Date.now();
            let ready = Boolean(paneSide());
            while (!ready && Date.now() - waitStart < 90000) {
                await sleep(1000);
                ready = Boolean(paneSide());
                if (ready || Date.now() - waitStart < 10000) continue;
                const useHere = findClickable(document, /^use here$/i);
                const pending = (await getStore(JOBS_KEY)) || [];
                // a message nobody has picked up for 25 s (another live tab takes one within seconds)
                if (useHere && pending.some(function(job) { return Date.now() - Number(job.createdAt) > 25000; })) {
                    try { console.log('[Transfer Assistant] WhatsApp was open in another window — "Use here" pressed, ' + pending.length + ' message(s) waiting'); } catch (_) {}
                    clickEl(useHere);
                    await sleep(4000);
                }
            }
            if (!ready) {
                // Not logged in / never loaded: fail the waiting jobs loudly.
                const waiting = (await getStore(JOBS_KEY)) || [];
                await dropJobs(function(j) { return waiting.some(function(w) { return w.id === j.id; }); });
                waiting.forEach(function(job) { report(job, false, 'WhatsApp Web did not load its chat list in 90s — is it logged in?'); });
                return;
            }
            await sleep(800);
            for (;;) {
                if (navigating) return;
                if (await panelTakesJobs()) return;
                // The job whose group link this page was loaded for.
                let opening = '';
                try { opening = sessionStorage.getItem(OPENING_KEY) || ''; } catch (_) {}
                let jobs = (await getStore(JOBS_KEY)) || [];
                const expired = function(job) { return !(job.id === opening || Date.now() - job.createdAt < JOB_MAX_AGE); };
                jobs = jobs.filter(function(job) { return !expired(job); });
                const job = jobs[0];
                if (!job) {
                    await dropJobs(expired);
                    try { sessionStorage.removeItem(OPENING_KEY); } catch (_) {}
                    break;
                }
                // Group link known: load it (the page reloads; the job stays
                // queued and is sent by the reloaded page). Duplicates are
                // refused before reloading.
                // Known group: open it by its exact name, without reloading.
                if (job.code && opening !== job.id && !(await isDuplicate(job))) {
                    const codeTitles = (await getStore(CODE_TITLES_KEY)) || {};
                    const known = codeTitles[job.code];
                    const shared = known && Object.keys(codeTitles).some(function(code) {
                        return code !== job.code && norm(codeTitles[code]) === norm(known);
                    });
                    if (known && !shared) {
                        progress(job, 'opening the ' + job.city + ' group "' + known + '" (no reload)');
                        let opened = false;
                        try { opened = await openChat(known); } catch (_) {}
                        opened = opened && norm(headerTitle()) === norm(known) && isTargetGroup(job);
                        try { setSearch(''); } catch (_) {}
                        if (opened) {
                            jobs.shift();
                            await dropJobs(function(j) { return j.id === job.id || expired(j); });
                            job.knownTitle = known;
                            try {
                                await handle(job, false);
                            } catch (error) {
                                report(job, false, 'error: ' + (error && error.message || error));
                            }
                            // 5 s between messages.
                            await sleep(5000);
                            continue;
                        }
                        progress(job, 'could not open "' + known + '" by name — using the group link');
                    }
                }
                if ((job.code || job.phone) && opening !== job.id && !(await isDuplicate(job))) {
                    await dropJobs(expired);
                    try { sessionStorage.setItem(OPENING_KEY, job.id); } catch (_) {}
                    progress(job, job.phone ? 'opening the chat with ' + job.city : 'opening the ' + job.city + ' group from its link');
                    navigating = true;
                    wpWaGo(job.phone
                        ? 'https://web.whatsapp.com/send?phone=' + encodeURIComponent(job.phone)
                        : 'https://web.whatsapp.com/accept?code=' + encodeURIComponent(job.code));
                    return;
                }
                jobs.shift();
                await dropJobs(function(j) { return j.id === job.id || expired(j); });
                try { sessionStorage.removeItem(OPENING_KEY); } catch (_) {}
                try {
                    await handle(job, opening === job.id);
                } catch (error) {
                    report(job, false, 'error: ' + (error && error.message || error));
                }
                // 5 s between messages.
                await sleep(5000);
            }
        } finally {
            running = false;
        }
    }

    // Open a group for you (city button / group link): by its learned name
    // without a reload; the link only when the name is not known yet.
    async function showGroup(code) {
        const codeTitles = (await getStore(CODE_TITLES_KEY)) || {};
        const known = codeTitles[code];
        if (known && !running) {
            let opened = false;
            try { opened = await openChat(known); } catch (_) {}
            try { setSearch(''); } catch (_) {}
            if (opened) return;
        }
        if (running) return; // a send is using the tab; it will be free soon
        wpWaGo('https://web.whatsapp.com/accept?code=' + encodeURIComponent(code));
    }

    // 1.7.297: "Copy tour info" on a CRM tour page (wp-tours.js, was the
    // Tampermonkey script) opens the city's S-rides group the way mod opens
    // groups, and leaves the message here. It is put in that group's message
    // box once — NEVER sent. Only in the group: the page was loaded for its
    // link, or the open chat has the group's learned name. Fresh for 2 min.
    const TOUR_PENDING_KEY = 'wp_tour_wa_pending_v1';
    const START_URL = location.href;
    let tourPasteBusy = false;
    async function tourPaste() {
        if (tourPasteBusy) return;
        let pending = await getStore(TOUR_PENDING_KEY);
        if (!pending || !pending.text || !pending.code || Date.now() - Number(pending.at || 0) > 2 * 60 * 1000) return;
        tourPasteBusy = true;
        try {
            const codeTitles = (await getStore(CODE_TITLES_KEY)) || {};
            const known = codeTitles[pending.code] || '';
            const fromLink = START_URL.indexOf(pending.code) >= 0;
            const box = await waitFor(function() {
                if (running) return null;
                const ready = composer();
                if (!ready) return null;
                if (known) return norm(headerTitle()) === norm(known) ? ready : null;
                return fromLink ? ready : null;
            }, 60000, 500);
            if (!box) return;
            // still waiting (not taken by another WhatsApp page meanwhile)
            const still = await getStore(TOUR_PENDING_KEY);
            if (!still || still.at !== pending.at) return;
            await chrome.storage.local.remove(TOUR_PENDING_KEY);
            box.focus();
            const data = new DataTransfer();
            data.setData('text/plain', String(pending.text));
            box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
            await sleep(300);
            if (!norm(box.textContent)) document.execCommand('insertText', false, String(pending.text));
        } finally {
            tourPasteBusy = false;
        }
    }

    // (1.7.157) Names are no longer learned from any chat opened from a link —
    // only from a send that confirmed the city's group.

    chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
        if (message && message.type === 'WP_WA_RUN') runJobs();
        // Any other web.whatsapp.com page (hero chat links): same marked change.
        if (message && message.type === 'WP_WA_GO' && /^https:\/\/web\.whatsapp\.com\//.test(String(message.url || ''))) {
            wpWaGo(String(message.url));
            sendResponse({ ok: true });
        }
        if (message && message.type === 'WP_WA_SHOW' && /^[A-Za-z0-9]{10,40}$/.test(String(message.code || ''))) {
            showGroup(String(message.code));
            sendResponse({ ok: true });
        }
    });
    chrome.storage.onChanged.addListener(function(changes, area) {
        if (area === 'local' && changes[JOBS_KEY] && Array.isArray(changes[JOBS_KEY].newValue) && changes[JOBS_KEY].newValue.length) runJobs();
        if (area === 'local' && changes[TOUR_PENDING_KEY] && changes[TOUR_PENDING_KEY].newValue) tourPaste();
    });
    // 1.7.282: the side panel's copy says it is there (logged in or not),
    // and takes the panel page's messages (a group / a send to run).
    if (IN_PANEL) {
        const say = function(text) { try { window.parent.postMessage({ wpWaState: text }, PANEL_ORIGIN); } catch (_) {} };
        // 1.7.285: the panel's Mute button (wp-whatsapp-main.js silences the sounds)
        // 1.7.286: the narrow icon column on the left (Chats, Calls, Status,
        // Channels, Communities, Settings…) is hidden in the panel, so the
        // chat list and the chat get the room. Found by its shape: a column
        // at the left edge, under 90 px wide, nearly the full height, with
        // several buttons in it. Looked for again when WhatsApp redraws.
        const hideRail = function() {
            if (!paneSide()) return; // logged out: the login page has no column
            const tall = window.innerHeight * 0.8;
            // what is under a point near the left edge, innermost first
            const stack = document.elementsFromPoint(20, Math.round(window.innerHeight / 2));
            let rail = null;
            stack.forEach(function(el) {
                if (!el.closest('#app') || el.id === 'app') return;
                const box = el.getBoundingClientRect();
                if (box.left > 2 || box.width < 36 || box.width > 90 || box.height < tall) return;
                if (el.querySelectorAll('button, [role="button"], [data-icon]').length < 4) return;
                rail = el; // keeps going out: the outermost such column wins
            });
            if (rail) {
                rail.setAttribute('data-wp-rail', '1');
                rail.style.setProperty('display', 'none', 'important');
            }
        };
        setInterval(hideRail, 1500);
        const MUTE_KEY = 'wp_wa_panel_muted_v1';
        const setMute = function(on) {
            try { if (on) document.documentElement.setAttribute('data-wp-mute', '1'); else document.documentElement.removeAttribute('data-wp-mute'); } catch (_) {}
        };
        getStore(MUTE_KEY).then(function(on) { setMute(Boolean(on)); }, function() {});
        chrome.storage.onChanged.addListener(function(changes, area) {
            if (area === 'local' && changes[MUTE_KEY]) setMute(Boolean(changes[MUTE_KEY].newValue));
        });
        const beat = function(ready) {
            try { chrome.storage.local.set({ [BOX_KEY]: { at: Date.now(), ready: Boolean(ready) } }); } catch (_) {}
            say(ready ? 'logged in — mod sends from here' : 'not logged in — scan the QR code once (mod uses a WhatsApp tab meanwhile)');
        };
        (async function() {
            // a page that is still loading keeps the last "logged in" (a send's reload)
            const loaded = await waitFor(paneSide, 60000, 500);
            beat(Boolean(loaded));
            setInterval(function() { beat(Boolean(paneSide())); }, 8000);
        })();
        window.addEventListener('pagehide', function() {
            // closed (not a reload of mod's own) → the tab takes over at once
            if (navigating) return;
            try { chrome.storage.local.set({ [BOX_KEY]: { at: 0, ready: false } }); } catch (_) {}
        });
        window.addEventListener('message', function(event) {
            if (event.source !== window.parent || event.origin !== PANEL_ORIGIN) return;
            const msg = event.data && event.data.wpPanel;
            if (!msg) return;
            if (msg.type === 'WP_WA_RUN') runJobs();
            if (msg.type === 'WP_WA_SHOW' && /^[A-Za-z0-9]{10,40}$/.test(String(msg.code || ''))) showGroup(String(msg.code));
        });
    }
    runJobs();
    tourPaste();
})();
