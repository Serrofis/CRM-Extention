// 1.7.512: the build of THIS background.js; bump it with the manifest version on every build (wa-panel.js reloads wlcm when it differs)
const WP_BG_BUILD = '1.7.547';

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
// 1.7.386: WhatsApp opens in the side panel, never in a new tab. Chrome opens a panel
// only right after a click, so it is asked at once (before anything async); when it
// says no: a WhatsApp tab that is already open, else the tab that asked shows a
// one-click "Open WhatsApp panel" (the job waits in the queue).
function wpWaTryPanel(message, sender) {
    try {
        const windowId = sender && sender.tab && Number.isInteger(sender.tab.windowId) ? sender.tab.windowId : Number(message.windowId);
        if (!chrome.sidePanel || !Number.isInteger(windowId)) return Promise.resolve(false);
        return chrome.sidePanel.open({ windowId: windowId }).then(() => true, () => false);
    } catch (_) { return Promise.resolve(false); }
}
const wpWaKickAt = {}; // 1.7.465: windowId → last corner click
function wpWaAskForPanel(sender) {
    const tabId = sender && sender.tab && sender.tab.id;
    if (Number.isInteger(tabId)) chrome.tabs.sendMessage(tabId, { type: 'WP_WA_NEED_PANEL' }, () => void chrome.runtime.lastError);
}
// A message for the panel once it is up (it needs a moment to load and log in).
function wpWaDeliverToPanel(msg) {
    const startedAt = Date.now();
    const look = () => {
        chrome.storage.local.get(WP_WA_BOX_KEY, (box) => {
            if (wpWaBoxReady(box[WP_WA_BOX_KEY])) {
                chrome.runtime.sendMessage({ type: 'WP_WA_PANEL', msg: msg }, () => void chrome.runtime.lastError);
            } else if (Date.now() - startedAt < 45000) {
                setTimeout(look, 1000);
            }
        });
    };
    look();
}
// Any WhatsApp link → the address WhatsApp Web uses.
function wpWaWebUrl(url) {
    const text = String(url || '');
    const code = (text.match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]+)/) || [])[1];
    if (code) return 'https://web.whatsapp.com/accept?code=' + code;
    const phone = (text.match(/[?&]phone=\+?(\d+)/) || text.match(/wa\.me\/\+?(\d+)/) || [])[1];
    if (/whatsapp\.com|wa\.me/.test(text) && phone) return 'https://web.whatsapp.com/send?phone=' + phone;
    return /^https:\/\/web\.whatsapp\.com\//.test(text) ? text : '';
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

// 1.7.419: the newest on/off of a tab wins. An "on" still being handled when an
// "off" came in (a wlcm round ending just as you switched the refresh off) used to
// set the timer again after the off, and the page kept reloading every minute.
const wpRefreshSetVersion = {};
async function wpSetBackgroundAutoRefresh(tabId, enabled, intervalSeconds) {
    if (!Number.isInteger(tabId)) return;
    const version = (wpRefreshSetVersion[tabId] || 0) + 1;
    wpRefreshSetVersion[tabId] = version;
    const alarmName = wpRefreshAlarmName(tabId);
    await chrome.alarms.clear(alarmName);
    if (!enabled || wpRefreshSetVersion[tabId] !== version) return;
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
        // 1.7.419: the page decides: its refresh switched off (or held) = no reload, timer gone
        const answer = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 2500);
            try {
                chrome.tabs.sendMessage(tabId, { type: 'WP_AUTO_REFRESH_ASK' }, (reply) => { clearTimeout(timer); void chrome.runtime.lastError; resolve(reply || null); });
            } catch (_) { clearTimeout(timer); resolve(null); }
        });
        if (answer && answer.enabled === false) { await chrome.alarms.clear(alarm.name); return; }
        if (answer && answer.held) return;
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

// 1.7.386: open a chat or a group: the side panel; a WhatsApp tab only if one is already open.
function wpWaOpenChat(target, sender, sendResponse) {
    const panelTry = wpWaTryPanel({}, sender);
    const url = target.url;
    const code = (url.match(/[?&]code=([A-Za-z0-9]{10,40})/) || [])[1] || '';
    const msg = code ? { type: 'WP_WA_SHOW', code: code, city: String(target.city || '').slice(0, 60) } : { type: 'WP_WA_GO', url: url };
    chrome.storage.local.get(WP_WA_BOX_KEY, (box) => {
        if (wpWaBoxReady(box[WP_WA_BOX_KEY])) {
            chrome.runtime.sendMessage({ type: 'WP_WA_PANEL', msg: msg }, () => void chrome.runtime.lastError);
            sendResponse({ ok: true, panel: true });
            return;
        }
        panelTry.then((opened) => {
            if (opened) {
                wpWaDeliverToPanel(msg);
                sendResponse({ ok: true, panel: true });
                return;
            }
            chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, (tabs) => {
                const tab = tabs && tabs[0];
                if (tab) {
                    wpWaSendToTab(tab.id, msg, url);
                    chrome.tabs.update(tab.id, { active: true }, () => void chrome.runtime.lastError);
                    if (Number.isInteger(tab.windowId)) chrome.windows.update(tab.windowId, { focused: true }, () => void chrome.runtime.lastError);
                    sendResponse({ ok: true });
                    return;
                }
                // no tab is made: this waits for the click on "Open WhatsApp panel"
                chrome.storage.local.set({ wp_wa_open_pending_v1: { msg: msg, at: Date.now() } }, () => void chrome.runtime.lastError);
                wpWaAskForPanel(sender);
                sendResponse({ ok: true, needPanel: true });
            });
        });
    });
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;
    // 1.7.511: which background code runs (the box seemed to run an older one) and whether it has chrome.cookies
    // 1.7.524: the Ops Hub's "signed out / back in" for the app (wp-signin.js on the Hub has no relay settings;
    // a CRM page stored them in wp_signin_relay_v1)
    // 1.7.530: a Hub job for the relay (it works the Ops Hub itself): create it, then wait for its result (at most 4 min)
    if (message.type === 'WP_RELAY_JOB') {
        (async () => {
            const got = await chrome.storage.local.get('wp_signin_relay_v1');
            const cfg = got && got.wp_signin_relay_v1;
            const base = String(cfg && cfg.url || '').replace(/\/+$/, '');
            if (!cfg || !cfg.key || !/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(workers\.dev|ts\.net|eserris\.com)(:\d{2,5})?$/.test(base)) return { ok: false, error: 'no relay settings on this machine' };
            const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(cfg.key) };
            const made = await fetch(base + '/api/pcjobs', { method: 'POST', headers: headers, body: JSON.stringify(message.job || {}) });
            const madeData = await made.json().catch(() => ({}));
            if (!made.ok || !madeData.job) return { ok: false, error: madeData.error || ('HTTP ' + made.status) };
            const id = madeData.job.id;
            const until = Date.now() + 240000;
            while (Date.now() < until) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                const r = await fetch(base + '/api/pcjobs?id=' + encodeURIComponent(id), { headers: headers }).catch(() => null);
                const data = r ? await r.json().catch(() => ({})) : {};
                const job = data && data.job;
                if (job && (job.state === 'done' || job.state === 'failed')) return { ok: true, job: job };
            }
            return { ok: false, error: 'the relay job did not finish in 4 min' };
        })().catch((error) => ({ ok: false, error: String(error && error.message || error) })).then(sendResponse);
        return true;
    }
    // 1.7.538: the box's Slack tab (wp-slack.js) -> the relay /api/slack (the tablet's Chats tab); the answer carries
    // the tablet's Slack commands (open / reply) and the picked channels
    if (message.type === 'WP_SLACK_SYNC') {
        (async () => {
            const got = await chrome.storage.local.get('wp_signin_relay_v1');
            const cfg = got && got.wp_signin_relay_v1;
            const base = String(cfg && cfg.url || '').replace(/\/+$/, '');
            if (!cfg || !cfg.key || !/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(workers\.dev|ts\.net|eserris\.com)(:\d{2,5})?$/.test(base)) return { ok: false, error: 'no relay settings on this machine' };
            const r = await fetch(base + '/api/slack', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(cfg.key) }, body: JSON.stringify(Object.assign({ main: true }, message.body || {})) });
            const data = await r.json().catch(() => ({}));
            return r.ok ? data : { ok: false, error: data.error || ('HTTP ' + r.status) };
        })().catch((error) => ({ ok: false, error: String(error && error.message || error) })).then(sendResponse);
        return true;
    }
    // 1.7.538: a Slack web API call for wp-slack.js when the page's own request is blocked (CORS); only from a Slack tab
    if (message.type === 'WP_SLACK_API') {
        const from = String(sender && (sender.url || (sender.tab && sender.tab.url)) || '');
        const url = String(message.url || '');
        if (!/^https:\/\/([a-z0-9-]+\.)*slack\.com\//.test(from) || !/^https:\/\/[a-z0-9-]+(\.enterprise)?\.slack\.com\/api\/[a-zA-Z.]+$/.test(url)) { sendResponse({ ok: false, error: 'not allowed' }); return; }
        (async () => {
            const form = new FormData();
            Object.keys(message.form || {}).forEach((k) => form.append(k, String(message.form[k])));
            const r = await fetch(url, { method: 'POST', body: form, credentials: 'include' });
            return await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
        })().catch((error) => ({ ok: false, error: String(error && error.message || error) })).then(sendResponse);
        return true;
    }
    if (message.type === 'WP_HUB_SESSION_PAGE') { // 1.7.529
        wpHubSessionFromPage(message.cookie, message.count).catch((e) => wpHubSessionNote('error: ' + (e && e.message || e)));
        sendResponse({ ok: true });
        return;
    }
    if (message.type === 'WP_SIGNIN_TELL') {
        const body = message.body || {};
        const hub = body.hub === 'out' || body.hub === 'ok' ? body.hub : '';
        if (hub) {
            chrome.storage.local.get('wp_signin_relay_v1').then((got) => {
                const cfg = got && got.wp_signin_relay_v1;
                const base = String(cfg && cfg.url || '').replace(/\/+$/, '');
                if (!cfg || !cfg.key || !/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(workers\.dev|ts\.net|eserris\.com)(:\d{2,5})?$/.test(base)) return;
                return fetch(base + '/api/boxinfo', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(cfg.key) }, body: JSON.stringify({ main: body.main === true, hub: hub }) });
            }).catch(() => {});
        }
        sendResponse({ ok: true });
        return;
    }
    if (message.type === 'WP_BG_PING') {
        let version = '?';
        try { version = chrome.runtime.getManifest().version; } catch (_) {}
        sendResponse({ ok: true, v: version, code: WP_BG_BUILD, cookies: typeof chrome.cookies });
        return;
    }

    if (message.type === 'WP_AUTO_REFRESH_SET') {
        const tabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
        if (!tabId) { sendResponse({ ok: false }); return; }
        wpSetBackgroundAutoRefresh(tabId, message.enabled === true, message.intervalSeconds).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
        return true;
    }

    // 1.7.317: the phone's "Refresh CRM". Reloads the CRM tabs, the asking
    // tab last. Single transfer pages are left alone: they can be in the
    // middle of an edit or a mod workflow.
    if (message.type === 'WP_RELOAD_CRM_TABS') {
        const own = sender && sender.tab ? sender.tab.id : null;
        chrome.tabs.query({ url: 'https://crm.welcomepickups.com/*' }).then(async (tabs) => {
            const list = tabs.filter((tab) => !/\/admin\/transfers\/\d+/.test(String(tab.url || '')));
            list.sort((a, b) => (a.id === own) - (b.id === own));
            for (const tab of list) { try { await chrome.tabs.reload(tab.id); } catch (_) {} }
            sendResponse({ ok: true, count: list.length });
        }).catch(() => sendResponse({ ok: false }));
        return true;
    }

    if (message.type === 'WP_TRANSFER_ASSISTANT_OPEN_TAB') {
        // 1.7.386: a WhatsApp address goes to the side panel, not a new tab
        if (/^https?:\/\/(?:[a-z]+\.)?(?:whatsapp\.com|wa\.me)\//i.test(String(message.url || ''))) {
            wpWaOpenChat({ url: wpWaWebUrl(message.url) || 'https://web.whatsapp.com/', city: '' }, sender, sendResponse);
            return true;
        }
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
        // 1.7.367: also the drivers list tab of a phone "message all drivers" job
        const driversJob = url.startsWith('https://crm.welcomepickups.com/admin/drivers?') && /[?&]wp_send_all=/.test(url);
        if (!tab || !Number.isInteger(tab.id) || !(url.startsWith('https://crm.welcomepickups.com/admin/transfers/') || driversJob)) {
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
        const panelTry = wpWaTryPanel(message, sender); // 1.7.386: at once, while the click still counts
        const text = String(message.text || '');
        const city = String(message.city || '');
        // 1.7.281: a hero's contact saved / renamed, no message
        const contactOnly = Boolean(message.contactOnly && /^\d{7,15}$/.test(String(message.phone || '')));
        // 1.7.365: a picture alone is a message too
        if ((!text && !contactOnly && !/^data:image\/(png|jpeg);base64,/.test(String(message.image || ''))) || !city) {
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
            read: Boolean(message.read), // 1.7.440: read the chat for the phone, send nothing
            chat: Boolean(message.chat), // 1.7.440: a reply to one chat (group or not), matched by its exact title
            contactKeep: Boolean(message.contactKeep), // 1.7.365: a saved contact keeps its name
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
                // 1.7.464: answered at once (the CRM tab used to wait for the side panel's open, which
                // could hang a send run for good); side panel only — a WhatsApp tab never sends.
                // The panel takes the waiting jobs as soon as it has loaded.
                sendResponse({ ok: true, jobId: job.id, opened: false, panel: true });
                panelTry.then((opened) => { if (!opened) wpWaAskForPanel(sender); }, () => wpWaAskForPanel(sender));
            });
        });
        return true;
    }

    // Result from the WhatsApp Web tab -> the dashboard tab that asked.
    if (message.type === 'WP_WA_RESULT') {
        if (Number.isInteger(message.fromTabId)) {
            chrome.tabs.sendMessage(message.fromTabId, message, () => void chrome.runtime.lastError);
        }
        // 1.7.437: the end of every send also to the CRM tabs (wlcm activity / phone): no message text
        if (!message.progress) {
            const note = { type: 'WP_WA_LOG', jobId: String(message.jobId || ''), label: String(message.label || ''), city: String(message.city || ''), ok: Boolean(message.ok), info: message.ok ? '' : String(message.info || '') };
            try { chrome.tabs.query({ url: ['https://crm.welcomepickups.com/*', 'https://*.ts.net/*'] }, (tabs) => { (tabs || []).forEach((tab) => chrome.tabs.sendMessage(tab.id, note, () => void chrome.runtime.lastError)); }); } catch (_) {}
        }
        sendResponse({ ok: true });
        return;
    }

    // Open a group in WhatsApp Web (existing tab if there is one) instead of
    // the chat.whatsapp.com invite link, which launches the desktop app.
    if (message.type === 'WP_WA_OPEN') {
        const url = wpWaWebUrl(message.url);
        if (!url) {
            sendResponse({ ok: false });
            return;
        }
        wpWaOpenChat({ url: url, city: String(message.city || '') }, sender, sendResponse);
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

    // 1.7.423: Open on a mention / direct-message card: the side panel, then that chat.
    if (message.type === 'WP_WA_ALERT_OPEN') {
        const title = String(message.title || '').slice(0, 80);
        const windowId = sender && sender.tab && Number.isInteger(sender.tab.windowId) ? sender.tab.windowId : NaN;
        const deliver = () => { if (title) wpWaDeliverToPanel({ type: 'WP_WA_OPEN_TITLE', title: title }); };
        if (!chrome.sidePanel || !Number.isInteger(windowId)) { deliver(); sendResponse({ ok: false }); return; }
        chrome.sidePanel.open({ windowId: windowId }).then(() => { deliver(); sendResponse({ ok: true }); }, () => { deliver(); sendResponse({ ok: false }); });
        return true;
    }
    // 1.7.473: "open in CRM" from a transfer in the WhatsApp side panel — only a CRM transfer page
    if (message.type === 'WP_OPEN_CRM') {
        const path = String(message.path || '');
        if (!/^\/admin\/transfers\/\d+(?:\/[a-z0-9_]+)?$/i.test(path)) { sendResponse({ ok: false }); return; }
        const create = (windowId) => chrome.tabs.create(Object.assign({ url: 'https://crm.welcomepickups.com' + path, active: true }, Number.isInteger(windowId) ? { windowId: windowId } : {}), () => { void chrome.runtime.lastError; sendResponse({ ok: true }); });
        chrome.windows.getLastFocused({ windowTypes: ['normal'] }, (win) => { void chrome.runtime.lastError; create(win && win.id); });
        return true;
    }
    // 1.7.465: a CRM tab asks for one click on its see-through corner spot (content.js wpWaPanelKick):
    // Chrome counts it as a real click, so the tab's own WP_WA_PANEL_OPEN may open the side panel.
    // Once per window every 2 min, only while the panel is not up.
    if (message.type === 'WP_WA_PANEL_KICK') {
        const tabId = sender && sender.tab && sender.tab.id;
        const windowId = sender && sender.tab && sender.tab.windowId;
        if (!chrome.debugger || !Number.isInteger(tabId)) { sendResponse({ ok: false }); return; }
        if (Date.now() - Number(wpWaKickAt[windowId] || 0) < 110000) { sendResponse({ ok: false, error: 'tried lately' }); return; }
        chrome.storage.local.get(WP_WA_BOX_KEY, (box) => {
            if (wpWaBoxReady(box[WP_WA_BOX_KEY])) { sendResponse({ ok: true, up: true }); return; }
            wpWaKickAt[windowId] = Date.now();
            const target = { tabId: tabId };
            const x = Math.max(0, Number(message.x) || 2), y = Math.max(0, Number(message.y) || 2);
            const mouse = (type) => new Promise((resolve) => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: type, x: x, y: y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, () => { void chrome.runtime.lastError; resolve(); }));
            chrome.debugger.attach(target, '1.3', async () => {
                if (chrome.runtime.lastError) { sendResponse({ ok: false, error: chrome.runtime.lastError.message }); return; }
                try { await mouse('mousePressed'); await mouse('mouseReleased'); } catch (_) {}
                setTimeout(() => chrome.debugger.detach(target, () => void chrome.runtime.lastError), 300);
                sendResponse({ ok: true });
            });
        });
        return true;
    }
    // 1.7.282: open WhatsApp in Chrome's side panel (a click in the CRM / the popup).
    if (message.type === 'WP_WA_PANEL_OPEN') {
        const windowId = sender && sender.tab && Number.isInteger(sender.tab.windowId) ? sender.tab.windowId : Number(message.windowId);
        if (!chrome.sidePanel || !Number.isInteger(windowId)) { sendResponse({ ok: false, error: 'no side panel in this browser' }); return; }
        chrome.sidePanel.open({ windowId: windowId }).then(() => {
            sendResponse({ ok: true });
            // 1.7.386: a chat that was waiting for the panel opens now
            chrome.storage.local.get('wp_wa_open_pending_v1', (stored) => {
                const pending = stored.wp_wa_open_pending_v1;
                if (!pending) return;
                chrome.storage.local.remove('wp_wa_open_pending_v1');
                if (Date.now() - Number(pending.at) < 120000) wpWaDeliverToPanel(pending.msg);
            });
        }, (error) => sendResponse({ ok: false, error: String(error && error.message || error) }));
        return true;
    }

    // Phone app (1.7.212): the relay that carries mod's open
    // question to the phone and the tapped answer back. Only a Cloudflare
    // Worker address (https://….workers.dev) or, since 1.7.268, a relay you host
    // yourself behind Tailscale Funnel (https://….ts.net, with an optional port),
    // 1.7.344: also Evan's own domain (https://….eserris.com, e.g. wlcm.eserris.com).
    // and only these calls.
    if (message.type === 'WP_REMOTE') {
        const base = String(message.url || '').replace(/\/+$/, '');
        const path = String(message.path || '');
        const key = String(message.key || '');
        // 1.7.452: + /api/mirror (Sync with the box; 1.7.451 forgot it here, so Sync could not reach the box) and /api/mem (one memory)
        if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(workers\.dev|ts\.net|eserris\.com)(:\d{2,5})?$/.test(base) || ['/api/claim', '/api/pair-code', '/api/unpair', '/api/sync', '/api/settings', '/api/mirror', '/api/mem', '/api/boxinfo'].indexOf(path) < 0 || !/^[A-Za-z0-9_-]{32,200}$/.test(key)) {
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
    // 1.7.297: the tour pages' LiveOps notepad (wp-tours.js, was the
    // Tampermonkey script): its Google Sheet web app, with this Chrome's own
    // Google sign-in. Only that web app, only GET / POST.
    if (message.type === 'WP_TOUR_SHEET') {
        const base = 'https://script.google.com/a/macros/welcomepickups.com/s/AKfycbxi1hSJroLQ5hWRlowdoAMQ_-A61EKVio7EJYkYXZC6g6XFso4LGapHzbMMNt9CF5hr/exec';
        const url = String(message.url || '');
        const method = message.method === 'POST' ? 'POST' : 'GET';
        if (url !== base && url.indexOf(base + '?') !== 0) {
            sendResponse({ ok: false, error: 'only the LiveOps notes web app' });
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        fetch(url, {
            method: method,
            credentials: 'include',
            redirect: 'follow',
            cache: 'no-store',
            headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
            body: method === 'POST' ? String(message.body || '') : undefined,
            signal: controller.signal
        })
            .then((response) => response.text().then((text) => ({ status: response.status, text: text })))
            .then((result) => {
                clearTimeout(timer);
                if (result.status !== 200) sendResponse({ ok: false, error: 'HTTP ' + result.status });
                else sendResponse({ ok: true, text: result.text.slice(0, 2000000) });
            }, (error) => { clearTimeout(timer); sendResponse({ ok: false, error: String(error && error.message || error) }); });
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
    // Only for the actions with a plain dialog; never Share. 1.7.351: and Ask
    // (only the City Manager chain asks for it: its last step before Enable Auto-C).
    let auto = null;
    if (options.auto && ['note', 'remove_auto_c', 'enable_auto_c', 'broadcast', 'price_change', 'ask'].indexOf(action) >= 0) {
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

// 1.7.302: the overview page's nightly read (every city, saved to its
// history): at 03:30, overview.html?snapshot=1 in a background tab that
// closes itself when done.
const WP_OV_ALARM = 'wp_overview_nightly';
function wpOverviewAlarm() {
    chrome.alarms.get(WP_OV_ALARM, (existing) => {
        if (existing) return;
        const next = new Date();
        next.setHours(3, 30, 0, 0);
        if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
        chrome.alarms.create(WP_OV_ALARM, { when: next.getTime(), periodInMinutes: 1440 });
    });
}
chrome.runtime.onInstalled.addListener(wpOverviewAlarm);
chrome.runtime.onStartup.addListener(wpOverviewAlarm);
// 1.7.522: content.js may read storage.session (cleared by every browser start and every wlcm update): when its
// 'wp_booted' mark is missing, content.js switches every automation off once (wpBootAllOff). (1.7.521 used
// onStartup, which the box's cached old background handled before the new one was loaded.)
try { chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }); } catch (_) {}
chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== WP_OV_ALARM) return;
    const url = chrome.runtime.getURL('overview.html');
    chrome.tabs.query({ url: url + '?snapshot=1' }, (tabs) => {
        if ((tabs || []).length) return;
        chrome.tabs.create({ url: url + '?snapshot=1', active: false });
    });
});

// 1.7.438: Chrome started (e.g. after the phone woke the PC and Chrome was
// opened) → ready to work: the CRM Em Hailing list, and WhatsApp Web as a
// pinned tab when neither the WhatsApp side panel nor a WhatsApp tab is there (1.7.457: after 2 min, see below).
// Only what is missing is opened; nothing is sent or pressed.
// 1.7.476: Chromium just started: no side panel can be open yet, so a heartbeat left from before (e.g. the box restarted) is cleared — otherwise the CRM tab thinks the panel is up and does not open it
chrome.runtime.onStartup.addListener(() => { try { chrome.storage.local.set({ [WP_WA_BOX_KEY]: { at: 0, ready: false } }); } catch (_) {} });
chrome.runtime.onStartup.addListener(() => {
    setTimeout(() => {
        chrome.tabs.query({}, (tabs) => {
            const urls = (tabs || []).map((tab) => String(tab.url || tab.pendingUrl || ''));
            if (!urls.some((url) => /^https:\/\/crm\.welcomepickups\.com\//.test(url))) {
                chrome.tabs.create({ url: 'https://crm.welcomepickups.com/admin/transfers/index_v2?em_hailing=true&em_hailing_period=today_tomorrow', active: true }, () => void chrome.runtime.lastError);
            }
            // 1.7.457: the same Em Hailing list open twice (start page + restored tabs): one is kept
            const seenList = {};
            (tabs || []).forEach((tab) => {
                const url = String(tab.url || tab.pendingUrl || '');
                if (!/^https:\/\/crm\.welcomepickups\.com\/admin\/transfers\/index_v2\?/.test(url)) return;
                if (seenList[url]) chrome.tabs.remove(tab.id, () => void chrome.runtime.lastError);
                else seenList[url] = true;
            });
        });
    }, 6000);
    // 1.7.457: WhatsApp goes in the side panel (opened by the first click or key in a CRM tab, or Alt+Shift+W).
    // Only if the panel is still not up after 2 min, WhatsApp Web opens as a pinned tab, so it keeps working.
    // 1.7.464: no pinned WhatsApp tab any more — sending is side panel only.
});
// 1.7.457: Alt+Shift+W (a key press counts as a click for Chrome) opens the WhatsApp side panel
try {
    chrome.commands.onCommand.addListener((command, tab) => {
        if (command !== 'wp-open-wa' || !chrome.sidePanel) return;
        const open = (windowId) => { if (Number.isInteger(windowId)) chrome.sidePanel.open({ windowId: windowId }).catch(() => {}); };
        if (tab && Number.isInteger(tab.windowId)) open(tab.windowId);
        else chrome.windows.getLastFocused((win) => open(win && win.id));
    });
} catch (_) {}
// 1.7.457: once the side panel runs WhatsApp, a WhatsApp tab is closed (two WhatsApp Webs fight: "Use here"),
// unless a message is waiting to go out
function wpWaCloseTabsIfPanel() {
    chrome.storage.local.get([WP_WA_BOX_KEY, 'wp_wa_jobs_v1'], (stored) => {
        if (!wpWaBoxReady(stored && stored[WP_WA_BOX_KEY])) return;
        if (Array.isArray(stored.wp_wa_jobs_v1) && stored.wp_wa_jobs_v1.length) return;
        chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, (open) => {
            (open || []).forEach((tab) => chrome.tabs.remove(tab.id, () => void chrome.runtime.lastError));
        });
    });
}
try { chrome.alarms.onAlarm.addListener((alarm) => { if (alarm && alarm.name === 'wp-self-update') wpWaCloseTabsIfPanel(); }); } catch (_) {}

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
                justification: 'wlcm / Autopilot alert sound'
            });
        }
    } catch (_) {}
    chrome.runtime.sendMessage({ type: 'WP_OFFSCREEN_SOUND', kind: kind }, () => void chrome.runtime.lastError);
}

// 1.7.450: self-update. wlcm is loaded (unpacked) from one fixed folder on each machine. When a newer
// build is copied over that folder, it reloads itself within a minute and refreshes its CRM and WhatsApp
// tabs — nobody has to press Reload. It waits while WhatsApp jobs are queued.
const WP_SELF_ALARM = 'wp-self-update';
chrome.alarms.create(WP_SELF_ALARM, { periodInMinutes: 1 });
async function wpSelfUpdateCheck() {
    try {
        const response = await fetch(chrome.runtime.getURL('manifest.json') + '?t=' + Date.now(), { cache: 'no-store' });
        const onDisk = String((await response.json()).version || '');
        const running = String(chrome.runtime.getManifest().version || '');
        if (!onDisk || onDisk === running) return;
        const stored = await chrome.storage.local.get(['wp_wa_jobs_v1', 'wp_self_update_v1']);
        const jobs = Array.isArray(stored.wp_wa_jobs_v1) ? stored.wp_wa_jobs_v1 : [];
        const last = stored.wp_self_update_v1;
        if (jobs.length && !(last && last.waitFrom && Date.now() - last.waitFrom > 300000)) {
            if (!last || last.to !== onDisk || !last.waitFrom) await chrome.storage.local.set({ wp_self_update_v1: { from: running, to: onDisk, waitFrom: Date.now() } });
            return; // a WhatsApp send is under way: next minute (at most 5 min of waiting)
        }
        await chrome.storage.local.set({ wp_self_update_v1: { from: running, to: onDisk, at: Date.now() } });
        chrome.runtime.reload();
    } catch (_) {}
}
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm && alarm.name === WP_SELF_ALARM) wpSelfUpdateCheck(); });
// 1.7.471: a new version loaded (Load unpacked = "install", reload = "update"): the CRM list tabs are
// refreshed so they run the new code (the old pages kept the old one: "Extension context invalidated").
// Single transfer pages are left alone (you may be editing one).
chrome.runtime.onInstalled.addListener((details) => {
    if (!details || (details.reason !== 'install' && details.reason !== 'update')) return;
    chrome.tabs.query({ url: 'https://crm.welcomepickups.com/*' }, (tabs) => {
        (tabs || []).filter((tab) => !/\/admin\/transfers\/\d+/.test(String(tab.url || '')))
            .forEach((tab) => chrome.tabs.reload(tab.id, () => void chrome.runtime.lastError));
    });
    // 1.7.543: the Slack tab too (its reader lost wlcm after a reload and stopped)
    chrome.tabs.query({ url: 'https://app.slack.com/*' }, (tabs) => {
        (tabs || []).forEach((tab) => chrome.tabs.reload(tab.id, () => void chrome.runtime.lastError));
    });
});
chrome.runtime.onInstalled.addListener(async (details) => {
    if (!details || details.reason !== 'update') return;
    const stored = await chrome.storage.local.get('wp_self_update_v1');
    const update = stored.wp_self_update_v1;
    if (!update || !update.at || Date.now() - update.at > 120000) return;
    chrome.tabs.query({ url: ['https://crm.welcomepickups.com/*', 'https://web.whatsapp.com/*'] }, (tabs) => {
        (tabs || []).forEach((tab) => chrome.tabs.reload(tab.id, () => void chrome.runtime.lastError));
    });
});

// 1.7.526: the box hands its Ops Hub sign-in (its cookies for the Hub) to the relay, so the relay can call the
// Hub's own endpoints itself. Box only (Linux), every 5 min; sent when it changed or every 20 min. The cookies
// go from here to the relay only (relay settings kept by wp-signin.js on a CRM page), never to a page or log.
const WP_HUB_SESSION_ALARM = 'wp_hub_session_v1';
// 1.7.527: every try records its outcome (storage.local wp_hub_session_note, shown in the relay status as hubSess);
// the 5-min alarm is only created when missing (re-creating it on every service-worker start kept postponing it).
async function wpHubSessionNote(text) { try { await chrome.storage.local.set({ wp_hub_session_note: { at: Date.now(), x: String(text).slice(0, 160) } }); } catch (_) {} }
async function wpHubSessionHand() {
    const ua = navigator.userAgent || '';
    if (!/Linux/.test(ua) || /Android|CrOS/.test(ua)) return;
    const got = await chrome.storage.local.get(['wp_signin_relay_v1', 'wp_hub_session_sent']);
    const cfg = got.wp_signin_relay_v1;
    const base = String(cfg && cfg.url || '').replace(/\/+$/, '');
    if (!cfg || !cfg.key || !/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(workers\.dev|ts\.net|eserris\.com)(:\d{2,5})?$/.test(base)) return wpHubSessionNote('no relay settings yet');
    if (!chrome.cookies || typeof chrome.cookies.getAll !== 'function') return wpHubSessionNote('chrome.cookies is ' + typeof chrome.cookies);
    // 1.7.528: the box's Hub cookies are marked "set with a cross-site ancestor" and the plain url lookup returned
    // none; each other lookup Chrome offers is tried in turn and the counts are reported
    const HUB_HOST = 'ops-intelligence-hub.vercel.app';
    const tries = [
        ['url', { url: 'https://' + HUB_HOST + '/' }],
        ['domain', { domain: HUB_HOST }],
        ['url+partitions', { url: 'https://' + HUB_HOST + '/', partitionKey: {} }],
        ['all', {}]
    ];
    const counts = [];
    let cookies = [];
    for (const [name, details] of tries) {
        let found = [];
        try { found = ((await chrome.cookies.getAll(details)) || []).filter((c) => c && String(c.domain || '').replace(/^\./, '') === HUB_HOST); } catch (e) { counts.push(name + ' err'); continue; }
        counts.push(name + ' ' + found.length);
        if (found.some((c) => /^sb-/.test(c.name))) { cookies = found; break; }
    }
    const header = (cookies || []).filter((c) => c && c.name && !c.name.includes(';')).map((c) => c.name + '=' + c.value).join('; ');
    if (!header || !/(^|; )sb-/.test(header)) {
        // 1.7.529: the Hub page hands it over itself (see wpHubSessionFromPage): this note only when that is not working
        const sent = got.wp_hub_session_sent || {};
        if (Date.now() - Number(sent.at || 0) < 25 * 60000) return;
        return wpHubSessionNote('no Hub sign-in from a Hub page yet; cookie lookups: ' + counts.join(', '));
    }
    return wpHubSessionSend(base, cfg, header, got.wp_hub_session_sent || {}, ua, 'cookie lookup');
}
async function wpHubSessionSend(base, cfg, header, last, ua, how) {
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base + '\n' + header)))).map((b) => b.toString(16).padStart(2, '0')).join('');
    if (last.digest === digest && Date.now() - Number(last.at || 0) < 20 * 60000) return wpHubSessionNote('same as sent (' + how + ')');
    const response = await fetch(base + '/api/hubsession', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(cfg.key) },
        body: JSON.stringify({ main: true, cookie: header, ua: ua })
    });
    if (response.ok) { await chrome.storage.local.set({ wp_hub_session_sent: { digest: digest, at: Date.now() } }); return wpHubSessionNote('sent (' + how + ')'); }
    return wpHubSessionNote('relay said HTTP ' + response.status + ' (' + how + ')');
}
// 1.7.529: the sign-in a signed-in Hub page read itself (wp-signin.js), on the box
async function wpHubSessionFromPage(header, count) {
    const ua = navigator.userAgent || '';
    if (!/Linux/.test(ua) || /Android|CrOS/.test(ua)) return;
    header = String(header || '').slice(0, 24000);
    if (!/(^|; )sb-/.test(header)) return wpHubSessionNote('the Hub page is signed in but cannot read its sign-in (' + Number(count || 0) + ' cookies)');
    const got = await chrome.storage.local.get(['wp_signin_relay_v1', 'wp_hub_session_sent']);
    const cfg = got.wp_signin_relay_v1;
    const base = String(cfg && cfg.url || '').replace(/\/+$/, '');
    if (!cfg || !cfg.key || !/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(workers\.dev|ts\.net|eserris\.com)(:\d{2,5})?$/.test(base)) return wpHubSessionNote('no relay settings yet');
    return wpHubSessionSend(base, cfg, header, got.wp_hub_session_sent || {}, ua, 'from the Hub page');
}
// 1.7.529: the box keeps one Live Ops tab open in the background (never brought to the front), so the Hub stays
// signed in and its page can hand the sign-in over. Opened when missing, after a CRM tab is there.
async function wpHubTabKeep() {
    const ua = navigator.userAgent || '';
    if (!/Linux/.test(ua) || /Android|CrOS/.test(ua)) return;
    const hub = await chrome.tabs.query({ url: 'https://ops-intelligence-hub.vercel.app/*' });
    if (hub.length) return;
    const crm = await chrome.tabs.query({ url: 'https://crm.welcomepickups.com/*' });
    if (!crm.length) return;
    await chrome.tabs.create({ url: WP_HUB_LIST_URL, active: false, windowId: crm[0].windowId });
}
// 1.7.538: the box keeps one Slack tab open in the background (wp-slack.js reads it for the tablet's Chats tab).
// Not signed in: Slack shows its sign-in page there; you sign in once through noVNC.
async function wpSlackTabKeep() {
    const ua = navigator.userAgent || '';
    if (!/Linux/.test(ua) || /Android|CrOS/.test(ua)) return;
    const slack = await chrome.tabs.query({ url: 'https://*.slack.com/*' });
    // 1.7.542: one Slack tab only (two would both read and reply)
    const apps = slack.filter((tab) => /^https:\/\/app\.slack\.com\//.test(String(tab.url || '')));
    if (apps.length > 1) apps.slice(1).forEach((tab) => chrome.tabs.remove(tab.id, () => void chrome.runtime.lastError));
    if (slack.length) return;
    const crm = await chrome.tabs.query({ url: 'https://crm.welcomepickups.com/*' });
    if (!crm.length) return;
    await chrome.tabs.create({ url: 'https://app.slack.com/client', active: false, windowId: crm[0].windowId });
}
try { chrome.alarms.get(WP_HUB_SESSION_ALARM).then((alarm) => { if (!alarm) chrome.alarms.create(WP_HUB_SESSION_ALARM, { delayInMinutes: 0.5, periodInMinutes: 5 }); }); } catch (_) {}
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm && alarm.name === WP_HUB_SESSION_ALARM) { wpHubTabKeep().catch(() => {}); wpSlackTabKeep().catch(() => {}); wpHubSessionHand().catch((e) => wpHubSessionNote('error: ' + (e && e.message || e))); } });
setTimeout(() => { wpHubTabKeep().catch(() => {}); wpSlackTabKeep().catch(() => {}); wpHubSessionHand().catch((e) => wpHubSessionNote('error: ' + (e && e.message || e))); }, 15000);
