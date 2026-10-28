// 1.7.297: the "WP CRM - No Driver Alert + Order Notepad" Tampermonkey
// script (v6.3), moved into the extension so Tampermonkey can be removed.
// Same behaviour; only the Tampermonkey parts were swapped for the
// extension's own:
//   GM_setValue / GM_getValue  → chrome.storage.local
//   GM_xmlhttpRequest (Sheet)  → background.js (WP_TOUR_SHEET)
//   GM_openInTab               → background.js (WP_TRANSFER_ASSISTANT_OPEN_TAB)
//   GM_setClipboard            → navigator.clipboard (copy fallback)
//   the WhatsApp Web paste     → wp-whatsapp.js (the S-rides group is opened
//                                the way mod opens groups: side panel or your
//                                WhatsApp tab; the message is pasted, never sent)
// Runs on crm.welcomepickups.com/admin/tour_transfers/* and the Confluence
// "Welcome City WhatsApp groups" page.

(function () {
  'use strict';
  if (window.__wpToursLoaded) return;
  window.__wpToursLoaded = true;

  // ============================================================
  // CONFIG — edit this line
  // ============================================================
  const SHEET_WEBAPP_URL = 'https://script.google.com/a/macros/welcomepickups.com/s/AKfycbxi1hSJroLQ5hWRlowdoAMQ_-A61EKVio7EJYkYXZC6g6XFso4LGapHzbMMNt9CF5hr/exec';
  const AUTHOR_EMAIL_DOMAIN = 'welcomepickups.com'; // used if the CRM only shows a username, not a full email

  // Where "Copy tour info" opens the S-rides group:
  //   'web' = WhatsApp Web (mod's side panel or WhatsApp tab), message pasted into the chat box automatically
  //   'app' = WhatsApp desktop app, message is on the clipboard (press Ctrl+V)
  const WHATSAPP_TARGET = 'web';

  // Confluence page that lists every city's WhatsApp groups
  const WA_GROUPS_PAGE_ID = '3862102017';
  const WA_GROUPS_PAGE_URL = 'https://welcomepickups.atlassian.net/wiki/spaces/IKB/pages/3862102017/Welcome+City+WhatsApp+groups';

  // ============================================================
  // EXTENSION STAND-INS for the Tampermonkey functions
  // ============================================================
  async function storeGet(key, fallback) {
    try {
      const stored = await chrome.storage.local.get(key);
      return stored[key] === undefined ? fallback : stored[key];
    } catch (_) { return fallback; }
  }
  async function storeSet(key, value) {
    try { await chrome.storage.local.set({ [key]: value }); } catch (_) {}
  }
  function openInTab(url) {
    try {
      chrome.runtime.sendMessage({ type: 'WP_TRANSFER_ASSISTANT_OPEN_TAB', url, options: { active: true } }, () => void chrome.runtime.lastError);
    } catch (_) {
      window.open(url, '_blank');
    }
  }

  // ============================================================
  // SHARED — S-rides WhatsApp groups (synced from Confluence)
  // ============================================================
  const SRIDES_KEY = 'wp_tour_srides_groups_v1';      // { syncedAt, map: { normCity: { city, url, title } } }
  const WA_PENDING_KEY = 'wp_tour_wa_pending_v1';     // { text, code, at } — read by wp-whatsapp.js

  function normCity(s) {
    return (s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/ø/gi, 'o').replace(/ł/gi, 'l').replace(/æ/gi, 'ae').replace(/ß/g, 'ss')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  async function findSridesGroup(city) {
    const data = await storeGet(SRIDES_KEY, null);
    if (!data || !data.map) return { status: 'not-synced' };
    const key = normCity(city);
    if (!key) return { status: 'no-city' };
    if (data.map[key]) return { status: 'ok', ...data.map[key] };
    // Loose match, e.g. "Tromso" vs "Tromso (Norway)"
    const loose = Object.keys(data.map).find(k => k.startsWith(key + ' ') || key.startsWith(k + ' '));
    return loose ? { status: 'ok', ...data.map[loose] } : { status: 'not-found', city };
  }

  // Runs on the Confluence "Welcome City WhatsApp groups" page.
  // Reads the table, asks Confluence for each WhatsApp link's group name
  // (that's where "S-Rides ..." comes from) and saves city -> S-rides link.
  async function syncSridesFromConfluence() {
    const toast = document.createElement('div');
    Object.assign(toast.style, {
      position: 'fixed', bottom: '20px', right: '20px', zIndex: 999999,
      background: '#2E3B4D', color: '#fff', padding: '10px 14px', borderRadius: '8px',
      fontFamily: 'Arial, sans-serif', fontSize: '13px', boxShadow: '0 4px 12px rgba(0,0,0,0.25)'
    });
    toast.textContent = '⏳ Syncing S-rides WhatsApp groups…';
    document.body.appendChild(toast);

    try {
      const pageRes = await fetch(`/wiki/rest/api/content/${WA_GROUPS_PAGE_ID}?expand=body.storage`, {
        credentials: 'same-origin', headers: { Accept: 'application/json' }
      });
      if (!pageRes.ok) throw new Error('Page HTTP ' + pageRes.status);
      const doc = new DOMParser().parseFromString((await pageRes.json()).body.storage.value, 'text/html');

      const table = Array.from(doc.querySelectorAll('table'))
        .filter(t => /group link/i.test(t.textContent))
        .sort((a, b) => b.rows.length - a.rows.length)[0];
      if (!table) throw new Error('Groups table not found');

      const headers = Array.from(table.rows[0].cells).map(c => c.textContent.trim());
      const cityIdx = headers.findIndex(h => /^city$/i.test(h));
      const linkIdx = headers.findIndex(h => /group link/i.test(h));
      if (cityIdx < 0 || linkIdx < 0) throw new Error('City / link columns not found');

      const entries = [];
      Array.from(table.rows).slice(1).forEach(row => {
        const city = cleanText(row.cells[cityIdx]?.textContent);
        if (!city) return;
        row.cells[linkIdx]?.querySelectorAll('a[href*="chat.whatsapp.com"]').forEach(a => {
          entries.push({ city, url: a.getAttribute('href') });
        });
      });

      // Resolve group names in batches of 50
      const urls = [...new Set(entries.map(e => e.url))];
      const titles = {};
      for (let i = 0; i < urls.length; i += 50) {
        const chunk = urls.slice(i, i + 50);
        toast.textContent = `⏳ Syncing S-rides WhatsApp groups… ${Math.min(i + 50, urls.length)}/${urls.length}`;
        const res = await fetch('/gateway/api/object-resolver/resolve/batch', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(chunk.map(u => ({ resourceUrl: u })))
        });
        if (!res.ok) throw new Error('Link names HTTP ' + res.status);
        const data = await res.json();
        chunk.forEach((u, k) => { titles[u] = data[k]?.body?.data?.name || ''; });
      }

      const map = {};
      entries.forEach(e => {
        const title = titles[e.url];
        const key = normCity(e.city);
        if (/s\s*-\s*rides?/i.test(title) && !map[key]) map[key] = { city: e.city, url: e.url, title };
      });

      const count = Object.keys(map).length;
      if (!count) throw new Error('No S-rides groups found');
      await storeSet(SRIDES_KEY, { syncedAt: Date.now(), map });
      toast.style.background = '#57BE8C';
      toast.style.color = '#2E3B4D';
      toast.textContent = `✓ S-rides WhatsApp groups synced: ${count} cities`;
    } catch (err) {
      console.log('[ghas tours] S-rides sync failed:', err);
      toast.style.background = '#E05252';
      toast.textContent = '⚠ S-rides sync failed: ' + (err.message || err);
    }
    setTimeout(() => toast.remove(), 6000);
  }

  // Opens the S-rides group. In 'web' mode it also leaves the message for
  // wp-whatsapp.js to paste into the chat box (never sent).
  async function openSridesGroup(group, text) {
    const code = (group.url.match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]+)/) || [])[1];
    if (!code) return false;

    if (WHATSAPP_TARGET === 'web') {
      await storeSet(WA_PENDING_KEY, { text, code, at: Date.now() });
      // mod's own way of opening a group: the side panel's WhatsApp when it
      // is logged in, else your WhatsApp tab (no second tab, no "Use here").
      const url = `https://web.whatsapp.com/accept?code=${code}`;
      let opened = false;
      try {
        const reply = await chrome.runtime.sendMessage({ type: 'WP_WA_OPEN', url, city: group.city || '' });
        opened = Boolean(reply && reply.ok);
      } catch (_) {}
      if (!opened) openInTab(url);
    } else {
      openInTab(`https://chat.whatsapp.com/${code}`);
    }
    return true;
  }

  // Auto-detects the logged-in agent from the "Logout" area in the top bar
  // (e.g. the "ckalantzis" text shown above the Logout link), and turns it
  // into an email if it isn't one already. Falls back to 'Unknown agent'
  // if nothing can be found, so notes are never left completely unlabeled.
  function detectAuthor() {
    const currentUserEl = document.querySelector('#current_user a, #current_user');
    const raw = (currentUserEl?.textContent || '').trim();
    if (!raw) return 'Unknown agent';

    const emailMatch = raw.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (emailMatch) return emailMatch[0];

    return `${raw}@${AUTHOR_EMAIL_DOMAIN}`;
  }

  const AUTHOR_NAME = location.hostname === 'crm.welcomepickups.com' ? detectAuthor() : '';

  // ============================================================
  // PART 1 — INDEX PAGE: no-driver alert
  // ============================================================
  function initIndexHighlighter() {

    function normalize(text) {
      return (text || '')
        .replace(/ /g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    }

    function visibleText(el) {
      return (el?.innerText || '')
        .replace(/ /g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function hasUnpaidMarker(cell) {
      const text = visibleText(cell);
      return text === 'U' || /\bU\b/.test(text);
    }

    function isMissingDriverCell(cell) {
      return !normalize(visibleText(cell));
    }

    function applyDriverAlert(row, cell) {
      if (!cell || cell.dataset.driverDone === '1') return;
      cell.innerHTML = '';
      if (row) {
        row.style.background = '#dcfce7';
        row.style.fontWeight = '700';
        row.style.fontSize = '15px';
      }
      const badge = document.createElement('span');
      badge.textContent = '🚨 NO DRIVER';
      Object.assign(badge.style, {
        display: 'inline-block', background: '#fee2e2', color: '#991b1b',
        fontWeight: '700', padding: '3px 10px', borderRadius: '999px',
        lineHeight: '1.2', whiteSpace: 'nowrap'
      });
      cell.appendChild(badge);
      cell.dataset.driverDone = '1';
    }

    // --- Day grouping: each pickup day gets its own colour ---
    // Index 0 = today, 1 = tomorrow, ... (cycles after the last colour)
    const DAY_COLOURS = [
      { bg: '#F8CF66', fg: '#2E3B4D' }, // today     – yellow
      { bg: '#58C3BF', fg: '#2E3B4D' }, // tomorrow  – turquoise
      { bg: '#B79CED', fg: '#2E3B4D' }, // +2 days   – lilac
      { bg: '#F49AC1', fg: '#2E3B4D' }, // +3 days   – pink
      { bg: '#F5A35C', fg: '#2E3B4D' }, // +4 days   – orange
      { bg: '#8FB8F2', fg: '#2E3B4D' }, // +5 days   – blue
      { bg: '#C5D86D', fg: '#2E3B4D' }  // +6 days   – lime
    ];
    const PAST_COLOUR = { bg: '#9CA3AF', fg: '#1F2937' };
    const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const DATE_CELL_RE = /^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})(?:\s*-\s*\d{1,2}:\d{2})?$/;

    function applyDayColour(row, cells) {
      for (const cell of cells) {
        if (cell.dataset.dayDone === '1') return;
        const m = visibleText(cell).match(DATE_CELL_RE);
        if (!m) continue;
        const mi = monthIndex(m[2]);
        if (mi < 0) continue;

        const day = new Date(+m[3], mi, +m[1]);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const diff = Math.round((day - today) / 86400000);
        const colour = diff < 0 ? PAST_COLOUR : DAY_COLOURS[diff % DAY_COLOURS.length];
        const tag = diff === 0 ? 'TODAY' : diff === 1 ? 'TOMORROW' : diff < 0 ? 'PAST' : WEEKDAYS[day.getDay()];

        const original = visibleText(cell);
        cell.innerHTML = '';
        const badge = document.createElement('span');
        badge.textContent = original;
        Object.assign(badge.style, {
          display: 'inline-block', background: colour.bg, color: colour.fg,
          fontWeight: '700', padding: '2px 8px', borderRadius: '6px', whiteSpace: 'nowrap'
        });
        const label = document.createElement('span');
        label.textContent = tag;
        Object.assign(label.style, {
          display: 'inline-block', marginLeft: '6px', fontSize: '10px', fontWeight: '700',
          color: colour.bg, letterSpacing: '0.5px', whiteSpace: 'nowrap'
        });
        cell.appendChild(badge);
        cell.appendChild(label);
        cell.dataset.dayDone = '1';

        if (row) row.style.boxShadow = `inset 6px 0 0 ${colour.bg}`; // coloured stripe on the left
        return;
      }
    }

    function hasOrderIdCell(cells) {
      // A real data row always has an "#123456"-style order number cell.
      // This filters out header rows, filter rows, and any frozen/sticky
      // duplicate row clones that don't carry the full column set.
      return cells.some(cell => /^#\d{4,9}$/.test(visibleText(cell)));
    }

    function scan() {
      const rows = document.querySelectorAll('tr, [role="row"], .ant-table-row');
      rows.forEach(row => {
        // Skip layout rows that wrap the whole table (they contain other rows)
        if (row.querySelector('tr, [role="row"], .ant-table-row')) return;
        // Only this row's own cells, never cells of nested tables
        const cells = Array.from(row.children).filter(c =>
          c.matches('td, [role="cell"], [role="gridcell"], .ant-table-cell')
        );
        if (!cells.length) return;
        if (!hasOrderIdCell(cells)) return; // skip anything that isn't a real transfer row

        applyDayColour(row, cells); // colour-code the pickup date by day (all rows)

        const firstCell = cells[0];
        const driverCell = cells[cells.length - 1];
        if (!firstCell || !driverCell) return;

        // Skip rows marked "U" (unpaid) in the first column
        if (hasUnpaidMarker(firstCell)) return;

        if (isMissingDriverCell(driverCell)) applyDriverAlert(row, driverCell);
      });
    }

    console.log('[ghas tours] No-driver highlighter running...');
    scan();
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    setInterval(scan, 2000);
  }

  // ============================================================
  // PART 3 — TOUR PAGES: copy tour info in a fixed format
  // ============================================================
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  function cleanText(t) {
    return (t || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  }

  function monthIndex(word) {
    const w = (word || '').slice(0, 3).toLowerCase();
    return MONTHS.findIndex(m => m.slice(0, 3).toLowerCase() === w);
  }

  function ordinal(d) {
    if (d % 100 >= 11 && d % 100 <= 13) return 'th';
    return ({ 1: 'st', 2: 'nd', 3: 'rd' })[d % 10] || 'th';
  }

  // Finds the Hailing-tab header line:
  // "Name  Time: 11:00 | From: ... To: ... | Pax: 2"
  // Uses textContent, so it works even while the Hailing tab is hidden.
  // Only tour pages have this line, so this is also the tour-page check.
  function findTourBar() {
    const re = /Time:\s*.+?From:\s*.+?To:\s*.+?Pax:\s*\d+/i;
    let best = null;
    let bestLen = Infinity;
    document.querySelectorAll('div, td, span, p, li, h1, h2, h3, h4, h5, section').forEach(el => {
      if (el.closest('#liveops-note-card')) return;
      const t = cleanText(el.textContent);
      if (t.length > 1500 || t.length >= bestLen || !re.test(t)) return;
      best = el;
      bestLen = t.length;
    });
    return best;
  }

  function parseTourBar(text) {
    const m = cleanText(text).match(
      /Time:\s*(.*?)\s*\|?\s*From:\s*(.*?)\s*\|?\s*To:\s*(.*?)\s*\|?\s*Pax:\s*(\d+)/i
    );
    if (!m) return null;
    const strip = s => (s || '').replace(/\s*\|\s*$/, '').trim();
    return { time: strip(m[1]), from: strip(m[2]), to: strip(m[3]), pax: m[4] };
  }

  // Generic "label -> value" lookup for Active Admin pages.
  // Handles both show tables (<th>Label</th><td>Value</td>) and edit forms
  // (<label>Label</label><input/select>).
  function findFieldValue(labelTest, root = document) {
    for (const lab of root.querySelectorAll('th, dt, label')) {
      if (lab.closest('#liveops-note-card')) continue;
      const label = cleanText(lab.textContent).replace(/[:*]\s*$/, '').trim();
      if (!label || label.length > 40 || !labelTest(label)) continue;

      let val = '';
      if (lab.tagName === 'LABEL') {
        const target = lab.htmlFor ? root.getElementById(lab.htmlFor) : null;
        const ctrl = target ||
          lab.closest('li, .input, div')?.querySelector('input:not([type="hidden"]), select, textarea');
        if (ctrl) {
          val = ctrl.tagName === 'SELECT'
            ? cleanText(ctrl.selectedOptions[0]?.textContent)
            : cleanText(ctrl.value);
        }
      } else {
        val = cleanText(lab.nextElementSibling?.textContent);
      }
      if (val) return val;
    }
    return '';
  }

  // Returns { d, m (0-based), y } or null
  function parseDateString(raw) {
    const s = cleanText(raw);
    if (!s) return null;
    let m;

    if ((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)))              // 2026-09-29
      return { y: +m[1], m: +m[2] - 1, d: +m[3] };
    if ((m = s.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/))) // 29/09/2026 (day first)
      return { y: +m[3], m: +m[2] - 1, d: +m[1] };
    if ((m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,})\.?,?\s*(\d{4})?/))) { // 29 Sep 2026
      const mi = monthIndex(m[2]);
      if (mi >= 0) return { y: m[3] ? +m[3] : null, m: mi, d: +m[1] };
    }
    if ((m = s.match(/\b([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/))) { // September 29, 2026
      const mi = monthIndex(m[1]);
      if (mi >= 0) return { y: m[3] ? +m[3] : null, m: mi, d: +m[2] };
    }
    return null;
  }

  function findTourDate(root = document) {
    const excluded = /(created|updated|expire|cancel|paid|refund|birth|reject|deadline|last)/i;

    // 1) Rails-style date selects: ..._date_1i (year) / _2i (month) / _3i (day)
    const ySel = Array.from(root.querySelectorAll('select[id*="date"][id$="_1i"]'))
      .find(el => !excluded.test(el.id));
    if (ySel) {
      const base = ySel.id.slice(0, -3);
      const mSel = root.getElementById(base + '_2i');
      const dSel = root.getElementById(base + '_3i');
      if (mSel?.value && dSel?.value) return { y: +ySel.value, m: +mSel.value - 1, d: +dSel.value };
    }

    // 2) Inputs whose id/name mentions a date (pickup_date, tour_date, starts_at, ...)
    const input = Array.from(root.querySelectorAll('input[id*="date"], input[name*="date"], input[id*="starts_at"], input[id*="datetime"]'))
      .find(el => el.value && !excluded.test(el.id + ' ' + el.name));
    const fromInput = parseDateString(input?.value);
    if (fromInput) return fromInput;

    // 3) Any labelled date field (Pickup Date, Tour Date, Date, Starts At, ...)
    const raw = findFieldValue(
      l => /(date|starts? at|pickup time|day)/i.test(l) && !excluded.test(l),
      root
    );
    return parseDateString(raw);
  }

  function formatMoney(raw, forcedCur) {
    if (!raw) return '';
    const numMatch = raw.match(/\d[\d.,]*/);
    if (!numMatch) return raw;

    let n = numMatch[0];
    if (n.includes(',') && n.includes('.')) n = n.replace(/,/g, ''); // 1,240.00
    else n = n.replace(',', '.');                                      // 240,00
    const num = Number(n);
    if (Number.isNaN(num)) return raw;

    const cur = forcedCur || (/\$/.test(raw) ? '$' : /£/.test(raw) ? '£' : '€');
    return `${num} ${cur}`;
  }

  // The green icon next to the page title links to the Welcome Order
  // (/admin/welcome_orders/<id>), which holds From Datetime, Amount and
  // Provider Cost. If the icon is missing, build the URL from the title
  // ("Tour Transfer #7281810" -> welcome order 7281810).
  function findTourDetailsUrl() {
    const icon = document.querySelector('#page_title a[href*="/welcome_orders/"], h2 a[href*="/welcome_orders/"]');
    if (icon) return icon.href;
    const titleMatch = cleanText(document.getElementById('page_title')?.textContent).match(/#(\d{4,9})/);
    return titleMatch ? `${location.origin}/admin/welcome_orders/${titleMatch[1]}` : null;
  }

  // Same-site fetch with the browser's normal Accept header. Without that
  // header the CRM redirects the request to /admin/dashboard.
  async function fetchDoc(url) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (/\/admin\/dashboard/.test(res.url)) throw new Error('Redirected to dashboard');
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  // Reads an Active Admin show-page row: <tr class="row row-<key>"><th/><td>value</td></tr>
  function rowValue(doc, key) {
    const v = cleanText(doc?.querySelector(`tr.row-${key} > td`)?.textContent);
    return v && !/^empty$/i.test(v) ? v : '';
  }

  function currencySymbol(code) {
    return ({ EUR: '€', USD: '$', GBP: '£', CHF: 'CHF', NOK: 'NOK', SEK: 'SEK', DKK: 'DKK', CZK: 'CZK', PLN: 'PLN', HUF: 'HUF', TRY: 'TRY', AED: 'AED' })[(code || '').toUpperCase()] || code || '€';
  }

  // Fetched once per page and reused (also pre-fetched when the button shows)
  let tourDetailsPromise = null;
  function getTourDetailsDoc() {
    if (!tourDetailsPromise) {
      const url = findTourDetailsUrl();
      tourDetailsPromise = url
        ? fetchDoc(url).catch(err => { console.log('[ghas tours] Tour details fetch failed:', err); tourDetailsPromise = null; return null; })
        : Promise.resolve(null);
    }
    return tourDetailsPromise;
  }

  function formatDate(p) {
    if (!p || !(p.d >= 1 && p.d <= 31) || !(p.m >= 0 && p.m <= 11)) return '';
    return `${p.d}${ordinal(p.d)} of ${MONTHS[p.m]}`;
  }

  const PRICE_LABEL = l => /^(total\s+|final\s+)?price\b/i.test(l);
  const PROVIDER_COST_LABEL = l => /provider\s*cost/i.test(l);

  // Details tab: the same info lives in the edit form fields
  function readTourInfoFromForm() {
    const val = id => {
      const el = document.getElementById(id);
      if (!el) return '';
      return cleanText(el.tagName === 'SELECT' ? el.selectedOptions[0]?.textContent : el.value);
    };
    const dt = val('tour_transfer_from_datetime');          // "2026-10-10T08:00"
    const service = val('tour_transfer_service_id');        // tour name
    if (!dt && !service) return null;
    return {
      time: (dt.match(/T(\d{1,2}:\d{2})/) || [])[1] || '',
      from: val('tour_transfer_from_address'),
      to: service,
      pax: val('tour_transfer_number_of_passengers')
    };
  }

  // Hailing tab line first, Details tab form as fallback
  function getTourInfo() {
    const bar = findTourBar();
    return (bar && parseTourBar(bar.textContent)) || readTourInfoFromForm();
  }

  async function buildTourSummary() {
    const info = getTourInfo();
    if (!info) return null;

    const detailsDoc = await getTourDetailsDoc();
    const cur = currencySymbol(rowValue(detailsDoc, 'currency_code'));

    // Date: Welcome Order "From Datetime" first, then anything on this page
    const date = formatDate(
      parseDateString(rowValue(detailsDoc, 'from_datetime')) ||
      findTourDate() ||
      (detailsDoc ? findTourDate(detailsDoc) : null)
    );

    // Provider cost: Welcome Order "Provider Cost"
    const providerCost = formatMoney(rowValue(detailsDoc, 'provider_cost'), cur) ||
      formatMoney(detailsDoc ? findFieldValue(PROVIDER_COST_LABEL, detailsDoc) : '', cur);

    const city = rowValue(detailsDoc, 'welcome_city') || getCity() || '';

    return {
      city,
      text: [
        'Hey team! Anyone available for this tour?',
        '',
        `Date: ${date}`,
        `Time: ${info.time}`,
        `From: ${info.from}`,
        `To: ${info.to}`,
        `Pax: ${info.pax}`,
        // 1.7.300: one price only — the provider cost (what the driver gets)
        `Price: ${providerCost}`.trim()
      ].join('\n'),
      missing: [!date && 'date', !providerCost && 'provider cost'].filter(Boolean)
    };
  }

  // The page may have lost focus while the details loaded: then the old
  // copy command is used (works from the click that started it).
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (_) {}
    const area = document.createElement('textarea');
    area.value = text;
    Object.assign(area.style, { position: 'fixed', left: '-9999px', top: '0' });
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('copy refused');
  }

  // ============================================================
  // PART 2 — DETAIL PAGE: floating notepad synced to Google Sheet
  // ============================================================
  function getOrderId() {
    // Try the URL path first (e.g. /tour_transfers/6615481)
    const pathMatch = location.pathname.match(/tour_transfers\/(\d{4,9})(?:[/?#]|$)/);
    if (pathMatch) return pathMatch[1];

    // Fallback: page text like "Transfer #6615481"
    const bodyText = document.body.innerText || '';
    const headMatch = bodyText.match(/Transfer\s*#(\d{4,9})/i);
    if (headMatch) return headMatch[1];

    // Last resort: any #123456-style token near the top of the page
    const looseMatch = bodyText.slice(0, 500).match(/#(\d{5,9})\b/);
    if (looseMatch) return looseMatch[1];

    return null;
  }

  function getCity() {
    const cityEl = document.getElementById('select2-tour_transfer_welcome_city_id-container');
    if (!cityEl) return null;
    return (cityEl.getAttribute('title') || cityEl.textContent || '')
      .replace(/[×✕]/g, '')
      .trim() || null;
  }

  // The Google Sheet web app is on another site, so the request goes
  // through background.js (like GM_xmlhttpRequest did).
  function apiRequest(method, params, body) {
    return new Promise((resolve, reject) => {
      let url = SHEET_WEBAPP_URL;
      if (params) {
        const qs = new URLSearchParams(params).toString();
        url += (url.includes('?') ? '&' : '?') + qs;
      }
      try {
        chrome.runtime.sendMessage({ type: 'WP_TOUR_SHEET', method, url, body: body ? JSON.stringify(body) : '' }, (reply) => {
          if (chrome.runtime.lastError || !reply || !reply.ok) { reject(new Error(chrome.runtime.lastError?.message || reply?.error || 'no answer')); return; }
          try { resolve(JSON.parse(reply.text)); }
          catch (e) { reject(e); }
        });
      } catch (e) { reject(e); }
    });
  }

  // Welcome Pickups brand palette (see welcome-branding skill)
  const BRAND = {
    graphite: '#2E3B4D',
    turquoise: '#58C3BF',
    emerald: '#57BE8C',
    paleYellow: '#F8CF66',
    bg: '#F7F9FB',
    border: '#E4E8EE',
    font: '"Montserrat", "Helvetica Neue", Arial, -apple-system, BlinkMacSystemFont, sans-serif'
  };

  function findInsertionPoint() {
    // Preferred spot: right after the "DRIVER NOTE" field, found by its
    // visible label text (avoids depending on exact CSS classes, which
    // can shift, and works even with browser extensions injecting overlays).
    const labelEl = Array.from(document.querySelectorAll('label, dt, th, strong, b'))
      .find(el => /^\s*driver note\s*$/i.test(el.textContent || ''));
    if (labelEl) {
      // Walk up to the block that wraps this whole field (label + input together)
      let fieldWrapper = labelEl.closest('li, .input, .field, div');
      if (fieldWrapper && fieldWrapper.parentElement) {
        return { mode: 'after', target: fieldWrapper };
      }
    }

    // Fallback 1: the sidebar column, directly above the "Resend ..." buttons
    const resendEl = Array.from(document.querySelectorAll('a, button, input[type="submit"]'))
      .find(el => /resend/i.test(el.textContent || el.value || ''));
    if (resendEl) {
      const btnContainer = resendEl.closest('div') || resendEl.parentElement;
      if (btnContainer && btnContainer.parentElement) {
        return { mode: 'before', target: btnContainer };
      }
    }

    // Fallback 2: right below the "Back to Index" link
    const links = Array.from(document.querySelectorAll('a'));
    const backLink = links.find(a => /back to index/i.test(a.textContent || ''));
    if (backLink) {
      const container = backLink.closest('div, header, section') || backLink.parentElement;
      return { mode: 'after', target: container };
    }

    return null;
  }

  function buildNotepad(orderId) {
    const card = document.createElement('div');
    card.id = 'liveops-note-card';
    Object.assign(card.style, {
      fontFamily: BRAND.font, background: BRAND.bg, border: `1px solid ${BRAND.border}`,
      borderRadius: '8px', margin: '0 0 16px 0', overflow: 'hidden', width: '100%',
      boxSizing: 'border-box'
    });

    // --- header (click to collapse/expand) ---
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 14px', cursor: 'pointer', userSelect: 'none',
      borderBottom: `1px solid ${BRAND.border}`
    });

    const title = document.createElement('span');
    title.textContent = `📋 LiveOps Notes — Order #${orderId}`;
    Object.assign(title.style, { color: BRAND.graphite, fontWeight: '700', fontSize: '14px' });

    const noteDot = document.createElement('span');
    Object.assign(noteDot.style, {
      display: 'none', width: '8px', height: '8px', borderRadius: '50%',
      background: BRAND.paleYellow, marginLeft: '8px'
    });
    title.appendChild(noteDot);

    const chevron = document.createElement('span');
    chevron.textContent = '▾';
    chevron.style.color = BRAND.graphite;

    // --- EM Project city info: hover icon + card ---
    const cityInfoIcon = document.createElement('span');
    cityInfoIcon.textContent = 'EM Project Instructions';
    Object.assign(cityInfoIcon.style, {
      marginLeft: '10px', cursor: 'help', position: 'relative', display: 'inline-block',
      background: BRAND.paleYellow, color: BRAND.graphite, fontWeight: '700',
      fontSize: '11px', padding: '3px 10px', borderRadius: '999px'
    });
    cityInfoIcon.addEventListener('click', (e) => e.stopPropagation()); // don't collapse the header

    const cityTooltip = document.createElement('div');
    Object.assign(cityTooltip.style, {
      display: 'none', position: 'absolute', top: '20px', left: '0',
      background: '#fff', border: `1px solid ${BRAND.border}`, borderRadius: '8px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)', padding: '10px 12px', width: '260px',
      zIndex: 999999, fontSize: '12px', color: BRAND.graphite, fontFamily: BRAND.font,
      cursor: 'default'
    });
    cityInfoIcon.appendChild(cityTooltip);
    title.appendChild(cityInfoIcon);

    // --- Copy tour info button (only shown on tour pages) ---
    const copyTourBtn = document.createElement('span');
    copyTourBtn.id = 'liveops-copy-tour-btn';
    copyTourBtn.textContent = '📄 Copy tour info';
    Object.assign(copyTourBtn.style, {
      marginLeft: '8px', cursor: 'pointer', display: 'none',
      background: BRAND.turquoise, color: BRAND.graphite, fontWeight: '700',
      fontSize: '11px', padding: '3px 10px', borderRadius: '999px'
    });
    copyTourBtn.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't collapse the header
      const reset = () => setTimeout(() => { copyTourBtn.textContent = '📄 Copy tour info'; }, 5000);
      copyTourBtn.textContent = 'Collecting…';
      try {
        const summary = await buildTourSummary();
        if (!summary) {
          copyTourBtn.textContent = '⚠ Tour info not found';
          return reset();
        }
        await copyToClipboard(summary.text);
        const missingNote = summary.missing.length ? ` (no ${summary.missing.join(' / ')})` : '';

        // Open the city's S-rides WhatsApp group
        const group = await findSridesGroup(summary.city);
        if (group.status === 'ok' && await openSridesGroup(group, summary.text)) {
          copyTourBtn.textContent = `Copied ✓ → ${group.title || 'S-rides ' + group.city}${missingNote}`;
        } else if (group.status === 'not-synced') {
          copyTourBtn.textContent = `Copied ✓${missingNote} — open the WhatsApp groups page once to sync`;
          openInTab(WA_GROUPS_PAGE_URL);
        } else {
          copyTourBtn.textContent = `Copied ✓${missingNote} — no S-rides group for ${summary.city || 'this city'}`;
        }
      } catch (err) {
        console.log('[ghas tours] Copy tour info failed:', err);
        copyTourBtn.textContent = '⚠ Copy failed';
      }
      reset();
    });
    title.appendChild(copyTourBtn);

    // 1.7.298: Send to drivers (the city's "available for tours" drivers)
    const tourDriversBtn = document.createElement('span');
    tourDriversBtn.id = 'liveops-tour-drivers-btn';
    tourDriversBtn.textContent = 'Send to group + drivers';
    Object.assign(tourDriversBtn.style, {
      marginLeft: '8px', cursor: 'pointer', display: 'none',
      background: BRAND.emerald, color: BRAND.graphite, fontWeight: '700',
      fontSize: '11px', padding: '3px 10px', borderRadius: '999px'
    });
    tourDriversBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sendTourAll(header, loadTasks); // 1.7.301: note, group, drivers in one press
    });
    title.appendChild(tourDriversBtn);

    function renderCityInfo(data, city) {
      cityTooltip.innerHTML = '';
      const titleEl = document.createElement('div');
      titleEl.textContent = city || 'City info';
      Object.assign(titleEl.style, { fontWeight: '700', marginBottom: '6px' });
      cityTooltip.appendChild(titleEl);

      if (!data || !data.found) {
        const none = document.createElement('div');
        none.textContent = city ? 'No EM Project data for this city.' : 'Could not find the city on this page.';
        none.style.color = '#595959';
        cityTooltip.appendChild(none);
        return;
      }

      [['City Owner', data.cityOwner], ['Hero Driver', data.heroDriver], ['Notes', data.notes]]
        .forEach(([label, value]) => {
          const rowEl = document.createElement('div');
          rowEl.style.marginTop = '4px';
          const labelEl2 = document.createElement('span');
          labelEl2.textContent = label + ': ';
          labelEl2.style.fontWeight = '700';
          const valueEl = document.createElement('span');
          valueEl.textContent = value || '—';
          rowEl.appendChild(labelEl2);
          rowEl.appendChild(valueEl);
          cityTooltip.appendChild(rowEl);
        });
    }

    let cityInfoLoaded = false;
    cityInfoIcon.addEventListener('mouseenter', () => {
      cityTooltip.style.display = 'block';
      if (cityInfoLoaded) return;

      const city = getCity();
      if (!city) { renderCityInfo(null, null); return; }

      cityTooltip.innerHTML = '';
      const loading = document.createElement('div');
      loading.textContent = 'Loading city info...';
      cityTooltip.appendChild(loading);

      apiRequest('GET', { action: 'cityInfo', city })
        .then((res) => { cityInfoLoaded = true; renderCityInfo(res, city); })
        .catch(() => {
          cityTooltip.innerHTML = '';
          const err = document.createElement('div');
          err.textContent = 'Could not load city info.';
          cityTooltip.appendChild(err);
        });
    });
    cityInfoIcon.addEventListener('mouseleave', () => { cityTooltip.style.display = 'none'; });

    header.appendChild(title);
    header.appendChild(chevron);

    // --- body: task list + always-visible add row ---
    const body = document.createElement('div');
    Object.assign(body.style, { padding: '12px 14px' });

    const listEl = document.createElement('div');
    Object.assign(listEl.style, { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '10px' });

    const loadingMsg = document.createElement('div');
    loadingMsg.textContent = 'Loading notes...';
    Object.assign(loadingMsg.style, { fontSize: '12px', color: '#595959' });
    listEl.appendChild(loadingMsg);

    // --- persistent add-note row (always at the bottom) ---
    const addRow = document.createElement('div');
    Object.assign(addRow.style, { borderTop: `1px solid ${BRAND.border}`, paddingTop: '10px' });

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Type a new LiveOps note...';
    Object.assign(textarea.style, {
      width: '100%', minHeight: '60px', border: `1px solid ${BRAND.border}`,
      borderRadius: '6px', padding: '8px 10px', fontSize: '13px',
      fontFamily: BRAND.font, color: BRAND.graphite, resize: 'vertical',
      boxSizing: 'border-box', outline: 'none', background: '#fff'
    });

    const addFooter = document.createElement('div');
    Object.assign(addFooter.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '8px'
    });

    const status = document.createElement('span');
    status.textContent = '';
    Object.assign(status.style, { fontSize: '12px', color: '#595959' });

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save note';
    Object.assign(saveBtn.style, {
      background: BRAND.emerald, color: BRAND.graphite, border: 'none',
      borderRadius: '6px', padding: '7px 16px', fontSize: '13px',
      fontWeight: '700', fontFamily: BRAND.font, cursor: 'pointer'
    });

    // --- quick-add dropdown: picking an option adds that line to the note ---
    const QUICK_NOTES = [
      'Sent to bc and group',
      'Sent to bc, group and individuals'
    ];
    const quickSelect = document.createElement('select');
    Object.assign(quickSelect.style, {
      border: `1px solid ${BRAND.border}`, borderRadius: '6px', padding: '6px 8px',
      fontSize: '12px', fontFamily: BRAND.font, color: BRAND.graphite,
      background: '#fff', cursor: 'pointer', maxWidth: '240px'
    });
    const placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = '+ Quick add…';
    quickSelect.appendChild(placeholderOpt);
    QUICK_NOTES.forEach(text => {
      const opt = document.createElement('option');
      opt.value = text;
      opt.textContent = text;
      quickSelect.appendChild(opt);
    });
    quickSelect.addEventListener('change', () => {
      const text = quickSelect.value;
      if (!text) return;
      const current = textarea.value.replace(/\s+$/, '');
      textarea.value = current ? `${current}\n\n${text}` : text;
      quickSelect.value = ''; // back to the placeholder so it can be picked again
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    });

    const footerLeft = document.createElement('div');
    Object.assign(footerLeft.style, { display: 'flex', alignItems: 'center', gap: '10px' });
    footerLeft.appendChild(quickSelect);
    footerLeft.appendChild(status);

    addFooter.appendChild(footerLeft);
    addFooter.appendChild(saveBtn);
    addRow.appendChild(textarea);
    addRow.appendChild(addFooter);

    body.appendChild(listEl);
    body.appendChild(addRow);
    card.appendChild(header);
    card.appendChild(body);

    // --- insert into the page ---
    const anchor = findInsertionPoint();
    if (anchor && anchor.mode === 'before' && anchor.target && anchor.target.parentElement) {
      anchor.target.parentElement.insertBefore(card, anchor.target);
    } else if (anchor && anchor.mode === 'after' && anchor.target && anchor.target.parentElement) {
      anchor.target.parentElement.insertBefore(card, anchor.target.nextSibling);
    } else {
      document.body.prepend(card);
    }

    // --- collapse/expand ---
    header.addEventListener('click', () => {
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'block' : 'none';
      chevron.textContent = collapsed ? '▾' : '▸';
    });

    // --- render one task row ---
    function renderTask(task) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex', alignItems: 'flex-start', gap: '8px',
        background: '#fff', border: `1px solid ${BRAND.border}`,
        borderRadius: '6px', padding: '8px 10px'
      });

      const textWrap = document.createElement('div');
      Object.assign(textWrap.style, { flex: '1', minWidth: '0' });

      const noteText = document.createElement('div');
      noteText.textContent = task.note;
      Object.assign(noteText.style, { fontSize: '13px', color: BRAND.graphite, whiteSpace: 'pre-wrap', wordBreak: 'break-word' });

      const meta = document.createElement('div');
      meta.textContent = `${task.timestamp || ''}${task.timestamp && task.author ? ' — ' : ''}${task.author || ''}`;
      Object.assign(meta.style, { fontSize: '11px', color: '#8a8f98', marginTop: '4px' });

      textWrap.appendChild(noteText);
      textWrap.appendChild(meta);

      const deleteBtn = document.createElement('span');
      deleteBtn.textContent = '✕';
      Object.assign(deleteBtn.style, {
        color: '#E05252', cursor: 'pointer', fontWeight: '700', fontSize: '13px', flexShrink: '0'
      });
      deleteBtn.addEventListener('click', () => {
        deleteBtn.textContent = '…';
        apiRequest('POST', null, { action: 'delete', id: task.id })
          .then((res) => { if (res && res.ok) row.remove(); })
          .catch(() => { deleteBtn.textContent = '✕'; });
      });

      row.appendChild(textWrap);
      row.appendChild(deleteBtn);
      return row;
    }

    // --- load existing tasks ---
    function loadTasks() {
      apiRequest('GET', { action: 'list', orderId })
        .then((res) => {
          listEl.innerHTML = '';
          const tasks = (res && res.tasks) || [];
          if (!tasks.length) {
            noteDot.style.display = 'none';
            const empty = document.createElement('div');
            empty.textContent = 'No notes yet';
            Object.assign(empty.style, { fontSize: '12px', color: '#595959' });
            listEl.appendChild(empty);
            return;
          }
          noteDot.style.display = 'inline-block';
          tasks.forEach(task => listEl.appendChild(renderTask(task)));
        })
        .catch(() => {
          listEl.innerHTML = '';
          const err = document.createElement('div');
          err.textContent = 'Could not load (check Web App URL)';
          Object.assign(err.style, { fontSize: '12px', color: '#595959' });
          listEl.appendChild(err);
        });
    }

    loadTasks();

    // --- add a new note (always appends, never overwrites) ---
    saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const note = textarea.value.trim();
      if (!note) return;
      status.textContent = 'Saving...';
      apiRequest('POST', null, { action: 'add', orderId, note, author: AUTHOR_NAME })
        .then(() => {
          textarea.value = '';
          status.textContent = 'Saved ✓ ' + new Date().toLocaleTimeString();
          loadTasks();
        })
        .catch(() => { status.textContent = 'Save failed — check Web App URL'; });
    });
  }

  function initNotepad() {
    const orderId = getOrderId();
    if (!orderId) {
      console.log('[ghas tours] Notepad: no order ID found on this page.');
      return;
    }
    buildNotepad(orderId);

    // The "Resend..." buttons can render slightly after initial page load.
    // Keep checking for a few seconds and relocate the card once they appear.
    let attempts = 0;
    const relocate = setInterval(() => {
      attempts++;
      const anchor = findInsertionPoint();
      if (anchor && anchor.mode === 'before' && anchor.target && anchor.target.parentElement) {
        const card = document.getElementById('liveops-note-card');
        if (card) {
          anchor.target.parentElement.insertBefore(card, anchor.target);
        }
        clearInterval(relocate);
      }
      if (attempts >= 10) clearInterval(relocate); // stop after ~5 seconds
    }, 500);

    // Show the "Copy tour info" button only on tour pages (the Hailing
    // header line may render late, so keep checking for ~10 seconds).
    let tourChecks = 0;
    const tourCheck = setInterval(() => {
      tourChecks++;
      const btn = document.getElementById('liveops-copy-tour-btn');
      if (btn && getTourInfo()) {
        btn.style.display = 'inline-block';
        const driversBtn = document.getElementById('liveops-tour-drivers-btn'); // 1.7.298
        if (driversBtn) driversBtn.style.display = 'inline-block';
        getTourDetailsDoc(); // pre-fetch so the copy is instant
        clearInterval(tourCheck);
      }
      if (tourChecks >= 20) clearInterval(tourCheck);
    }, 500);
  }

  // ============================================================
  // 1.7.298: TOUR DRIVERS — "Send to drivers" on a tour transfer
  // ============================================================
  // The CRM's drivers list (/admin/drivers) filtered by city has an
  // "available for tours" part. mod reads that list (read-only GET) and
  // messages each driver through WhatsApp Web, one at a time.
  // The list address is learned on the drivers page ("use this list for
  // tour drivers"); until then mod guesses it from the page's filters.
  const TOUR_DRIVERS_PATH_KEY = 'wp_tour_drivers_path_v1';  // { search, cityParam, savedAt }
  const TOUR_DRIVERS_SENT_KEY = 'wp_tour_drivers_sent_v1';  // { orderId: { phone: at } }
  const TOUR_WORD = /tour/i;

  function driverIdFromHref(href) {
    const m = String(href || '').match(/\/admin\/drivers\/(\d+)\/?(?:[?#]|$)/);
    return m ? m[1] : '';
  }

  function phoneDigits(raw) {
    let d = String(raw || '').replace(/[^\d+]/g, '');
    if (d.startsWith('+')) d = d.slice(1);
    else if (d.startsWith('00')) d = d.slice(2);
    d = d.replace(/\D/g, '');
    return /^\d{8,15}$/.test(d) ? d : '';
  }

  function phoneFrom(el) {
    if (!el) return '';
    const link = el.querySelector('a[href^="tel:"], a[href*="wa.me/"], a[href*="whatsapp.com/send"]');
    if (link) {
      const href = link.getAttribute('href') || '';
      const m = href.match(/phone=(\d+)/) || href.match(/wa\.me\/(\d+)/);
      const p = phoneDigits(m ? m[1] : href.replace(/^tel:/, ''));
      if (p) return p;
    }
    const texts = (el.textContent || '').match(/(?:\+|00)?\d[\d\s().-]{6,}\d/g) || [];
    for (const t of texts) { const p = phoneDigits(t); if (p) return p; }
    return '';
  }

  // The drivers' rows: inside an "available for tours" section when the page
  // has one; in a table with a "tour" column, only rows that say yes there.
  function parseTourDrivers(doc) {
    let root = doc;
    const heading = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, legend, .panel > h3, caption'))
      .find(el => /available\s*(for\s*)?tours?/i.test(el.textContent || ''));
    if (heading) root = heading.closest('.panel, section, fieldset, table') || heading.parentElement || doc;
    const out = [];
    const seen = new Set();
    root.querySelectorAll('table').forEach(table => {
      const heads = Array.from(table.querySelectorAll('thead th')).map(th => (th.textContent || '').trim());
      const tourCol = heading ? -1 : heads.findIndex(h => TOUR_WORD.test(h));
      const phoneCol = heads.findIndex(h => /phone|mobile|whats/i.test(h));
      const nameCol = heads.findIndex(h => /name/i.test(h));
      table.querySelectorAll('tbody tr').forEach(tr => {
        const cells = tr.children;
        if (tourCol >= 0) {
          const cell = cells[tourCol];
          const v = (cell && cell.textContent || '').trim();
          const yes = /^(yes|true|y|✓|✔)$/i.test(v) || (cell && cell.querySelector('.status_tag.yes, .yes'));
          if (!yes) return;
        }
        const link = Array.from(tr.querySelectorAll('a[href]')).find(a => driverIdFromHref(a.getAttribute('href')));
        const id = link ? driverIdFromHref(link.getAttribute('href')) : '';
        let name = nameCol >= 0 && cells[nameCol] ? cells[nameCol].textContent.trim() : '';
        if (!name && link && !/^\s*(view|edit|\d+)\s*$/i.test(link.textContent)) name = link.textContent.trim();
        const phone = phoneFrom(phoneCol >= 0 ? cells[phoneCol] : tr) || phoneFrom(tr);
        const key = id || phone;
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push({ id, name: name.replace(/\s+/g, ' ').slice(0, 60) || ('Driver ' + id), phone });
      });
    });
    return out;
  }

  // Phone from a driver's own page (when the list has none)
  async function fetchDriverPhone(id) {
    try {
      const doc = await fetchDoc('/admin/drivers/' + id);
      const row = Array.from(doc.querySelectorAll('tr, li, .row'))
        .find(r => /phone|mobile|whats/i.test((r.querySelector('th, label') || {}).textContent || ''));
      return phoneFrom(row ? (row.querySelector('td') || row) : null);
    } catch (e) { return ''; }
  }

  // City id: the drivers filter's own option first, else the transfer's city select
  function cityIdFrom(doc, param, city) {
    const sel = doc && param ? doc.querySelector(`select[name="${CSS.escape(param)}"]`) : null;
    if (sel) {
      const opt = Array.from(sel.options).find(o => o.value && normCity(o.textContent) === normCity(city));
      if (opt) return opt.value;
    }
    const own = document.getElementById('tour_transfer_welcome_city_id');
    return own && own.value ? own.value : '';
  }

  async function tourDriversUrl(city) {
    const saved = await storeGet(TOUR_DRIVERS_PATH_KEY, null);
    const base = await fetchDoc('/admin/drivers');
    let params;
    let cityParam;
    if (saved && saved.search && saved.cityParam) {
      params = new URLSearchParams(saved.search);
      cityParam = saved.cityParam;
    } else {
      // Guess: the filter whose name says "city" + a scope / tab saying "tour"
      const sel = Array.from(base.querySelectorAll('form select[name]')).find(s => /city/i.test(s.name));
      if (!sel) throw new Error('no city filter found on the drivers page');
      cityParam = sel.name;
      params = new URLSearchParams();
    }
    // 1.7.299: always the "Available For Tours" scope button (a saved list on
    // "All" read every driver of the city)
    if (!TOUR_WORD.test(params.get('scope') || '')) {
      const scope = Array.from(base.querySelectorAll('.scopes a, .table_tools a, a[href*="scope="]'))
        .find(a => /available\s*for\s*tours?/i.test(a.textContent || '')) ||
        Array.from(base.querySelectorAll('a[href*="scope="]')).find(a => TOUR_WORD.test(a.getAttribute('href') + ' ' + a.textContent));
      if (!scope) throw new Error('no "Available For Tours" button found on the drivers page');
      const scopeValue = new URL(scope.getAttribute('href'), location.origin).searchParams.get('scope');
      if (!scopeValue) throw new Error('the "Available For Tours" button has no scope');
      params.set('scope', scopeValue);
    }
    const id = cityIdFrom(base, cityParam, city);
    if (!id) throw new Error('city "' + city + '" not found in the drivers filter');
    params.set(cityParam, id);
    if (!params.has('per_page')) params.set('per_page', '200');
    params.delete('page');
    return '/admin/drivers?' + params.toString();
  }

  async function findTourDrivers(city) {
    const url = await tourDriversUrl(city);
    const doc = await fetchDoc(url);
    const drivers = parseTourDrivers(doc).slice(0, 40);
    for (const d of drivers) if (!d.phone && d.id) d.phone = await fetchDriverPhone(d.id);
    return { url, drivers };
  }

  // One WhatsApp Web job, waits for its result (like mod's hero sends)
  const tourWaWaiters = {};
  let tourWaListening = false;
  function tourWaSend(phone, label, text, extra) {
    if (!tourWaListening) {
      tourWaListening = true;
      chrome.runtime.onMessage.addListener((m) => {
        if (!m || m.type !== 'WP_WA_RESULT' || m.progress) return;
        const w = tourWaWaiters[m.jobId];
        if (w) { delete tourWaWaiters[m.jobId]; w(m); }
      });
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type: 'WP_WA_SEND', city: label, phone, text, label }, extra || {}), (r) => {
          if (chrome.runtime.lastError || !r || !r.ok) {
            resolve({ ok: false, info: chrome.runtime.lastError?.message || r?.error || 'no answer — refresh this tab (F5)' });
            return;
          }
          const timer = setTimeout(() => { delete tourWaWaiters[r.jobId]; resolve({ ok: false, info: 'no answer from WhatsApp Web in 90s' }); }, 90000);
          tourWaWaiters[r.jobId] = (m) => { clearTimeout(timer); resolve(m); };
        });
      } catch (e) { resolve({ ok: false, info: String(e && e.message || e) }); }
    });
  }

  function buildTourDriversPanel(anchor) {
    let panel = document.getElementById('wp-tour-drivers-panel');
    if (panel) { panel.remove(); return null; }
    panel = document.createElement('div');
    panel.id = 'wp-tour-drivers-panel';
    Object.assign(panel.style, {
      margin: '8px 0', padding: '10px 12px', borderRadius: '8px', background: BRAND.bg,
      border: `1px solid ${BRAND.border}`, color: BRAND.graphite, fontFamily: BRAND.font,
      fontSize: '12px', fontWeight: '400', cursor: 'default', textTransform: 'none'
    });
    panel.addEventListener('click', e => e.stopPropagation());
    anchor.insertAdjacentElement('afterend', panel);
    return panel;
  }

  // 1.7.301: one press — LiveOps note "Sent to bc, group and individuals",
  // then the city's S-rides group, then each "available for tours" driver
  // (drivers already messaged for this order are skipped).
  const TOUR_SENT_NOTE = 'Sent to bc, group and individuals';
  let tourSendRunning = false;
  async function sendTourAll(anchor, afterNote) {
    if (tourSendRunning) return; // a press while it runs does nothing
    tourSendRunning = true;
    try { await sendTourAllRun(anchor, afterNote); } finally { tourSendRunning = false; }
  }
  async function sendTourAllRun(anchor, afterNote) {
    const panel = buildTourDriversPanel(anchor);
    if (!panel) return;
    const log = (line) => {
      const div = document.createElement('div');
      div.textContent = line;
      panel.appendChild(div);
      return div;
    };
    panel.textContent = '';
    const orderId = getOrderId() || '';
    let summary;
    let found;
    const reading = log('Reading the tour info and the drivers list…');
    try {
      summary = await buildTourSummary();
      if (!summary) { reading.textContent = 'Tour info not found on this page — nothing sent.'; return; }
      if (!summary.city) { reading.textContent = 'No city on this transfer — nothing sent.'; return; }
      found = await findTourDrivers(summary.city);
    } catch (e) {
      reading.textContent = 'Could not read the tour drivers: ' + (e && e.message || e) + ' — nothing sent.';
      return;
    }
    reading.textContent = '';
    const listLink = document.createElement('a');
    listLink.href = found.url; listLink.target = '_blank'; listLink.textContent = 'list';
    reading.append(`${found.drivers.length} tour driver(s) in ${summary.city} (`, listLink, ')');
    const driverText = summary.text.replace(/^Hey team! Anyone available for this tour\?/, 'Hi! Are you available for this tour?');

    // 1. the note
    const noteLine = log('Note: saving…');
    try {
      await apiRequest('POST', null, { action: 'add', orderId, note: TOUR_SENT_NOTE, author: AUTHOR_NAME });
      noteLine.textContent = `Note: "${TOUR_SENT_NOTE}" saved`;
      if (afterNote) afterNote();
    } catch (e) {
      noteLine.textContent = 'Note: failed (' + (e && e.message || e) + ') — add it by hand';
    }

    // 2. the group
    const groupLine = log('Group: looking up…');
    const group = await findSridesGroup(summary.city);
    const code = group.status === 'ok' ? (String(group.url || '').match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]+)/) || [])[1] : '';
    if (code) {
      const name = group.title || 'S-rides ' + group.city;
      groupLine.textContent = `Group: sending to ${name}…`;
      const res = await tourWaSend('', name, summary.text, { city: group.city || summary.city, code, expect: [group.city || summary.city] });
      groupLine.textContent = `Group: ${name} — ` + (res.ok ? 'sent' : 'failed: ' + (res.info || ''));
    } else if (group.status === 'not-synced') {
      groupLine.textContent = 'Group: not sent — open the WhatsApp groups page once to sync';
      openInTab(WA_GROUPS_PAGE_URL);
    } else {
      groupLine.textContent = `Group: not sent — no S-rides group for ${summary.city}`;
    }

    // 3. the drivers, one at a time
    const sentAll = await storeGet(TOUR_DRIVERS_SENT_KEY, {});
    const sent = sentAll[orderId] || {};
    for (const d of found.drivers) {
      const line = log(d.name + (d.phone ? ' (…' + d.phone.slice(-4) + ')' : '') + ': ');
      if (!d.phone) { line.textContent += 'no phone'; continue; }
      if (sent[d.phone]) { line.textContent += 'already sent ' + new Date(sent[d.phone]).toLocaleTimeString().slice(0, 5); continue; }
      const base = line.textContent;
      line.textContent = base + 'sending…';
      const res = await tourWaSend(d.phone, d.name, driverText);
      line.textContent = base + (res.ok ? 'sent' : 'failed: ' + (res.info || ''));
      if (res.ok) {
        const all = await storeGet(TOUR_DRIVERS_SENT_KEY, {});
        (all[orderId] = all[orderId] || {})[d.phone] = Date.now();
        const keys = Object.keys(all);
        if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(k => delete all[k]);
        await storeSet(TOUR_DRIVERS_SENT_KEY, all);
      }
    }
    log('Done.');
  }

  // On the drivers list: remember the filtered address (the city in it is
  // swapped for each tour's city)
  function initDriversPageLearner() {
    const chip = document.createElement('div');
    chip.textContent = 'ghas: use this list for tour drivers';
    Object.assign(chip.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: 999999, padding: '6px 12px',
      borderRadius: '999px', background: 'rgba(20,24,28,0.85)', color: '#8fffd5',
      font: '12px Consolas, monospace', cursor: 'pointer', backdropFilter: 'blur(6px)'
    });
    chip.addEventListener('click', async () => {
      const params = new URLSearchParams(location.search);
      const cityParam = Array.from(params.keys()).find(k => /city/i.test(k) && params.get(k));
      if (!cityParam) { chip.textContent = 'ghas: filter a city first, then click again'; return; }
      const found = parseTourDrivers(document);
      params.delete('page');
      await storeSet(TOUR_DRIVERS_PATH_KEY, { search: params.toString(), cityParam, savedAt: Date.now() });
      chip.textContent = `ghas: saved — ${found.length} tour driver(s) read on this page`;
    });
    document.body.appendChild(chip);
  }

  // ============================================================
  // ROUTER
  // ============================================================
  if (location.hostname.endsWith('atlassian.net')) {
    if (location.pathname.includes(`/pages/${WA_GROUPS_PAGE_ID}`)) syncSridesFromConfluence();
    return;
  }

  // 1.7.298: the drivers list (not a driver's own page)
  if (/^\/admin\/drivers\/?$/.test(location.pathname)) { initDriversPageLearner(); return; }

  const isIndexPage = /tour_transfers\/index_v2/.test(location.href);
  if (isIndexPage) {
    initIndexHighlighter();
  } else {
    initNotepad();
  }
})();
