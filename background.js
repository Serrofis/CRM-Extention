

// ---- WhatsApp Web in the side panel (1.7.282) ----
// WhatsApp refuses to load inside a frame. For the extension's own side
// panel only (requests started by this extension's page, or by the frame
// itself in a non-tab view), the refusal headers are taken off and the
// request looks like a normal page load. Tabs and other sites are not touched.
const WP_WA_BOX_KEY = 'wp_wa_box_alive_v1';
// 1.7.287: the Slack window (its id and where you left it)
const WP_SLACK_WINDOW_KEY = 'wp_slack_window_v1';
// 1.7.288: the Slack window sits where you put it over the side panel —
// kept as its distance from the browser window's right / top / bottom
// edges, so it opens there again and follows when the browser window moves.
function wpSlackRel(win, host) {
    return { fromRight: host.left + host.width - win.left, fromTop: win.top - host.top, width: win.width, fromBottom: host.top + host.height - (win.top + win.height) };
}
function wpSlackBounds(rel, host) {
    return {
        left: Math.round(host.left + host.width - rel.fromRight), top: Math.round(host.top + rel.fromTop),
        width: Math.round(rel.width), height: Math.max(200, Math.round(host.height - rel.fromTop - rel.fromBottom))
    };
}
let wpSlackMovedAt = 0;
chrome.windows.onBoundsChanged.addListener((win) => {
    chrome.storage.local.get(WP_SLACK_WINDOW_KEY, (stored) => {
        const saved = stored[WP_SLACK_WINDOW_KEY];
        if (!saved || !win) return;
        if (win.id === saved.id && Number.isInteger(saved.hostId)) {
            // you moved / resized Slack: remember where, against the browser window
            if (Date.now() - wpSlackMovedAt < 1500) return;
            chrome.windows.get(saved.hostId, (host) => {
                if (chrome.runtime.lastError || !host || host.state === 'minimized') return;
                chrome.storage.local.set({ [WP_SLACK_WINDOW_KEY]: Object.assign({}, saved, { rel: wpSlackRel(win, host) }) });
            });
        } else if (win.id === saved.hostId && saved.rel && Number.isInteger(saved.id) && win.state !== 'minimized') {
            // the browser window moved / resized: Slack goes with it
            wpSlackMovedAt = Date.now();
            chrome.windows.update(saved.id, wpSlackBounds(saved.rel, win), () => void chrome.runtime.lastError);
        }
    });
});function wpWaBoxReady(box) {
    return Boolean(box && box.ready && Date.now() - Number(box.at) < 60000);
}
function wpWaPanelRules() {
    const action = {
        type: 'modifyHeaders',
        requestHeaders: [
            { header: 'sec-fetch-dest', operation: 'set', value: 'document' },
            { header: 'sec-fetch-site', operation: 'set', value: 'none' }
        ],
        responseHeaders: [
            { header: 'x-frame-options', operation: 'remove' },
            { header: 'content-security-policy', operation: 'remove' }
        ]
    };
    try {
        chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [8201, 8202, 8203, 8204],
            addRules: [
                { id: 8201, priority: 1, action: action, condition: { requestDomains: ['web.whatsapp.com'], resourceTypes: ['sub_frame'], initiatorDomains: [chrome.runtime.id] } },
                { id: 8202, priority: 1, action: action, condition: { requestDomains: ['web.whatsapp.com'], resourceTypes: ['sub_frame'], tabIds: [-1] } }
            ]
        }, () => void chrome.runtime.lastError);
    } catch (_) {}
}
wpWaPanelRules();
// The panel page stays connected while it is open: closed → the WhatsApp tab takes over at once.
chrome.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== 'wp-wa-panel') return;
    port.onDisconnect.addListener(() => { chrome.storage.local.set({ [WP_WA_BOX_KEY]: { at: 0, ready: false } }); });
});
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {}); } catch (_) {}

const WP_REFRESH_ALARM_PREFIX = 'wp_transfer_auto_refresh_';

function wpRefreshAlarmName(tabId) {
    return WP_REFRESH_ALARM_PREFIX + String(tabId);
}

async function wpSetBackgroundAutoRefresh(tabId, enabled, intervalSeconds) {
    if (!Number.isInteger(tabId)) return;
    const alarmName = wpRefreshAlarmName(tabId);
    await chrome.alarms.clear(alarmName);
    if (!enabled) return;
    const seconds = Number(intervalSeconds) === 60 ? 60 : 30;
    chrome.alarms.create(alarmName, { delayInMinutes: seconds / 60, periodInMinutes: seconds / 60 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (!alarm || !alarm.name.startsWith(WP_REFRESH_ALARM_PREFIX)) return;
    const tabId = Number(alarm.name.slice(WP_REFRESH_ALARM_PREFIX.length));
    if (!Number.isInteger(tabId)) return;
    try {
        const tab = await chrome.tabs.get(tabId);
        const url = String(tab.url || '');
        if (!url.includes('crm.welcomepickups.com/admin/transfers/') || /\/details_v3(?:[?#]|$)/.test(url)) {
            await chrome.alarms.clear(alarm.name);
            return;
        }
        await chrome.tabs.reload(tabId);
    } catch (_) {
        await chrome.alarms.clear(alarm.name);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.alarms.clear(wpRefreshAlarmName(tabId)).catch(() => {});
});

// Welcome Pickups Transfer Assistant - extension background service worker
'use strict';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === 'WP_AUTO_REFRESH_SET') {
        const tabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
        if (!tabId) { sendResponse({ ok: false }); return; }
        wpSetBackgroundAutoRefresh(tabId, message.enabled === true, message.intervalSeconds).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
        return true;
    }

    if (message.type === 'WP_TRANSFER_ASSISTANT_OPEN_TAB') {
        const createProperties = {
            url: message.url,
            active: message.options?.active === true
        };

        if (message.options?.pinned === true) {
            createProperties.pinned = true;
        }
        if (Number.isFinite(message.options?.index)) {
            createProperties.index = message.options.index;
        }

        chrome.tabs.create(createProperties, (tab) => {
            if (chrome.runtime.lastError || !tab) {
                sendResponse({ ok: false, error: chrome.runtime.lastError?.message || 'Could not open tab.' });
                return;
            }
            sendResponse({ ok: true, tabId: tab.id });
        });

        return true;
    }

    // A workflow tab asking to close itself (e.g. after the 30s A/C
    // re-enable has finished). Only CRM transfer pages can do this, and only
    // for their own tab.
    if (message.type === 'WP_TRANSFER_ASSISTANT_CLOSE_SELF') {
        const tab = sender && sender.tab;
        const url = String((tab && tab.url) || '');
        if (!tab || !Number.isInteger(tab.id) || !url.startsWith('https://crm.welcomepickups.com/admin/transfers/')) {
            sendResponse({ ok: false });
            return;
        }
        chrome.tabs.remove(tab.id, () => {
            sendResponse({ ok: !chrome.runtime.lastError });
        });
        return true;
    }

    if (message.type === 'WP_TRANSFER_ASSISTANT_CLOSE_TAB') {
        if (!Number.isInteger(message.tabId)) {
            sendResponse({ ok: false });
            return;
        }

        chrome.tabs.remove(message.tabId, () => {
            sendResponse({ ok: !chrome.runtime.lastError });
        });

        return true;
    }

    // WhatsApp Web auto-send: queue the job, make sure a WhatsApp Web tab
    // exists (opened in the background if needed) and nudge it.
    if (message.type === 'WP_WA_SEND') {
        const text = String(message.text || '');
        const city = String(message.city || '');
        // 1.7.281: a hero's contact saved / renamed, no message
        const contactOnly = Boolean(message.contactOnly && /^\d{7,15}$/.test(String(message.phone || '')));
        if ((!text && !contactOnly) || !city) {
            sendResponse({ ok: false, error: 'Missing city or text.' });
            return;
        }
        const job = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            city: city,
            text: text,
            label: String(message.label || ''),
            code: /^[A-Za-z0-9]{10,40}$/.test(String(message.code || '')) ? String(message.code) : '',
            image: /^data:image\/(png|jpeg);base64,/.test(String(message.image || '')) ? String(message.image) : '',
            phone: /^\d{7,15}$/.test(String(message.phone || '')) ? String(message.phone) : '',
            contactName: String(message.contactName || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80),
            contactFirst: String(message.contactFirst || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80),
            contactLast: String(message.contactLast || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80),
            contactOnly: contactOnly,
            expect: Array.isArray(message.expect) ? message.expect.map(String).filter(Boolean).slice(0, 6).map((word) => word.slice(0, 40)) : [],
            fromTabId: sender && sender.tab ? sender.tab.id : null,
            createdAt: Date.now()
        };
        chrome.storage.local.get(['wp_wa_jobs_v1', WP_WA_BOX_KEY], (stored) => {
            const jobs = Array.isArray(stored.wp_wa_jobs_v1) ? stored.wp_wa_jobs_v1 : [];
            jobs.push(job);
            chrome.storage.local.set({ wp_wa_jobs_v1: jobs }, () => {
                // 1.7.282: the side panel's WhatsApp is open and logged in → it sends (no tab)
                if (wpWaBoxReady(stored[WP_WA_BOX_KEY])) {
                    chrome.runtime.sendMessage({ type: 'WP_WA_PANEL', msg: { type: 'WP_WA_RUN' } }, () => void chrome.runtime.lastError);
                    sendResponse({ ok: true, jobId: job.id, opened: false, panel: true });
                    return;
                }
                chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, (tabs) => {
                    if (tabs && tabs.length) {
                        const tabId = tabs[0].id;
                        // A WhatsApp tab opened before the extension was
                        // installed/reloaded gets both scripts added first.
                        wpWaSendToTab(tabId, { type: 'WP_WA_RUN' }, '');
                        sendResponse({ ok: true, jobId: job.id, opened: false });
                        return;
                    }
                    chrome.tabs.create({ url: 'https://web.whatsapp.com/', active: false }, () => {
                        sendResponse({ ok: !chrome.runtime.lastError, jobId: job.id, opened: true });
                    });
                });
            });
        });
        return true;
    }

    // Result from the WhatsApp Web tab -> the dashboard tab that asked.
    if (message.type === 'WP_WA_RESULT') {
        if (Number.isInteger(message.fromTabId)) {
            chrome.tabs.sendMessage(message.fromTabId, message, () => void chrome.runtime.lastError);
        }
        sendResponse({ ok: true });
        return;
    }

    // Open a group in WhatsApp Web (existing tab if there is one) instead of
    // the chat.whatsapp.com invite link, which launches the desktop app.
    if (message.type === 'WP_WA_OPEN') {
        const url = String(message.url || '');
        if (!url.startsWith('https://web.whatsapp.com/')) {
            sendResponse({ ok: false });
            return;
        }
        const code = (url.match(/[?&]code=([A-Za-z0-9]{10,40})/) || [])[1] || '';
        chrome.storage.local.get(WP_WA_BOX_KEY, (box) => {
        // 1.7.282: open in the side panel's WhatsApp when it is there
        if (wpWaBoxReady(box[WP_WA_BOX_KEY])) {
            chrome.runtime.sendMessage({ type: 'WP_WA_PANEL', msg: code ? { type: 'WP_WA_SHOW', code: code, city: String(message.city || '').slice(0, 60) } : { type: 'WP_WA_GO', url: url } }, () => void chrome.runtime.lastError);
            sendResponse({ ok: true, panel: true });
            return;
        }
        chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, (tabs) => {
            const tab = tabs && tabs[0];
            if (tab && code) {
                // Group: the WhatsApp tab opens it by name (no reload) when it can.
                wpWaSendToTab(tab.id, { type: 'WP_WA_SHOW', code: code, city: String(message.city || '').slice(0, 60) }, url);
                chrome.tabs.update(tab.id, { active: true }, () => void chrome.runtime.lastError);
                if (Number.isInteger(tab.windowId)) chrome.windows.update(tab.windowId, { focused: true }, () => void chrome.runtime.lastError);
            } else if (tab) {
                // The WhatsApp tab changes its own page (skips "Leave site?").
                wpWaSendToTab(tab.id, { type: 'WP_WA_GO', url: url }, url);
                chrome.tabs.update(tab.id, { active: true }, () => void chrome.runtime.lastError);
                if (Number.isInteger(tab.windowId)) chrome.windows.update(tab.windowId, { focused: true }, () => void chrome.runtime.lastError);
            } else {
                chrome.tabs.create({ url: url, active: true }, () => void chrome.runtime.lastError);
            }
            sendResponse({ ok: true });
        });
        });
        return true;
    }

    // 1.7.287: Slack as its own slim window (no tabs, no address bar) — a
    // page of its own, so Slack shows you and the others as online. The one
    // already open is brought forward; where you leave it is remembered.
    if (message.type === 'WP_SLACK_WINDOW' || message.type === 'WP_SLACK_DOCK') {
        // WP_SLACK_DOCK (1.7.288): the panel was resized — the open Slack window follows, nothing opened
        const dockOnly = message.type === 'WP_SLACK_DOCK';
        chrome.storage.local.get(WP_SLACK_WINDOW_KEY, (stored) => {
            const saved = stored[WP_SLACK_WINDOW_KEY] || {};
            const host = message.host && Number.isInteger(message.host.id) ? message.host : null;
            // 1.7.288: exactly over the side panel, under its button bar — the
            // panel measured itself at your click. Windows draws an invisible
            // 7 px border around a window, so the bounds go that much wider.
            const g = message.panel || {};
            const edge = /Windows/.test(navigator.userAgent) ? 7 : 0;
            let bounds = { width: 520, height: 900 };
            if ([g.left, g.top, g.width, g.height, g.bar].every((value) => Number.isFinite(Number(value))) && Number(g.width) > 200) {
                bounds = {
                    left: Math.round(Number(g.left) - edge), top: Math.round(Number(g.top) + Number(g.bar)),
                    width: Math.round(Number(g.width) + 2 * edge), height: Math.round(Number(g.height) - Number(g.bar) + edge)
                };
            }
            const rel = host && bounds.left !== undefined ? wpSlackRel(bounds, host) : (saved.rel || null);
            const keep = (id) => chrome.storage.local.set({ [WP_SLACK_WINDOW_KEY]: { id: id, hostId: host ? host.id : saved.hostId, rel: rel } });
            const open = () => {
                wpSlackMovedAt = Date.now();
                chrome.windows.create(Object.assign({ url: 'https://app.slack.com/client', type: 'popup', focused: true }, bounds), (win) => {
                    if (chrome.runtime.lastError || !win) { sendResponse({ ok: false }); return; }
                    keep(win.id);
                    try { const tab = win.tabs && win.tabs[0]; if (tab) chrome.tabs.setZoomSettings(tab.id, { scope: 'per-tab' }, () => { void chrome.runtime.lastError; chrome.tabs.setZoom(tab.id, 0.8, () => void chrome.runtime.lastError); }); } catch (_) {}
                    sendResponse({ ok: true });
                });
            };
            if (dockOnly && !Number.isInteger(saved.id)) { sendResponse({ ok: false }); return; }
            if (Number.isInteger(saved.id)) {
                // already open: to the front, in its place
                wpSlackMovedAt = Date.now();
                chrome.windows.update(saved.id, Object.assign(dockOnly ? {} : { focused: true, state: 'normal' }, bounds.left !== undefined ? bounds : {}), (win) => {
                    if (chrome.runtime.lastError || !win) { if (dockOnly) sendResponse({ ok: false }); else open(); return; }
                    keep(win.id);
                    sendResponse({ ok: true });
                });
            } else open();
        });
        return true;
    }

    // 1.7.282: open WhatsApp in Chrome's side panel (a click in the CRM / the popup).
    if (message.type === 'WP_WA_PANEL_OPEN') {
        const windowId = sender && sender.tab && Number.isInteger(sender.tab.windowId) ? sender.tab.windowId : Number(message.windowId);
        if (!chrome.sidePanel || !Number.isInteger(windowId)) { sendResponse({ ok: false, error: 'no side panel in this browser' }); return; }
        chrome.sidePanel.open({ windowId: windowId }).then(() => sendResponse({ ok: true }), (error) => sendResponse({ ok: false, error: String(error && error.message || error) }));
        return true;
    }

    // Local AI reader (1.7.202): the model server on this PC only
    // (localhost / 127.0.0.1) — never any other address.
    if (message.type === 'WP_AI_MODELS' || message.type === 'WP_AI_ASK') {
        const base = String(message.url || '').replace(/\/+$/, '');
        if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d{2,5})?$/.test(base)) {
            sendResponse({ ok: false, error: 'only a server on this PC is allowed (http://localhost:port)' });
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), message.type === 'WP_AI_ASK' ? 45000 : 8000);
        const startedAt = Date.now();
        const request = message.type === 'WP_AI_MODELS'
            ? fetch(base + '/v1/models', { signal: controller.signal })
                .then((response) => response.ok ? response.json() : Promise.reject(new Error(response.status === 403 ? 'the model server refused the browser extension (HTTP 403) — Ollama needs OLLAMA_ORIGINS to allow chrome-extension://*' : 'HTTP ' + response.status)))
                .then((json) => ({ ok: true, models: (json && json.data || []).map((item) => String(item.id || '')).filter(Boolean) }))
            : (() => {
                // reasoning_effort "none": no hidden thinking (a small model
                // otherwise spends its whole answer on it and returns nothing).
                const ask = (withEffort) => fetch(base + '/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: controller.signal,
                    body: JSON.stringify(Object.assign({
                        model: String(message.model || ''),
                        messages: Array.isArray(message.messages) ? message.messages.slice(0, 4) : [],
                        temperature: 0,
                        max_tokens: 500,
                        stream: false
                    }, withEffort ? { reasoning_effort: 'none' } : {}))
                });
                // A server that does not know the option (HTTP 400): once more without it.
                return ask(true).then((response) => response.status === 400 ? ask(false) : response);
            })()
                .then((response) => response.ok ? response.json() : response.text().then((text) => Promise.reject(new Error(response.status === 403 ? 'the model server refused the browser extension (HTTP 403) — Ollama needs OLLAMA_ORIGINS to allow chrome-extension://*' : 'HTTP ' + response.status + ' ' + text.slice(0, 120)))))
                .then((json) => {
                    const choice = json && json.choices && json.choices[0];
                    const text = choice && choice.message ? String(choice.message.content || '') : '';
                    return text ? { ok: true, text: text, ms: Date.now() - startedAt } : { ok: false, error: 'empty answer' };
                });
        request
            .catch((error) => ({ ok: false, error: error && error.name === 'AbortError' ? 'timed out' : String(error && error.message || error) }))
            .then((result) => { clearTimeout(timer); sendResponse(result); });
        return true;
    }
    // Phone app (1.7.212): the relay that carries mod's open
    // question to the phone and the tapped answer back. Only a Cloudflare
    // Worker address (https://….workers.dev) or, since 1.7.268, a relay you host
    // yourself behind Tailscale Funnel (https://….ts.net, with an optional port),
    // and only these calls.
    if (message.type === 'WP_REMOTE') {
        const base = String(message.url || '').replace(/\/+$/, '');
        const path = String(message.path || '');
        const key = String(message.key || '');
        if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(workers\.dev|ts\.net)(:\d{2,5})?$/.test(base) || ['/api/claim', '/api/pair-code', '/api/unpair', '/api/sync', '/api/settings'].indexOf(path) < 0 || !/^[A-Za-z0-9_-]{32,200}$/.test(key)) {
            sendResponse({ ok: false, error: 'the relay address or key is not valid' });
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        fetch(base + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
            signal: controller.signal,
            body: JSON.stringify(message.body && typeof message.body === 'object' ? message.body : {})
        })
            .then((response) => response.json().catch(() => ({})).then((data) => {
                const result = data && typeof data === 'object' ? data : {};
                result.ok = response.ok && result.ok !== false;
                if (!result.ok && !result.error) result.error = 'HTTP ' + response.status;
                return result;
            }))
            .catch((error) => ({ ok: false, error: error && error.name === 'AbortError' ? 'timed out' : 'could not reach the relay' }))
            .then((result) => { clearTimeout(timer); sendResponse(result); });
        return true;
    }
    // City Manager → "Select in Ops Hub" (1.7.222): tick the same transfers
    // in the Hub's Live Ops list. Done in the Hub tab by wp-hub.js.
    if (message.type === 'WP_HUB_SELECT') {
        wpHubSelect(message.ids, message.action, { auto: message.auto || null, quiet: message.quiet === true, runId: message.runId || '', keep: message.keep === true }, sender && sender.tab ? sender.tab.id : null)
            .catch((error) => ({ ok: false, reason: 'error', message: String(error && error.message || error) }))
            .then(sendResponse);
        return true;
    }
    // A wait for the Hub helper while its tab is hidden (1.7.224): Chrome
    // slows a hidden tab's own timers down to once a minute.
    if (message.type === 'WP_HUB_SLEEP') {
        setTimeout(() => sendResponse({ ok: true }), Math.max(0, Math.min(5000, Number(message.ms) || 0)));
        return true;
    }
    // How a Hub dialog you confirmed yourself ended: passed on to the CRM
    // tab that opened it, for the City Manager's Hub history.
    if (message.type === 'WP_HUB_RESULT') {
        const runId = String(message.runId || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
        if (runId) {
            const key = 'wp_hub_run_' + runId;
            chrome.storage.session.get(key).then((stored) => {
                const tabId = stored && stored[key];
                if (Number.isInteger(tabId)) chrome.tabs.sendMessage(tabId, { type: 'WP_HUB_RESULT', runId: runId, result: String(message.result || '').slice(0, 400), confirmed: message.confirmed === true }).catch(() => {});
                chrome.storage.session.remove(key).catch(() => {});
            }).catch(() => {});
        }
        sendResponse({ ok: true });
        return;
    }
    // 1.7.266: the dashboard tab keeps working in the background — Chrome may not throw it away to save memory.
    if (message.type === 'WP_KEEP_TAB') {
        const tab = sender && sender.tab;
        if (tab && Number.isInteger(tab.id)) {
            try { chrome.tabs.update(tab.id, { autoDiscardable: false }, () => void chrome.runtime.lastError); } catch (_) {}
        }
        sendResponse({ ok: true });
        return;
    }
    // 1.7.266: the EM Project sheet from Google Sheets / Drive as CSV, read with this Chrome's own Google sign-in.
    if (message.type === 'WP_EMP_FETCH') {
        let target = null;
        try { target = new URL(String(message.url || '')); } catch (_) {}
        if (!target || target.protocol !== 'https:' || !/^(docs|drive)\.google\.com$/.test(target.hostname)) {
            sendResponse({ ok: false, error: 'only a docs.google.com / drive.google.com link' });
            return;
        }
        fetch(target.toString(), { credentials: 'include', redirect: 'follow', cache: 'no-store' })
            .then((response) => response.text().then((text) => ({ status: response.status, type: response.headers.get('content-type') || '', text: text })))
            .then((result) => {
                if (result.status === 401 || result.status === 403 || result.status === 404) sendResponse({ ok: false, error: 'Google said ' + result.status + ' — is this Chrome signed in to the Google account that can open the file?' });
                else if (result.status !== 200) sendResponse({ ok: false, error: 'HTTP ' + result.status });
                else if (!message.html && (/html/i.test(result.type) || /^\s*</.test(result.text))) sendResponse({ ok: false, error: 'Google answered with a page, not the sheet — open the link once in this Chrome (signed in) and check that the file opens' });
                else sendResponse({ ok: true, text: result.text.slice(0, 5000000) });
            }, (error) => sendResponse({ ok: false, error: String(error && error.message || error) }));
        return true;
    }
    // mod / Autopilot sound (1.7.179): played by the offscreen page.
    if (message.type === 'WP_PLAY_SOUND') {
        wpPlaySound(message.kind === 'urgent' ? 'urgent' : 'found');
        sendResponse({ ok: true });
        return;
    }
    // The WhatsApp Web tab needs the user (group chooser): bring it forward.
    if (message.type === 'WP_WA_FOCUS') {
        const tab = sender && sender.tab;
        if (tab && Number.isInteger(tab.id) && String(tab.url || '').startsWith('https://web.whatsapp.com/')) {
            chrome.tabs.update(tab.id, { active: true });
            if (Number.isInteger(tab.windowId)) chrome.windows.update(tab.windowId, { focused: true });
        }
        sendResponse({ ok: true });
        return;
    }});

// ---- Ops Intelligence Hub (1.7.222) ----
// The Hub tab that is already open is used (its Live Ops page first); when
// there is none, the Transfers list is opened in a new tab. The tab is
// brought to the front afterwards, so you see what got ticked.
const WP_HUB_ORIGIN = 'https://ops-intelligence-hub.vercel.app';
const WP_HUB_LIST_URL = WP_HUB_ORIGIN + '/crm/live-ops?mode=transfers&window=all&lens=queue&optime=t0_24%2Ct24_48';
const wpHubWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function wpHubTabLoaded(tabId) {
    for (let i = 0; i < 80; i++) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) return false;
        if (tab.status === 'complete') return true;
        await wpHubWait(250);
    }
    return true;
}
// Ask the tab; its helper is added first when it is not there yet (a Hub tab
// opened before the extension was loaded or updated).
async function wpHubAsk(tabId, ids, action, extra) {
    const message = Object.assign({ type: 'WP_HUB_SELECT_IDS', ids: ids, action: action }, extra || {});
    for (let attempt = 0; attempt < 4; attempt++) {
        let noHelper = false;
        try {
            const answer = await chrome.tabs.sendMessage(tabId, message);
            if (answer) return answer;
            noHelper = true;
        } catch (error) {
            // Asked again ONLY when nothing in the tab was there to hear it.
            // Anything else may mean the work already started (1.7.224: an
            // action must never be run twice).
            noHelper = /Receiving end does not exist|Could not establish connection/i.test(String(error && error.message || error));
            if (!noHelper) return { ok: false, reason: 'lost', message: 'the Hub tab stopped answering part-way — check the Hub before trying again' };
        }
        if (!noHelper) break;
        try { await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['wp-hub.js'] }); } catch (_) {}
        await wpHubWait(700);
    }
    return { ok: false, reason: 'unreachable', message: 'the Hub tab did not answer' };
}
async function wpHubSelect(rawIds, rawAction, options, senderTabId) {
    options = options || {};
    // One of the Hub bar's buttons, or '' for "select only".
    const action = ['ask', 'share', 'tag', 'note', 'remove_auto_c', 'enable_auto_c', 'broadcast', 'price_change'].indexOf(String(rawAction || '')) >= 0 ? String(rawAction) : '';
    // auto (phone app): the Hub's dialog is filled in and confirmed there.
    // Only for the actions with a plain dialog; never Ask / Share.
    let auto = null;
    if (options.auto && ['note', 'remove_auto_c', 'enable_auto_c', 'broadcast', 'price_change'].indexOf(action) >= 0) {
        const price = options.auto.price && typeof options.auto.price === 'object' ? options.auto.price : null;
        auto = {
            note: String(options.auto.note || '').replace(/\s+/g, ' ').trim().slice(0, 280),
            price: price && ['pct', 'add', 'set'].indexOf(price.mode) >= 0 && Number(price.value) > 0 ? { mode: price.mode, value: Math.round(Number(price.value) * 10) / 10 } : null
        };
    }
    const quiet = options.quiet === true;
    const runId = String(options.runId || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
    if (runId && Number.isInteger(senderTabId)) {
        try { await chrome.storage.session.set({ ['wp_hub_run_' + runId]: senderTabId }); } catch (_) {}
    }
    // keep (the chain, 1.7.254): the Hub's selection from the step before is used as it is
    const extra = { auto: auto, runId: runId, keep: options.keep === true };
    const ids = Array.from(new Set((Array.isArray(rawIds) ? rawIds : []).map((id) => String(id).replace(/\D/g, '')).filter(Boolean))).slice(0, 500);
    if (!ids.length) return { ok: false, reason: 'nothing', message: 'nothing was selected' };
    const tabs = await chrome.tabs.query({ url: WP_HUB_ORIGIN + '/*' });
    let tab = tabs.find((item) => /\/crm\/live-ops/.test(String(item.url || '')) && /mode=transfers/.test(String(item.url || ''))) ||
        tabs.find((item) => /\/crm\/live-ops/.test(String(item.url || ''))) || tabs[0] || null;
    let opened = false;
    if (!tab) {
        // quiet (phone app): opened behind the CRM tab, which has to stay in
        // front (Chrome slows hidden tabs down).
        tab = await chrome.tabs.create({ url: WP_HUB_LIST_URL, active: !quiet });
        opened = true;
        await wpHubTabLoaded(tab.id);
        await wpHubWait(1500);
    }
    let answer = await wpHubAsk(tab.id, ids, action, extra);
    // The Hub tab was on another page: its Transfers list is opened once.
    if (answer && answer.reason === 'view' && !opened) {
        await chrome.tabs.update(tab.id, { url: WP_HUB_LIST_URL });
        await wpHubWait(600);
        await wpHubTabLoaded(tab.id);
        await wpHubWait(1500);
        answer = await wpHubAsk(tab.id, ids, action, extra);
        if (answer) answer.navigated = true;
    }
    if (!quiet) {
        try {
            await chrome.tabs.update(tab.id, { active: true });
            if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
        } catch (_) {}
    }
    if (answer) answer.opened = opened;
    return answer;
}

// ---- WhatsApp Web tab helpers (1.7.154) ----
// Add both extension scripts to a WhatsApp tab: the page-world one that
// skips "Leave site?" for the extension's own page changes, then the
// sender. Needed for tabs opened before the extension was installed or
// updated (Chrome only adds content scripts to pages loaded afterwards).
function wpWaEnsureScripts(tabId, done) {
    chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['wp-whatsapp-main.js'], world: 'MAIN' }, () => {
        void chrome.runtime.lastError;
        chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['wp-whatsapp.js'] }, () => {
            void chrome.runtime.lastError;
            if (done) done();
        });
    });
}

// Message the WhatsApp tab; if nothing answers, add the scripts and try
// again. Only if that fails too is the page changed from here.
function wpWaSendToTab(tabId, message, fallbackUrl) {
    chrome.tabs.sendMessage(tabId, message, () => {
        if (!chrome.runtime.lastError) return;
        wpWaEnsureScripts(tabId, () => {
            setTimeout(() => {
                chrome.tabs.sendMessage(tabId, message, () => {
                    if (chrome.runtime.lastError && fallbackUrl) {
                        chrome.tabs.update(tabId, { url: fallbackUrl }, () => void chrome.runtime.lastError);
                    }
                });
            }, 400);
        });
    });
}

// Installed / updated: WhatsApp tabs that are already open get the scripts now.
chrome.runtime.onInstalled.addListener(() => {
    chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, (tabs) => {
        (tabs || []).forEach((tab) => wpWaEnsureScripts(tab.id));
    });
});

// ---- Alert sounds (1.7.179) ----
async function wpPlaySound(kind) {
    try {
        const has = chrome.runtime.getContexts
            ? (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0
            : false;
        if (!has) {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['AUDIO_PLAYBACK'],
                justification: 'mod / Autopilot alert sound'
            });
        }
    } catch (_) {}
    chrome.runtime.sendMessage({ type: 'WP_OFFSCREEN_SOUND', kind: kind }, () => void chrome.runtime.lastError);
}
