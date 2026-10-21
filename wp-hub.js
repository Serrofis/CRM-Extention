// Welcome Pickups Transfer Assistant — Ops Intelligence Hub helper.
//
// Runs on the Live Ops page of the Hub. The City Manager (on the PC, or
// through the phone app) sends the CRM transfer numbers of what is ticked
// there; here the same transfers are ticked in the Hub's Transfers list. Each
// Hub row has a tick box labelled "Select transfer <CRM number>", so the
// match is exact.
//
// 1.7.222  select only
// 1.7.223  + press one of the bar's buttons (Tag runs at once in the Hub;
//            every other one opens the Hub's dialog)
// 1.7.224  + "auto" (the phone app, and the PC when "Confirm in the Hub for
//            me" is ticked): the Hub's dialog is filled in and its confirm
//            button pressed here. What was confirmed and how it went is
//            reported back.
//          + what happens to a dialog you confirm yourself is reported too,
//            for the City Manager's Hub history.
(function() {
    'use strict';
    if (window.__wpHubSelectLoaded === 224) return;
    window.__wpHubSelectLoaded = 224;

    // A hidden tab's timers are slowed down by Chrome (to once a minute after
    // a while). The waits here go through the extension's background, which
    // is not slowed, when this tab is hidden.
    const pause = function(ms) {
        return new Promise(function(resolve) {
            let done = false;
            const finish = function() { if (!done) { done = true; resolve(); } };
            if (document.hidden) {
                try { chrome.runtime.sendMessage({ type: 'WP_HUB_SLEEP', ms: ms }, finish); } catch (_) { setTimeout(finish, ms); }
                setTimeout(finish, ms + 65000);
            } else {
                setTimeout(finish, ms);
            }
        });
    };
    const text = function(node) { return String(node ? node.textContent : '').replace(/\s+/g, ' ').trim(); };
    const rowBoxes = function() { return Array.from(document.querySelectorAll('tbody input[type="checkbox"][aria-label^="Select transfer "]')); };
    const boxFor = function(id) { return document.querySelector('tbody input[type="checkbox"][aria-label="Select transfer ' + id + '"]'); };
    const buttonNamed = function(pattern, root) {
        return Array.from((root || document).querySelectorAll('button')).find(function(button) { return pattern.test(text(button)); }) || null;
    };
    const dialogNow = function() { return document.querySelector('[role="dialog"]'); };
    // A value typed into one of the Hub's boxes (the page only notices a
    // change made through the element's own setter plus an input event).
    const typeInto = function(element, value) {
        const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, String(value));
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    };

    async function selectIds(rawIds) {
        const ids = Array.from(new Set((rawIds || []).map(function(id) { return String(id).replace(/\D/g, ''); }).filter(Boolean)));
        if (!ids.length) return { ok: false, reason: 'nothing', message: 'nothing was selected in the City Manager' };

        // The Transfers list has to be on screen (it can take a moment to load).
        for (let i = 0; i < 40 && !rowBoxes().length; i++) await pause(250);
        if (!rowBoxes().length) return { ok: false, reason: 'view', message: 'the Hub is not showing its Transfers list' };
        // A dialog left open from before would be in the way.
        if (dialogNow()) {
            const cancelOld = buttonNamed(/^Cancel$/i, dialogNow());
            if (cancelOld) { cancelOld.click(); await pause(300); }
            if (dialogNow()) return { ok: false, reason: 'dialog', message: 'a dialog is open in the Hub — close it first' };
        }

        // Exactly the same selection: what was ticked before is cleared.
        if (rowBoxes().some(function(box) { return box.checked; })) {
            const clear = buttonNamed(/^Clear$/i);
            if (clear) { clear.click(); await pause(250); }
            rowBoxes().filter(function(box) { return box.checked; }).forEach(function(box) { box.click(); });
            await pause(150);
        }

        // The Hub shows the first rows only: "show the rest" until every
        // wanted transfer is there (or nothing more comes).
        const missingNow = function() { return ids.filter(function(id) { return !boxFor(id); }); };
        for (let round = 0; round < 12 && missingNow().length; round++) {
            const more = buttonNamed(/show the rest/i);
            if (!more) break;
            const before = rowBoxes().length;
            more.click();
            for (let i = 0; i < 20 && rowBoxes().length === before; i++) await pause(150);
            if (rowBoxes().length === before) break;
        }

        let first = null;
        for (let i = 0; i < ids.length; i++) {
            const box = boxFor(ids[i]);
            if (!box) continue;
            if (!box.checked) box.click();
            if (!first) first = ids[i];
            // Let the page redraw now and then (it redraws after every tick).
            if (i % 8 === 7) await pause(30);
        }
        await pause(200);
        const missing = ids.filter(function(id) { const box = boxFor(id); return !(box && box.checked); });
        try { const top = first ? boxFor(first) : null; if (top) top.scrollIntoView({ block: 'center' }); } catch (_) {}
        const search = document.querySelector('input[placeholder*="transfer ID"], input[placeholder*="City or transfer"]');
        return {
            ok: true, asked: ids.length, selected: ids.length - missing.length, missing: missing, rows: rowBoxes().length,
            filtered: Boolean(search && String(search.value || '').trim())
        };
    }
    window.__wpHubSelectIds = selectIds;

    // The Hub's own buttons on its "N selected" bar, and the title of the
    // dialog each one opens (Tag has none: the Hub runs it at once).
    const BAR = {
        ask: { button: /Ask best drivers$/i },
        share: { button: /^Share list/i },
        tag: { button: /^Tag$/i, label: 'Tag', instant: true },
        note: { button: /^Add note$/i, label: 'Add note' },
        remove_auto_c: { button: /^Remove Auto-C$/i, label: 'Remove Auto-C' },
        enable_auto_c: { button: /^Enable Auto-C$/i, label: 'Enable Auto-C' },
        broadcast: { button: /^Broadcast$/i, label: 'Broadcast' },
        price_change: { button: /^Price Change$/i, label: 'Price Change' }
    };
    // The Hub's line after a run: "<Label> 12 succeeded, 1 not needed, 2 did
    // not · €34 committed", or "<Label> did not run: …".
    // 1.7.255: the line can be any kind of element (in the Hub's yellow box
    // it is not a <div> of its own), so every short element is looked at.
    const resultNode = function(label) {
        const found = Array.from(document.querySelectorAll('div, p, span, li, h1, h2, h3, h4, h5, h6')).filter(function(node) {
            if (node.closest('[role="dialog"]') || node.closest('table')) return false;
            const value = text(node);
            return value.length < 420 && value.indexOf(label) === 0 && /\bsucceeded\b|did not run/.test(value);
        });
        // The innermost one (the shortest text).
        found.sort(function(a, b) { return text(a).length - text(b).length; });
        return found.length ? found[0] : null;
    };
    const resultBanner = function(label) {
        const node = resultNode(label);
        return node ? text(node) : '';
    };
    // 1.7.255: the rest of the Hub's result box, as in
    //   "Remove Auto-C 82 succeeded, 3 did not"
    //   "2 · not in queue"
    //   "1 · the CRM no longer lists it as unassigned — …"
    //   "Could not be actioned — …   #8677781 · Thessaloniki · in 45h"
    // details: the "N · reason" lines. dropped: the transfers the box lists
    // by number — the Hub takes those out of its selection.
    const resultDetails = function(label) {
        const node = resultNode(label);
        if (!node) return { details: [], dropped: [] };
        let box = node;
        for (let i = 0; i < 6 && box.parentElement; i++) {
            const up = box.parentElement;
            if (up === document.body || up.querySelector('table') || text(up).length > 2600) break;
            box = up;
        }
        const details = [];
        Array.from(box.querySelectorAll('div, p, li, span')).forEach(function(part) {
            const value = text(part);
            if (value.length > 240 || !/^\d+\s*·\s*\S/.test(value)) return;
            const cut = value.length > 150 ? value.slice(0, 149) + '…' : value;
            if (details.indexOf(cut) < 0) details.push(cut);
        });
        const dropped = [];
        (text(box).match(/#\d{6,9}\b/g) || []).forEach(function(match) { const id = match.slice(1); if (dropped.indexOf(id) < 0) dropped.push(id); });
        return { details: details.slice(0, 6), dropped: dropped.slice(0, 80) };
    };
    // 1.7.247: a result the Hub shows in another shape — e.g. a yellow box
    // "34/35 succeeded, 1 was missing" that does not start with the action's
    // name. Every short line outside dialogs and tables that reads like a
    // result.
    const resultOther = function() {
        const seen = {};
        Array.from(document.querySelectorAll('div, p, span, li')).forEach(function(node) {
            if (node.closest('[role="dialog"]') || node.closest('table')) return;
            const value = text(node);
            if (value.length < 8 || value.length > 420) return;
            if (!/\d/.test(value) || !/succe|missing|not found|failed|did not run|no longer/i.test(value)) return;
            if (!/\d+\s*(?:\/|of)\s*\d+|\d+\s+(?:succeeded|failed|missing|not found|were|was)\b/i.test(value)) return;
            seen[value] = true;
        });
        return Object.keys(seen);
    };
    // The shortest result line that was not there before.
    const resultNew = function(beforeList) {
        const fresh = resultOther().filter(function(value) { return beforeList.indexOf(value) < 0; });
        fresh.sort(function(a, b) { return a.length - b.length; });
        return fresh.length ? fresh[0] : '';
    };
    // What the open dialog says it will do: "12 of 14 transfers", the money,
    // and why some are left out.
    const dialogSummary = function(dialog) {
        const all = text(dialog);
        const counts = all.match(/(\d+) of (\d+) transfers?/) || all.match(/(\d+) transfers?/);
        const eligible = counts ? Number(counts[1]) : null;
        const total = counts ? Number(counts[2] || counts[1]) : null;
        const money = (all.match(/\+?[€$£][\d.,]+ committed/) || [])[0] || '';
        const skipped = (all.match(/\d+ skipped · .*?(?=(?:\d+ skipped · )|Nothing to do|Cancel|Type \d+|$)/g) || []).map(function(part) { return part.trim().slice(0, 160); }).slice(0, 4);
        return { eligible: eligible, total: total, money: money, skipped: skipped };
    };

    async function fillDialog(dialog, action, auto) {
        if (action === 'note') {
            const note = String(auto.note || '').trim();
            const box = dialog.querySelector('textarea');
            if (!note) return 'no note text was given';
            if (!box) return 'the note box was not found in the Hub dialog';
            typeInto(box, note);
        }
        if (action === 'price_change') {
            const price = auto.price || {};
            const value = Number(price.value);
            const modes = { pct: /^% of driver cost$/i, add: /^\+ €$/, set: /^Set to €$/i };
            if (!modes[price.mode] || !(value > 0)) return 'no price was given';
            const modeButton = buttonNamed(modes[price.mode], dialog);
            if (!modeButton) return 'the price mode button was not found in the Hub dialog';
            if (modeButton.getAttribute('aria-pressed') !== 'true') { modeButton.click(); await pause(350); }
            if (price.mode === 'pct') {
                const preset = buttonNamed(new RegExp('^\\+' + String(value).replace('.', '\\.') + '%$'), dialog);
                if (preset) preset.click();
                else {
                    const custom = dialog.querySelector('input[aria-label^="Custom uplift percentage"]');
                    if (!custom) return 'the custom % box was not found in the Hub dialog';
                    typeInto(custom, value);
                }
            } else {
                const amount = dialog.querySelector(price.mode === 'add' ? 'input[aria-label^="Amount to add"]' : 'input[aria-label^="New driver cost"]');
                if (!amount) return 'the amount box was not found in the Hub dialog';
                typeInto(amount, value);
            }
        }
        await pause(700);
        return '';
    }

    // Fill the dialog in and press its confirm button ("auto" runs only).
    // dryRun: everything except the last click, then Cancel — for testing.
    async function confirmDialog(action, auto, expected, dryRun) {
        const spec = BAR[action];
        let dialog = null;
        for (let i = 0; i < 24 && !dialog; i++) { dialog = dialogNow(); if (!dialog) await pause(250); }
        const cancel = async function() { const button = dialogNow() ? buttonNamed(/^Cancel$/i, dialogNow()) : null; if (button) { button.click(); await pause(300); } };
        if (!dialog) return { confirmed: false, why: 'the Hub did not open its ' + spec.label + ' dialog' };
        // The dialog's title is its heading (checked on the live Hub,
        // 2026-10-09: an <h3>, no aria-label).
        const title = (dialog.getAttribute('aria-label') || '').trim() || text(dialog.querySelector('h1, h2, h3'));
        if (title !== spec.label) { await cancel(); return { confirmed: false, why: 'the Hub opened a different dialog' }; }
        const problem = await fillDialog(dialog, action, auto || {});
        dialog = dialogNow() || dialog;
        if (problem) { await cancel(); return { confirmed: false, why: problem }; }
        const summary = dialogSummary(dialog);
        const overCap = dialog.querySelector('[data-testid="action-over-cap"]');
        if (overCap) { const why = text(overCap); await cancel(); return { confirmed: false, why: why, summary: summary }; }
        if (summary.total !== null && summary.total !== expected) { await cancel(); return { confirmed: false, why: 'the Hub dialog is about ' + summary.total + ' transfers, not ' + expected, summary: summary }; }
        // Above 25 transfers the Hub wants the count typed.
        const typed = dialog.querySelector('input[aria-label^="Type "][aria-label$=" to confirm"]');
        if (typed) { typeInto(typed, (typed.getAttribute('aria-label').match(/\d+/) || [''])[0]); await pause(350); }
        const buttons = Array.from(dialog.querySelectorAll('button')).filter(function(button) { return text(button) === spec.label; });
        const confirm = buttons[buttons.length - 1];
        if (!confirm) { await cancel(); return { confirmed: false, why: 'the confirm button was not found', summary: summary }; }
        if (confirm.disabled) {
            const nothing = /Nothing to do/.test(text(dialog));
            await cancel();
            return { confirmed: false, why: nothing ? 'nothing to do — every selected transfer is blocked by a Hub guardrail' : 'the Hub kept its confirm button switched off', summary: summary };
        }
        if (dryRun) { await cancel(); return { confirmed: false, dryRun: true, ready: true, summary: summary }; }
        const before = resultBanner(spec.label);
        const beforeOther = resultOther();
        confirm.click();
        // Running: the dialog closes when the Hub is done.
        for (let i = 0; i < 360 && dialogNow(); i++) await pause(250);
        // The Hub's new result line (a line left from an earlier run of the
        // same action is only taken when no new one comes).
        let result = '';
        for (let i = 0; i < 40 && !result; i++) { const now = resultBanner(spec.label); if (now && now !== before) result = now; else { result = resultNew(beforeOther); if (!result) await pause(250); } }
        if (!result) result = resultNew(beforeOther) || resultBanner(spec.label);
        // the box may still be filling in its lines
        await pause(400);
        const more = result && result === resultBanner(spec.label) ? resultDetails(spec.label) : { details: [], dropped: [] };
        return { confirmed: true, summary: summary, result: result, details: more.details, dropped: more.dropped, stillOpen: Boolean(dialogNow()) };
    }

    // After a button is pressed for you to confirm yourself: tell the City
    // Manager how it ended (for its history) — confirmed with the Hub's
    // result line, or cancelled.
    function watchManual(action, runId) {
        const spec = BAR[action];
        if (!spec || !spec.label || !runId) return;
        (async function() {
            const before = resultBanner(spec.label);
            let opened = Boolean(dialogNow());
            for (let i = 0; i < 1200; i++) {
                await pause(500);
                const open = Boolean(dialogNow());
                if (open) { opened = true; continue; }
                if (!opened && i < 6) continue;
                let result = '';
                for (let j = 0; j < 12 && !result; j++) { const now = resultBanner(spec.label); if (now && now !== before) result = now; else await pause(400); }
                try { chrome.runtime.sendMessage({ type: 'WP_HUB_RESULT', runId: runId, result: result || (opened ? 'cancelled in the Hub' : ''), confirmed: Boolean(result) }); } catch (_) {}
                return;
            }
        })();
    }

    async function selectAndPress(rawIds, action, options) {
        options = options || {};
        // keep (the chain, 1.7.254): when exactly these transfers are already
        // ticked from the step before, nothing is cleared and ticked again.
        let kept = null;
        if (options.keep && !dialogNow()) {
            const wanted = Array.from(new Set((rawIds || []).map(function(id) { return String(id).replace(/\D/g, ''); }).filter(Boolean)));
            const ticked = rowBoxes().filter(function(box) { return box.checked; }).map(function(box) { return (String(box.getAttribute('aria-label') || '').match(/(\d+)\s*$/) || [])[1] || ''; });
            if (wanted.length && ticked.length === wanted.length && wanted.every(function(id) { return ticked.indexOf(id) >= 0; })) {
                kept = { ok: true, asked: wanted.length, selected: wanted.length, missing: [], rows: rowBoxes().length, filtered: false, kept: true };
            }
        }
        const result = kept || await selectIds(rawIds);
        if (!action || !result.ok) return result;
        const spec = BAR[action];
        if (!spec) { result.actionError = 'unknown action'; return result; }
        // Only when the Hub's selection is exactly what was asked for.
        if (result.missing.length) { result.actionError = 'not every transfer is in the Hub list, so the action was not opened'; return result; }
        const counter = Array.from(document.querySelectorAll('div, span')).map(function(node) { return node.children.length <= 2 ? text(node).match(/^(\d+) selected$/i) : null; }).filter(Boolean)[0];
        if (!counter || Number(counter[1]) !== result.selected) { result.actionError = 'the Hub shows a different number selected, so the action was not opened'; return result; }
        const button = buttonNamed(spec.button);
        if (!button) { result.actionError = 'that button is not on the Hub\'s bar'; return result; }
        if (button.disabled) { result.actionError = 'that action is switched off in the Hub right now'; return result; }
        const tagBefore = spec.instant ? resultBanner(spec.label) : '';
        button.click();
        await pause(500);
        result.pressed = true;
        if (spec.instant) {
            // Tag: no dialog; its result line, when the Hub shows one.
            for (let i = 0; i < 24 && !result.result; i++) { const now = resultBanner(spec.label); if (now && now !== tagBefore) result.result = now; else await pause(250); }
            if (result.result) { await pause(300); const more = resultDetails(spec.label); result.details = more.details; result.dropped = more.dropped; }
            result.confirmed = true;
            return result;
        }
        if (options.auto && spec.label) {
            const outcome = await confirmDialog(action, options.auto, result.selected, options.dryRun === true);
            Object.assign(result, outcome);
            result.auto = true;
            return result;
        }
        watchManual(action, options.runId);
        return result;
    }
    window.__wpHubSelectAndPress = selectAndPress;

    try {
        chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
            if (!message || message.type !== 'WP_HUB_SELECT_IDS') return;
            selectAndPress(message.ids, String(message.action || ''), { auto: message.auto || null, runId: message.runId || '', keep: message.keep === true })
                .then(sendResponse, function(error) { sendResponse({ ok: false, reason: 'error', message: String(error && error.message || error) }); });
            return true;
        });
    } catch (_) {}
})();
