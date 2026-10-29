// 1.7.271: the toolbar button shows mod — how it stands on the dashboard
// tab, its switches (the same ones as in the Terminal's Controls), and a
// way to get to the Em Hailing page and the Terminal. The switches are
// changed by the dashboard tab itself, so the Terminal says what changed.
const EM_URL = 'https://crm.welcomepickups.com/admin/transfers/index_v2?em_hailing=true&em_hailing_period=today_tomorrow&filters%5Bcity%5D=all&filters%5Bdate%5D=';
const SWITCHES = [
    ['director', 'ghas', 'Watches Em Hailing and suggests'],
    ['full', 'Full auto', 'Answers its own suggestions, silently'],
    ['bkcancel', 'Auto-cancel', 'Booking 2:02 · drop-offs 1:10 · pickups 0:40'],
    ['wa', 'WhatsApp auto-send', 'BC&G / Final BC messages go out by themselves'],
    ['tickbox', 'Tick wheelchair / bulky', 'From the passenger and driver notes'],
    ['heroes', 'Send to heroes', '1 hour before Final BC, fitting car'],
    ['pnotify', 'Phone notifications', 'A ping on the phone for each suggestion'],
    ['ai', 'Local AI', 'Reads notes, translates, explains']
];
const $ = (id) => document.getElementById(id);
let dashTab = null;

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}

function note(text) {
    $('note').textContent = text || '';
    $('note').hidden = !text;
}

// The CRM tab that runs mod: the Em Hailing page first (the one with the lock), then any CRM list page.
async function findDashboard() {
    const tabs = await chrome.tabs.query({ url: 'https://crm.welcomepickups.com/*' });
    const lists = tabs.filter((tab) => /\/admin\/transfers\/index_v2/.test(tab.url || '') && /em_hailing=true/.test(tab.url || ''));
    const answers = [];
    for (const tab of lists) {
        try {
            const state = await chrome.tabs.sendMessage(tab.id, { type: 'WP_POPUP_STATE' });
            if (state && state.ok) answers.push({ tab, state });
        } catch (_) {}
    }
    answers.sort((a, b) => (b.state.lock ? 1 : 0) - (a.state.lock ? 1 : 0));
    return answers[0] || (lists[0] ? { tab: lists[0], state: null } : null);
}

function render(found) {
    dashTab = found ? found.tab : null;
    const state = found && found.state;
    const list = $('switches');
    list.textContent = '';
    if (!state) {
        $('dot').className = 'dot off';
        $('state').textContent = found ? 'The Em Hailing tab is still loading' : 'No Em Hailing tab open';
        $('state2').textContent = found ? 'Try again in a moment, or refresh that tab.' : 'ghas works on the Em Hailing page — open it below.';
    } else {
        const mode = state.mode === 'off' ? 'off' : state.paused ? 'paused' : state.full ? 'auto' : 'on';
        $('dot').className = 'dot ' + mode;
        $('state').textContent = mode === 'off' ? 'ghas is off' : mode === 'paused' ? 'ghas is paused' : mode === 'auto' ? 'ghas is on · Full auto' : 'ghas is on · asking you';
        const bits = [];
        if (state.paused) bits.push(state.paused);
        if (state.waiting) bits.push(state.waiting + ' waiting');
        if (state.running) bits.push(state.running + ' running');
        if (state.acOff) bits.push(state.acOff + ' on the A/C Off list');
        if (state.period) bits.push(state.period + ' page');
        $('state2').textContent = bits.join(' · ') || 'Nothing waiting right now.';
    }
    SWITCHES.forEach(([key, name, sub]) => {
        const row = el('div', 'row');
        const txt = el('div', 'txt');
        txt.appendChild(el('div', 'name', name));
        txt.appendChild(el('div', 'sub', sub));
        const sw = el('button', 'sw');
        sw.setAttribute('role', 'switch');
        const on = Boolean(state && state.switches && state.switches[key]);
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
        sw.disabled = !state;
        sw.addEventListener('click', async () => {
            if (!dashTab) return;
            sw.disabled = true;
            note('');
            try {
                const reply = await chrome.tabs.sendMessage(dashTab.id, { type: 'WP_POPUP_SET', item: key, value: !on });
                if (reply && reply.error) note(reply.error);
            } catch (_) { note('The Em Hailing tab did not answer — refresh it.'); }
            setTimeout(refresh, 350);
        });
        row.appendChild(txt);
        row.appendChild(sw);
        list.appendChild(row);
    });
}

async function refresh() {
    try { render(await findDashboard()); } catch (_) { render(null); }
}

$('open').addEventListener('click', async () => {
    if (dashTab) {
        await chrome.tabs.update(dashTab.id, { active: true });
        try { await chrome.windows.update(dashTab.windowId, { focused: true }); } catch (_) {}
    } else {
        await chrome.tabs.create({ url: EM_URL });
    }
    window.close();
});
$('term').addEventListener('click', async () => {
    if (!dashTab) { await chrome.tabs.create({ url: EM_URL }); window.close(); return; }
    try { await chrome.tabs.sendMessage(dashTab.id, { type: 'WP_POPUP_SET', item: 'terminal', value: true }); } catch (_) {}
    await chrome.tabs.update(dashTab.id, { active: true });
    try { await chrome.windows.update(dashTab.windowId, { focused: true }); } catch (_) {}
    window.close();
});
// 1.7.282: WhatsApp Web in Chrome's side panel (opened from this click).
$('wa').addEventListener('click', async () => {
    try {
        const win = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: win.id });
        window.close();
    } catch (error) { note('Could not open the side panel: ' + (error && error.message || error)); }
});

// 1.7.302: the big-picture page, in its own tab (one tab, reused).
$('overview').addEventListener('click', async () => {
    const url = chrome.runtime.getURL('overview.html');
    const tabs = await chrome.tabs.query({ url: url + '*' });
    const open = tabs.find((t) => !/snapshot=1/.test(t.url || ''));
    if (open) { await chrome.tabs.update(open.id, { active: true }); try { await chrome.windows.update(open.windowId, { focused: true }); } catch (_) {} }
    else await chrome.tabs.create({ url: url });
    window.close();
});

// The whole extension on / off on CRM pages (as before).
async function renderEnabled() {
    const result = await chrome.storage.local.get({ enabled: true });
    $('enabled').setAttribute('aria-checked', result.enabled !== false ? 'true' : 'false');
}
$('enabled').addEventListener('click', async () => {
    const result = await chrome.storage.local.get({ enabled: true });
    await chrome.storage.local.set({ enabled: result.enabled === false });
    renderEnabled();
    note(result.enabled === false ? '' : 'The extension is off on CRM pages from the next page load.');
});

$('ver').textContent = chrome.runtime.getManifest().version;
renderEnabled();
refresh();
setInterval(refresh, 3000);
