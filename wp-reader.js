// 1.7.517: the background CRM reader (step 2 of "box = reader + WhatsApp").
// It reads the Em Hailing list from the CRM's own HTML (fetched, never the page on screen)
// and returns one short row per transfer, in the same fields as the tablet list
// (wpRemoteList in content.js): id, d (today / tomorrow / later), l (order #), c (city),
// p (partner), m (minutes to pickup), a (A/C minutes or null), w (date text), n (1 = no
// last transfer task). It needs only fetch + DOMParser, so it can later run off the CRM page
// (offscreen document) unchanged. Traveler, From / To and Driver are not read.
(function() {
    'use strict';
    if (self.wpReader) return;
    const LIST_URL = 'https://crm.welcomepickups.com/admin/transfers/index_v2?em_hailing=true&em_hailing_period=today_tomorrow&filters%5Bcity%5D=all&filters%5Bdate%5D=';
    const clean = function(value, max) {
        const text = String(value || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
        return max && text.length > max ? text.slice(0, max - 1) + '…' : text;
    };
    // "2h 15m", "1d 3h" -> minutes (as parseTBO in content.js)
    const minutesOf = function(text, withDays) {
        const lower = clean(text).replace(/^EmNad\s*/i, '').toLowerCase();
        const d = withDays ? lower.match(/(\d+)\s*d/) : null;
        const h = lower.match(/(\d+)\s*h/);
        const m = lower.match(/(\d+)\s*m/);
        if (!d && !h && !m) return null;
        return (d ? Number(d[1]) * 1440 : 0) + (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
    };
    // The pickup day from the DateTime text (as wpRowPickupDay in content.js); '' when it cannot tell.
    const dayOf = function(text, now) {
        text = clean(text);
        if (/^today\b/i.test(text)) return 'today';
        if (/^tomorrow\b/i.test(text)) return 'tomorrow';
        const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const named = text.match(/(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/);
        const numeric = text.match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/);
        let date = null;
        if (named && months.indexOf(named[2].slice(0, 3).toLowerCase()) >= 0) date = new Date(Number(named[3]), months.indexOf(named[2].slice(0, 3).toLowerCase()), Number(named[1]));
        else if (numeric) date = new Date(Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1]));
        if (!date || isNaN(date.getTime())) return '';
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        if (date.toDateString() === today.toDateString()) return 'today';
        if (date.toDateString() === tomorrow.toDateString()) return 'tomorrow';
        return 'later';
    };
    // Parse the list page's HTML. Returns { rows, tables, problems }.
    function parse(html, now) {
        now = now || new Date();
        const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
        const rows = [];
        const els = {}; // 1.7.518: id -> the parsed <tr>, for the extra columns worked out in content.js
        const seen = {};
        const problems = [];
        const headings = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, legend, caption'))
            .filter(function(node) { return /^\s*Em Hailing\s*[-–]\s*(Today|Tomorrow|Later)\b/i.test(node.textContent || ''); });
        const tables = Array.from(doc.querySelectorAll('table.transfers'));
        tables.forEach(function(table, n) {
            // the heading right before this table says which list it is (fallback for the day)
            let listDay = '';
            headings.forEach(function(heading) {
                if (heading.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) {
                    const m = String(heading.textContent).match(/(Today|Tomorrow|Later)/i);
                    if (m) listDay = m[1].toLowerCase();
                }
            });
            const headRow = table.querySelector('thead tr') || table.querySelector('tr');
            const names = headRow ? Array.from(headRow.children).map(function(cell) { return clean(cell.textContent).toLowerCase(); }) : [];
            const col = function(name) { return names.indexOf(name); };
            const at = { city: col('city'), tbo: col('tbo'), order: col('order#'), partner: col('partner'), date: col('datetime'), task: col('last transfer task'), ac: col('autocancel') };
            ['city', 'tbo', 'order', 'partner', 'date', 'task', 'ac'].forEach(function(key) { if (at[key] < 0) problems.push('table ' + (n + 1) + ': no ' + key + ' column'); });
            table.querySelectorAll(':scope > tbody > tr').forEach(function(tr) {
                const cells = Array.from(tr.children).filter(function(cell) { return cell.tagName === 'TD'; });
                if (!cells.length) return;
                const cell = function(index) { return index >= 0 ? cells[index] || null : null; };
                const link = (cell(at.order) && cell(at.order).querySelector('a[href*="/admin/transfers/"]')) || tr.querySelector('a[href*="/admin/transfers/"]');
                const id = link ? (String(link.getAttribute('href') || '').match(/\/admin\/transfers\/(\d+)/) || [])[1] || '' : '';
                if (!id || seen[id]) return;
                seen[id] = true;
                const dateText = cell(at.date) ? (cell(at.date).getAttribute('title') || cell(at.date).textContent) : '';
                const acCell = cell(at.ac);
                const task = cell(at.task) ? clean(cell(at.task).textContent).replace(/^\[(?:Task|Refund)\]\s*/i, '') : null;
                els[id] = tr;
                rows.push({
                    id: id,
                    d: dayOf(dateText, now) || listDay || 'today',
                    l: clean(link.textContent, 24) || '#' + id,
                    c: clean(cell(at.city) ? cell(at.city).textContent : '', 30),
                    p: clean(cell(at.partner) ? cell(at.partner).textContent : '', 24),
                    m: cell(at.tbo) ? minutesOf(cell(at.tbo).textContent, true) : null,
                    a: acCell ? minutesOf(acCell.textContent, false) : null,
                    w: clean(cell(at.date) ? cell(at.date).textContent : '', 40).replace(/\s*\(\d+h\)\s*$/, ''),
                    n: task === null ? null : task ? 0 : 1
                });
            });
        });
        if (!tables.length) problems.push('no transfers table (signed out, or a Cloudflare check?)');
        return { rows: rows, els: els, tables: tables.length, problems: problems };
    }
    // Fetch + parse. Returns { ok, rows, ms, status, problems } (never throws).
    async function read(url) { // 1.7.544: url = another Em Hailing list (2-4 days)
        const started = Date.now();
        try {
            const response = await fetch(url || LIST_URL, { credentials: 'include', cache: 'no-store', headers: { Accept: 'text/html' } });
            const html = await response.text();
            if (!response.ok) return { ok: false, status: response.status, rows: [], ms: Date.now() - started, problems: ['HTTP ' + response.status + (/Just a moment/i.test(html) ? ' (Cloudflare check)' : '')] };
            if (/\/users\/sign_in|accounts\.google\.com/i.test(response.url)) return { ok: false, status: response.status, rows: [], ms: Date.now() - started, problems: ['signed out of the CRM'] };
            const result = parse(html, new Date());
            return { ok: result.tables > 0, status: response.status, rows: result.rows, els: result.els, ms: Date.now() - started, problems: result.problems };
        } catch (error) {
            return { ok: false, status: 0, rows: [], ms: Date.now() - started, problems: [String(error && error.message || error).slice(0, 120)] };
        }
    }
    self.wpReader = { parse: parse, read: read, LIST_URL: LIST_URL, LIST_24: LIST_URL.replace('em_hailing_period=today_tomorrow', 'em_hailing_period=days_2_4') }; // 1.7.544
})();
