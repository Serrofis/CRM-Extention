// 1.7.282: WhatsApp Web in Chrome's side panel. The extension lets
// WhatsApp load in this frame (background.js, session rules), and its
// WhatsApp script runs inside it (wp-whatsapp.js). While it is open and
// logged in, mod's messages go out here instead of a WhatsApp tab.
// 1.7.284: Slack; 1.7.287: opened as its own window (see the Slack button).
(function() {
    'use strict';
    const frame = document.getElementById('wa');
    const state = document.getElementById('state');
    const WA = 'https://web.whatsapp.com';
    let waState = 'loading…';
    const go = function(url) {
        if (!/^https:\/\/web\.whatsapp\.com\//.test(String(url || ''))) return;
        frame.src = url;
    };
    // ---- tabs ----
    const tabs = {
        wa: { frame: frame, view: document.getElementById('view-wa'), zoomKey: 'wp_wa_panel_zoom_v1', zoom: 0.8 }
    };
    Object.keys(tabs).forEach(function(name) {
        try { const saved = Number(localStorage.getItem(tabs[name].zoomKey)); if (saved >= 0.5 && saved <= 1) tabs[name].zoom = saved; } catch (_) {}
    });
    const current = 'wa';
    const zoomText = document.getElementById('zoom');
    // 1.7.283: zoom 50–100% (80% to start), remembered per tab. The frame is
    // made larger by the same factor and scaled down, so it still fills the panel.
    const fit = function() {
        Object.keys(tabs).forEach(function(name) {
            const tab = tabs[name];
            tab.frame.style.width = (tab.view.clientWidth / tab.zoom) + 'px';
            tab.frame.style.height = (tab.view.clientHeight / tab.zoom) + 'px';
            tab.frame.style.transform = 'scale(' + tab.zoom + ')';
        });
        zoomText.textContent = Math.round(tabs[current].zoom * 100) + '%';
    };
    const setZoom = function(value) {
        const tab = tabs[current];
        tab.zoom = Math.max(0.5, Math.min(1, Math.round(value * 10) / 10));
        try { localStorage.setItem(tab.zoomKey, String(tab.zoom)); } catch (_) {}
        fit();
    };
    const show = function() {
        Object.keys(tabs).forEach(function(other) { tabs[other].view.classList.toggle('on', other === current); });
        document.querySelectorAll('.tab').forEach(function(button) { button.classList.toggle('on', button.getAttribute('data-tab') === current); });
        state.textContent = waState;
        fit();
    };
    // 1.7.287: Slack in the panel showed you (and everyone) as away — its live
    // connection does not run in a frame. It opens as its own slim window now.
    // 1.7.288: it opens exactly over this panel, under the button bar: the
    // click tells where the panel is on the screen.
    let panelPlace = null;
    const slackDock = function(open) {
        if (!panelPlace) return;
        const bar = document.querySelector('.bar').getBoundingClientRect().bottom;
        const place = { left: panelPlace.left, top: panelPlace.top, width: window.innerWidth, height: window.innerHeight, bar: bar };
        chrome.windows.getCurrent(function(win) {
            const host = win ? { id: win.id, left: win.left, top: win.top, width: win.width, height: win.height } : null;
            chrome.runtime.sendMessage({ type: open ? 'WP_SLACK_WINDOW' : 'WP_SLACK_DOCK', panel: place, host: host }, function() { void chrome.runtime.lastError; });
        });
    };
    document.querySelector('.tab[data-tab="slack"]').addEventListener('click', function(event) {
        panelPlace = { left: event.screenX - event.clientX, top: event.screenY - event.clientY, width: window.innerWidth };
        slackDock(true);
    });
    // the panel made wider / narrower: its right edge stays, Slack follows
    window.addEventListener('resize', function() {
        if (!panelPlace) return;
        panelPlace.left += panelPlace.width - window.innerWidth;
        panelPlace.width = window.innerWidth;
        clearTimeout(slackDock.timer);
        slackDock.timer = setTimeout(function() { slackDock(false); }, 300);
    });
    document.getElementById('zoomOut').addEventListener('click', function() { setZoom(tabs[current].zoom - 0.1); });
    document.getElementById('zoomIn').addEventListener('click', function() { setZoom(tabs[current].zoom + 0.1); });
    zoomText.addEventListener('click', function() { setZoom(1); });
    document.getElementById('reload').addEventListener('click', function() {
        go(WA + '/');
    });
    window.addEventListener('resize', fit);
    // 1.7.285: Mute — WhatsApp's sounds in this panel (the WhatsApp tab is not touched)
    const MUTE_KEY = 'wp_wa_panel_muted_v1';
    const muteButton = document.getElementById('mute');
    const paintMute = function(on) {
        muteButton.classList.toggle('on', Boolean(on));
        muteButton.textContent = on ? 'Muted' : 'Mute';
        muteButton.title = on ? 'WhatsApp is muted here — click for its sounds again' : 'Mute WhatsApp\'s sounds (this panel only)';
    };
    chrome.storage.local.get(MUTE_KEY, function(stored) { paintMute(Boolean(stored && stored[MUTE_KEY])); });
    muteButton.addEventListener('click', function() {
        const on = !muteButton.classList.contains('on');
        chrome.storage.local.set({ [MUTE_KEY]: on });
        paintMute(on);
    });
    show(current);
    // The frame asks to change its page (a chat by phone number): done
    // from here, so the extension's rule lets it load in the frame.
    window.addEventListener('message', function(event) {
        if (event.source !== frame.contentWindow || event.origin !== WA) return;
        const data = event.data || {};
        if (data.wpWaGo) go(data.wpWaGo);
        if (data.wpWaState) {
            waState = String(data.wpWaState).slice(0, 80);
            if (current === 'wa') state.textContent = waState;
        }
    });
    // Connected while open, so closing the panel hands the sends back to a WhatsApp tab at once.
    const connect = function() {
        try { chrome.runtime.connect({ name: 'wp-wa-panel' }).onDisconnect.addListener(function() { setTimeout(connect, 1000); }); } catch (_) {}
    };
    connect();
    // From the background (a group / chat link clicked in the CRM, a send queued).
    chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
        if (!message || message.type !== 'WP_WA_PANEL' || !message.msg) return;
        const inner = message.msg;
        // a chat / group you clicked in the CRM: shown on the WhatsApp tab
        if (inner.type === 'WP_WA_GO') go(inner.url);
        else { try { frame.contentWindow.postMessage({ wpPanel: inner }, WA); } catch (_) {} }
        sendResponse({ ok: true });
    });
})();
