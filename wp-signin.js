// wlcm 1.7.463: the CRM signed this browser out.
// On any CRM page that is its sign-in page (a "Sign in with Google" control, no transfers
// list): the app is told ("CRM signed out"), and on the main machine (the box, where nobody
// sits) "Sign in with Google" is pressed — the browser's own Google session signs in; no
// password is read, typed or kept here. Google's own pages are never touched: when Google asks
// something itself, it waits for you (noVNC). After the sign-in the Em Hailing page is opened again.
// 1.7.524: the same for the Ops Hub (ops-intelligence-hub.vercel.app): its sign-in page's
// "Sign in" / Google button is pressed on the box; after the sign-in its Live Ops list is opened.
(function() {
    'use strict';
    if (window.top !== window) return;
    const HUB = location.hostname === 'ops-intelligence-hub.vercel.app';
    const EM_URL = 'https://crm.welcomepickups.com/admin/transfers/index_v2?em_hailing=true&em_hailing_period=today_tomorrow&filters%5Bcity%5D=all&filters%5Bdate%5D=';
    const HUB_URL = 'https://ops-intelligence-hub.vercel.app/crm/live-ops?mode=transfers&window=all&lens=queue&optime=t0_24%2Ct24_48';
    const STAMP_KEY = 'wp_signin_click_v1'; // per site (each site has its own storage)
    const path = location.pathname;
    // the main machine: the CRM's own setting where wlcm keeps it; on the Hub only the Linux test
    const isMain = function() {
        try { const v = localStorage.getItem('wp_main_v1'); if (v === '1' || v === '0') return v === '1'; } catch (_) {}
        return /Linux/.test(navigator.userAgent || '') && !/Android|CrOS/.test(navigator.userAgent || '');
    };
    // The relay is told with the CRM's relay settings; on the Hub background.js sends it with the
    // settings the CRM tab last stored (WP_SIGNIN_TELL).
    const tell = function(state) {
        const body = HUB ? { main: isMain(), hub: state } : { main: isMain(), crm: state };
        if (HUB) { try { chrome.runtime.sendMessage({ type: 'WP_SIGNIN_TELL', body: body }, function() { void chrome.runtime.lastError; }); } catch (_) {} return; }
        let cfg = null;
        try { cfg = JSON.parse(localStorage.getItem('wp_remote_cfg_v1') || 'null'); } catch (_) {}
        if (!cfg || cfg.on !== true || !cfg.url || !cfg.key) return;
        try {
            chrome.runtime.sendMessage({ type: 'WP_REMOTE', url: String(cfg.url), key: String(cfg.key), path: '/api/boxinfo', body: body }, function() { void chrome.runtime.lastError; });
        } catch (_) {}
    };
    // on a CRM page: keep the relay address + key where background.js can use them for the Hub's report
    if (!HUB) {
        try {
            const cfg = JSON.parse(localStorage.getItem('wp_remote_cfg_v1') || 'null');
            if (cfg && cfg.on === true && cfg.url && cfg.key) chrome.storage.local.set({ wp_signin_relay_v1: { url: String(cfg.url), key: String(cfg.key) } });
        } catch (_) {}
    }
    const stamp = function() { try { return JSON.parse(localStorage.getItem(STAMP_KEY) || 'null') || {}; } catch (_) { return {}; } };
    const visible = function(el) { return Boolean(el) && el.getClientRects().length > 0; };
    const textOf = function(el) { return [el.getAttribute('href'), el.getAttribute('action'), el.getAttribute('aria-label'), el.getAttribute('title'), el.value, el.tagName === 'FORM' ? '' : el.textContent].join(' '); };
    const googleControl = function() {
        const all = Array.from(document.querySelectorAll('a[href], button, input[type="submit"], form[action]'));
        const google = all.find(function(el) { return /google/i.test(textOf(el)) && !/sign\s*out|log\s*out/i.test(textOf(el)) && (el.tagName === 'FORM' || visible(el)); });
        if (google || !HUB) return google || null;
        // the Hub: a plain "Sign in" / "Log in" / "Continue" button is its sign-in too
        return all.find(function(el) { return el.tagName !== 'FORM' && visible(el) && /^\s*(sign\s*in|log\s*in|continue)\b/i.test(String(el.textContent || el.value || '')); }) || null;
    };
    const signedOut = function() {
        if (!googleControl()) return false;
        if (HUB) {
            const text = String(document.body ? document.body.innerText || '' : '');
            return /sign|login|auth/i.test(path) || (text.length < 2500 && /sign\s*in|log\s*in/i.test(text));
        }
        if (document.querySelector('table.transfers')) return false;
        return /sign_?in|log_?in|auth|session/i.test(path) || Boolean(document.querySelector('input[type="password"]')) || !/^\/admin\//.test(path);
    };
    const press = function() {
        const control = googleControl();
        if (!control) return;
        if (control.tagName === 'FORM') {
            const button = control.querySelector('button, input[type="submit"]');
            if (button) button.click(); else control.submit();
        } else control.click();
    };
    window.setTimeout(function() {
        const now = Date.now();
        const mark = stamp();
        if (signedOut()) {
            tell('out');
            window.setInterval(function() { if (signedOut()) tell('out'); }, 60000);
            if (!isMain()) return;
            const today = new Date().toISOString().slice(0, 10);
            const count = mark.day === today ? Number(mark.n) || 0 : 0;
            // at most once every 3 minutes and 6 times a day (a sign-in that keeps failing is yours to look at)
            if (now - Number(mark.at || 0) < 180000 || count >= 6) return;
            try { localStorage.setItem(STAMP_KEY, JSON.stringify({ at: now, day: today, n: count + 1 })); } catch (_) {}
            window.setTimeout(press, 1500);
            return;
        }
        // signed in again a moment after a press: tell the app, and back to the list
        if (mark.at && now - Number(mark.at) < 180000) {
            try { localStorage.setItem(STAMP_KEY, JSON.stringify({ at: 0, day: mark.day, n: mark.n })); } catch (_) {}
            tell('ok');
            if (HUB) { if (!/^\/crm\/live-ops/.test(path)) window.setTimeout(function() { location.replace(HUB_URL); }, 800); }
            else if (!/^\/admin\/transfers\//.test(path)) window.setTimeout(function() { location.replace(EM_URL); }, 800);
        }
    }, HUB ? 3000 : 1800);
    // 1.7.529: on the box, a signed-in Hub page hands its own sign-in (the sb-* cookies it can read) to background.js
    // for the relay — Chrome's cookie API did not return these cookies on the box. Every 5 min; background.js only
    // sends it on when it changed or every 20 min.
    if (HUB && isMain()) {
        const handOver = function() {
            if (signedOut()) return;
            const own = String(document.cookie || '').split(/;\s*/).filter(function(part) { return /^sb-/.test(part); });
            try { chrome.runtime.sendMessage({ type: 'WP_HUB_SESSION_PAGE', cookie: own.join('; '), count: own.length }, function() { void chrome.runtime.lastError; }); } catch (_) {}
        };
        window.setTimeout(handOver, 8000);
        window.setInterval(handOver, 5 * 60000);
    }
})();
