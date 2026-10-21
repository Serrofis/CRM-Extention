// mod overview — the big-picture page (1.7.302).
//
// A separate extension page, so nothing here slows the CRM tabs. Everything
// is read-only:
//   - Hub Live Ops: Daily (gap per city and day) and Outlook (loss, lever,
//     owner), read in a background tab that is closed afterwards.
//   - CRM driver availability dashboard: drivers / adj / assigned /
//     unassigned per hour, one city and one week per page (plain GET).
//   - Google Sheets: the events calendar and the EM Project prices tab (CSV).
//   - Slack: #impactful-events, #live_ops_sync, #em_team, read from the
//     channel pages in a background tab (no tokens).
// History is kept in IndexedDB (one record per city and day), so months and
// events can be compared later. overview.html?snapshot=1 (the nightly alarm
// in background.js) reads every city, saves, and closes itself.
(function() {
    'use strict';

    const CRM = 'https://crm.welcomepickups.com';
    const HUB = 'https://ops-intelligence-hub.vercel.app';
    const EVENTS_SHEET = { id: '1EjNGkh3bCE70GT8tv203pEK-8yMly_6N6hrVwDjsCSE', gid: '72433320' };
    const EM_SHEET = { id: '1ngo6jDVs6pUhd0wVdxfG4DRrRKfE3f2CAtc5gBU2W4A', gid: '1488442437' };
    const SLACK_TEAM = 'T02T0CN9Y';
    const SLACK_CHANNELS = [
        { id: 'C076X6733D5', name: 'impactful-events' },
        { id: 'C03Q1S804TS', name: 'live_ops_sync' },
        { id: 'C03NENSV46S', name: 'em_team' }
    ];
    const CACHE_KEY = 'wp_ov_cache_v1';
    const DONE_KEY = 'wp_ov_done_v1';
    const DAYS = 8;            // today + 7
    const TOP_N = 40;          // cities read from the CRM every hour
    const MAX_EVENT_CITIES = 40;
    const CRM_GAP_MS = 1200;   // between CRM page reads
    const REFRESH_MS = 60 * 60 * 1000;
    const params = new URLSearchParams(location.search);
    const SNAPSHOT = params.get('snapshot') === '1';

    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const num = (s) => { const m = String(s == null ? '' : s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
    const pad = (n) => String(n).padStart(2, '0');
    const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); return x; };
    const parseIso = (s) => { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
    const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
    const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

    function today() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
    function windowDates() { const t = today(); const out = []; for (let i = 0; i < DAYS; i++) out.push(iso(addDays(t, i))); return out; }

    // "Mon 2 Nov" (hub, no year) → ISO, the year that puts it nearest today.
    function hubDate(text) {
        const m = String(text || '').match(/(\d{1,2})\s+([A-Za-z]{3})/);
        if (!m || MONTHS[m[2].toLowerCase()] === undefined) return null;
        const t = today();
        let best = null;
        [t.getFullYear() - 1, t.getFullYear(), t.getFullYear() + 1].forEach((y) => {
            const d = new Date(y, MONTHS[m[2].toLowerCase()], Number(m[1]));
            if (!best || Math.abs(d - t) < Math.abs(best - t)) best = d;
        });
        return iso(best);
    }
    // Sheet dates: "1-Jan-2026", "19-Feb-2026", "2026-01-19", "19/02/2026".
    function sheetDate(text) {
        const s = String(text || '').trim();
        let m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/);
        if (m && MONTHS[m[2].toLowerCase()] !== undefined) return iso(new Date(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1])));
        m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) return iso(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
        m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (m) return iso(new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
        return null;
    }

    function parseCsv(text) {
        const rows = []; let row = []; let cell = ''; let q = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (q) {
                if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
                else if (c === '"') q = false;
                else cell += c;
            } else if (c === '"') q = true;
            else if (c === ',') { row.push(cell); cell = ''; }
            else if (c === '\n' || c === '\r') {
                if (c === '\r' && text[i + 1] === '\n') i++;
                row.push(cell); rows.push(row); row = []; cell = '';
            } else cell += c;
        }
        if (cell || row.length) { row.push(cell); rows.push(row); }
        return rows;
    }
    // Header row → index of the first column whose name matches.
    function colFinder(header) {
        const h = header.map((x) => norm(x));
        return (...names) => { for (const n of names) { const i = h.findIndex((x) => x.indexOf(norm(n)) === 0); if (i >= 0) return i; } for (const n of names) { const i = h.findIndex((x) => x.indexOf(norm(n)) >= 0); if (i >= 0) return i; } return -1; };
    }

    // ---- state ----
    let cache = { cities: [], hubDaily: [], hubOutlook: [], crm: {}, events: [], em: [], slack: [], at: {}, errors: {} };
    let selected = null;
    let tab = 'overview';
    let done = {};
    let busy = false;
    let history = [];

    function log(text, bad) {
        const el = $('log');
        const line = new Date().toTimeString().slice(0, 5) + '  ' + text;
        el.innerHTML = '<div' + (bad ? ' class="err"' : '') + '>' + esc(line) + '</div>' + el.innerHTML;
        $('status').textContent = text;
    }
    async function saveCache() { try { await chrome.storage.local.set({ [CACHE_KEY]: cache }); } catch (e) { log('could not save: ' + e.message, true); } }

    // ---- IndexedDB history ----
    function db() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('wp_overview', 1);
            req.onupgradeneeded = () => { const s = req.result.createObjectStore('days', { keyPath: 'k' }); s.createIndex('date', 'date'); };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async function historyPut(records) {
        if (!records.length) return;
        const d = await db();
        await new Promise((resolve, reject) => {
            const tx = d.transaction('days', 'readwrite');
            const s = tx.objectStore('days');
            records.forEach((r) => s.put(r));
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        });
        d.close();
    }
    async function historyAll() {
        const d = await db();
        const all = await new Promise((resolve, reject) => {
            const req = d.transaction('days').objectStore('days').getAll();
            req.onsuccess = () => resolve(req.result || []); req.onerror = () => reject(req.error);
        });
        d.close();
        return all;
    }

    // ---- sources ----
    async function fetchText(url) {
        const res = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
        const text = await res.text();
        return { ok: res.ok, status: res.status, url: res.url, text: text };
    }

    function crmDashUrl(cityId, monday) {
        const q = new URLSearchParams();
        q.set('q[welcome_city_id_eq]', cityId);
        q.set('q[overlay_week_transfers]', monday);
        q.set('q[overlay_week_cancellations]', monday);
        q.set('q[mam_eq]', '1');
        q.set('week_token', monday);
        q.set('commit', 'Filter');
        return CRM + '/admin/driver_availability_dashboard?' + q.toString();
    }
    function crmLoggedOut(r) { return /sign_in|login/i.test(r.url) || !/driver_availability|Driver Availability/i.test(r.text.slice(0, 200000)); }

    // The dashboard page → { cities?, days: { iso: { hours: [{h, drv, adj, as, un, blk}] } } }
    function parseCrmDash(html, monday, wantCities) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const out = { days: {} };
        if (wantCities) {
            const sel = doc.querySelector('select[name="q[welcome_city_id_eq]"]');
            out.cities = sel ? [...sel.options].filter((o) => o.value).map((o) => ({ id: o.value, name: o.textContent.trim() })) : [];
        }
        const table = doc.querySelector('table');
        if (!table) return out;
        const start = parseIso(monday);
        const dates = []; for (let i = 0; i < 7; i++) dates.push(iso(addDays(start, i)));
        dates.forEach((d) => { out.days[d] = { hours: [] }; });
        [...table.querySelectorAll('tbody tr')].forEach((tr) => {
            const hour = (tr.cells[0] && tr.cells[0].textContent.trim()) || '';
            if (!/^\d\d$/.test(hour) || tr.cells.length < 9) return;
            for (let i = 0; i < 7; i++) {
                const td = tr.cells[2 + i];
                if (!td) continue;
                const m = td.textContent.match(/(\d+)\s*•\s*(\d+)\s*adj/);
                const as = td.querySelector('.js-assigned-transfers');
                const un = td.querySelector('.js-unassigned-transfers');
                out.days[dates[i]].hours.push({
                    h: Number(hour), drv: m ? Number(m[1]) : null, adj: m ? Number(m[2]) : null,
                    as: as ? num(as.textContent) || 0 : 0, un: un ? num(un.textContent) || 0 : 0,
                    blk: td.classList.contains('blocked-hour') ? 1 : 0
                });
            }
        });
        return out;
    }
    // One day's hours → the numbers the page uses.
    function dayStats(hours) {
        const s = { as: 0, un: 0, adjPeak: 0, blocked: 0, worst: null, worstHour: null, shortUn: 0 };
        (hours || []).forEach((x) => {
            s.as += x.as; s.un += x.un; s.blocked += x.blk;
            if (x.adj != null && x.adj > s.adjPeak) s.adjPeak = x.adj;
            if (x.un > 0 && x.adj != null) {
                const cov = x.adj / x.un;
                if (s.worst == null || cov < s.worst) { s.worst = Math.round(cov * 10) / 10; s.worstHour = x.h; }
                if (cov < 1) s.shortUn += x.un;
            }
        });
        return s;
    }

    async function readCrmCity(city) {
        const t = today();
        const mondays = [iso(mondayOf(t))];
        if (iso(mondayOf(addDays(t, DAYS - 1))) !== mondays[0]) mondays.push(iso(mondayOf(addDays(t, DAYS - 1))));
        const days = {};
        for (const m of mondays) {
            const r = await fetchText(crmDashUrl(city.id, m));
            if (!r.ok || crmLoggedOut(r)) throw new Error('CRM: not logged in (open the CRM in this Chrome and log in)');
            Object.assign(days, parseCrmDash(r.text, m, false).days);
            await sleep(CRM_GAP_MS);
        }
        const keep = {};
        windowDates().forEach((d) => { if (days[d]) keep[d] = days[d]; });
        cache.crm[city.id] = { at: Date.now(), days: keep };
    }

    async function readCities() {
        const r = await fetchText(crmDashUrl('1', iso(mondayOf(today()))));
        if (!r.ok || crmLoggedOut(r)) throw new Error('CRM: not logged in (open the CRM in this Chrome and log in)');
        const p = parseCrmDash(r.text, iso(mondayOf(today())), true);
        if (p.cities && p.cities.length) cache.cities = p.cities;
    }

    // A page in a background tab: open, run fn there, close.
    async function inTab(url, fn, args, waitMs) {
        const t = await chrome.tabs.create({ url: url, active: false });
        try {
            for (let i = 0; i < 120; i++) {
                const x = await chrome.tabs.get(t.id);
                if (x.status === 'complete') break;
                await sleep(500);
            }
            await sleep(waitMs || 3000);
            const res = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: fn, args: args || [] });
            return res && res[0] ? res[0].result : null;
        } finally {
            try { await chrome.tabs.remove(t.id); } catch (_) {}
        }
    }

    // Runs inside the hub tab. Presses "show more" (only the list's own
    // paging button) until every row is there, then returns the cells.
    async function hubScrape(maxMore) {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 40 && !document.querySelector('table tbody tr'); i++) await wait(500);
        for (let i = 0; i < maxMore; i++) {
            const more = [...document.querySelectorAll('button')].find((b) => /^Showing [\d,]+ of [\d,]+.*show \d+ more/i.test(b.textContent.trim()));
            if (!more) break;
            more.click();
            await wait(900);
        }
        const table = document.querySelector('table');
        if (!table) return { error: /login|sign in/i.test(document.body.innerText.slice(0, 2000)) ? 'hub: not logged in' : 'hub: no table' };
        const head = [...table.querySelectorAll('thead tr:last-child th')].map((h) => h.textContent.replace(/\s+/g, ' ').trim());
        const rows = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim())).filter((r) => r.length > 4);
        return { head: head, rows: rows };
    }

    function matchCity(text) {
        const n = norm(text);
        let best = null;
        cache.cities.forEach((c) => { const k = norm(c.name); if (k && n.indexOf(k) === 0 && (!best || k.length > norm(best.name).length)) best = c; });
        return best;
    }

    async function readHub() {
        const daily = await inTab(HUB + '/crm/live-ops?mode=daily&window=all', hubScrape, [30], 4000);
        if (!daily || daily.error) throw new Error((daily && daily.error) || 'hub: no answer');
        const col = colFinder(daily.head);
        const iDest = col('Destination'), iDate = col('Date'), iGap = col('Transfer Gap'), iLive = col('Live Gap'), iBooked = col('Booked'),
            iFc = col('Forecasttrf'), iGross = col('Gross'), iUn = col('Unassigned'), iNet = col('Net'), iGfs = col('Fwd GFS'), iBlocks = col('Blocks');
        cache.hubDaily = daily.rows.map((r) => {
            const city = matchCity(r[iDest]);
            const gapM = String(r[iGap] || '').match(/(-?\d+)\s*\((\d+)%\)/);
            return {
                city: city ? city.id : null, name: city ? city.name : (r[iDest] || '').replace(/[^A-Za-z .'-].*$/, '').trim(),
                date: hubDate(r[iDate]), gap: gapM ? Number(gapM[1]) : num(r[iGap]), gapPct: gapM ? Number(gapM[2]) : null,
                live: num(r[iLive]), booked: num(r[iBooked]), forecast: iFc >= 0 ? num(r[iFc]) : null, gross: num(r[iGross]),
                un: num(r[iUn]), net: num(r[iNet]), gfs: num(r[iGfs]), blocks: num(r[iBlocks])
            };
        }).filter((x) => x.date);
        const outlook = await inTab(HUB + '/crm/live-ops?mode=outlook&window=all', hubScrape, [0], 4000);
        if (outlook && !outlook.error) {
            const oc = colFinder(outlook.head);
            const oDest = oc('Destination'), oLoss = oc('Loss'), oVs = oc('vs last'), oGfs = oc('proj GFS'), oLever = oc('Top lever'), oOwner = oc('Owner'), oTo = oc('To 93');
            cache.hubOutlook = outlook.rows.map((r) => {
                const city = matchCity(r[oDest]);
                return { city: city ? city.id : null, name: city ? city.name : r[oDest], loss: num(r[oLoss]), vs: r[oVs], gfs: num(r[oGfs]), lever: r[oLever], owner: r[oOwner], to93: num(r[oTo]) };
            });
        }
        cache.at.hub = Date.now();
    }

    async function readSheet(sheet) {
        const base = 'https://docs.google.com/spreadsheets/d/' + sheet.id;
        let r = await fetchText(base + '/gviz/tq?tqx=out:csv&gid=' + sheet.gid);
        if (!r.ok || /^\s*</.test(r.text)) r = await fetchText(base + '/export?format=csv&gid=' + sheet.gid);
        if (!r.ok || /^\s*</.test(r.text)) throw new Error('Google Sheets: could not read the file (is this Chrome signed in to the Google account that can open it?)');
        return parseCsv(r.text);
    }

    async function readEvents() {
        const rows = await readSheet(EVENTS_SHEET);
        const hi = rows.findIndex((r) => r.some((c) => /destination/i.test(c)) && r.some((c) => /from date/i.test(c)));
        if (hi < 0) throw new Error('events sheet: no "Destination / From Date" header');
        const col = colFinder(rows[hi]);
        const c = { dest: col('Destination'), from: col('From Date'), to: col('To date'), name: col('Event Name'), type: col('Event Type'), grav: col('Gravity'), supply: col('Supply Impact'), notes: col('Notes'), alerts: col('City Alerts'), affected: col('LiveOps affected'), tbo: col('Transfers TBO'), dri: col('DRI'), prio: col('Priority'), comments: col('LiveOps Comments') };
        const g = (r, i) => (i >= 0 ? String(r[i] || '').trim() : '');
        cache.events = rows.slice(hi + 1).map((r) => {
            const from = sheetDate(g(r, c.from));
            if (!from || !g(r, c.dest)) return null;
            const city = matchCity(g(r, c.dest));
            return {
                city: city ? city.id : null, dest: g(r, c.dest), from: from, to: sheetDate(g(r, c.to)) || from,
                name: g(r, c.name), type: g(r, c.type), gravity: g(r, c.grav), supply: num(g(r, c.supply)), notes: g(r, c.notes),
                alerts: g(r, c.alerts), affected: g(r, c.affected), tbo: num(g(r, c.tbo)), dri: g(r, c.dri), prio: g(r, c.prio), comments: g(r, c.comments)
            };
        }).filter(Boolean);
        cache.at.events = Date.now();
    }

    async function readEm() {
        const rows = await readSheet(EM_SHEET);
        const hi = rows.findIndex((r) => r.some((c) => /destination/i.test(c)) && r.some((c) => /raise\s*price/i.test(c)));
        if (hi < 0) throw new Error('EM Project: no "Destination / Raise price" header');
        const col = colFinder(rows[hi]);
        const c = { dest: col('Destination'), raise: col('Raise price'), much: col('How much'), car: col('Car Type'), slot: col('Slot of Day'), sku: col('SKU'), notes: col('Notes'), cm: col('City Manager'), type: col('Type of Destination'), season: col('Seasonality'), eff: col('Efficiency') };
        const g = (r, i) => (i >= 0 ? String(r[i] || '').trim() : '');
        // the columns after SKU are instructions for holidays (Easter, Xmas, ...)
        const extra = rows[hi].map((h, i) => ({ h: String(h).replace(/\s+/g, ' ').trim(), i: i })).filter((x) => x.i > c.sku && c.sku >= 0 && x.h && x.i !== c.notes);
        cache.em = rows.slice(hi + 1).filter((r) => g(r, c.dest)).map((r) => {
            const city = matchCity(g(r, c.dest));
            const prio = (r.find((x) => /^P\d$/.test(String(x).trim())) || '').trim();
            const instr = extra.map((x) => ({ h: x.h, v: g(r, x.i) })).filter((x) => x.v && !/^(no|-|n\/a)$/i.test(x.v));
            return { instr: instr, city: city ? city.id : null, dest: g(r, c.dest), prio: prio, raise: g(r, c.raise), much: g(r, c.much), car: g(r, c.car), slot: g(r, c.slot), sku: g(r, c.sku), notes: g(r, c.notes), cm: g(r, c.cm), type: g(r, c.type), season: g(r, c.season), eff: g(r, c.eff) };
        });
        cache.at.em = Date.now();
    }

    // Runs inside a Slack channel tab: scrolls up until 7 days are covered
    // (or 25 steps), collecting messages by their timestamp.
    async function slackScrape(sinceTs) {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 40 && !document.querySelector('[data-qa="message_container"]'); i++) await wait(500);
        const got = {};
        let lastSender = '';
        const collect = () => {
            document.querySelectorAll('[data-qa="message_container"]').forEach((m) => {
                const tsEl = m.querySelector('[data-ts]');
                const ts = tsEl ? Number(tsEl.getAttribute('data-ts')) : 0;
                const who = m.querySelector('[data-qa="message_sender_name"]');
                if (who) lastSender = who.textContent.trim();
                const body = m.querySelector('[data-qa="message-text"]') || m.querySelector('.c-message_kit__blocks');
                if (ts && body && !got[ts]) got[ts] = { ts: ts, who: who ? who.textContent.trim() : lastSender, text: body.innerText.trim().slice(0, 1500) };
            });
        };
        collect();
        const scroller = [...document.querySelectorAll('.c-scrollbar__hider')].find((el) => el.querySelector('[data-qa="message_container"]'));
        for (let i = 0; i < 25 && scroller; i++) {
            const oldest = Math.min.apply(null, Object.keys(got).map(Number).concat([Infinity]));
            if (oldest < sinceTs) break;
            scroller.scrollTop = 0;
            await wait(1200);
            collect();
        }
        return Object.values(got).filter((x) => x.ts >= sinceTs);
    }

    async function readSlack() {
        const since = Date.now() / 1000 - 7 * 86400;
        const all = [];
        for (const ch of SLACK_CHANNELS) {
            const msgs = await inTab('https://app.slack.com/client/' + SLACK_TEAM + '/' + ch.id, slackScrape, [since], 6000);
            if (!Array.isArray(msgs)) throw new Error('Slack: #' + ch.name + ' not read (is Slack logged in in this Chrome?)');
            msgs.forEach((m) => { m.channel = ch.name; m.cities = citiesIn(m.text); });
            all.push(...msgs);
        }
        cache.slack = all.sort((a, b) => b.ts - a.ts);
        cache.at.slack = Date.now();
    }
    // City names written in a message: as a capitalised word ("Nice", not "nice").
    function citiesIn(text) {
        const t = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return cache.cities.filter((c) => {
            const n = c.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
            if (n.length < 3) return false;
            const re = new RegExp('(^|[^A-Za-z])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Za-z])');
            return re.test(t);
        }).map((c) => c.id);
    }

    // ---- per-city view model ----
    function model() {
        const dates = windowDates();
        const byCity = {};
        const get = (id, name) => (byCity[id] = byCity[id] || { id: id, name: name, days: {}, events: [], slack: [], em: null, outlook: null });
        cache.cities.forEach((c) => get(c.id, c.name));
        cache.hubDaily.forEach((h) => { if (h.city && dates.includes(h.date)) get(h.city, h.name).days[h.date] = Object.assign(get(h.city, h.name).days[h.date] || {}, { hub: h }); });
        Object.keys(cache.crm).forEach((id) => {
            const c = byCity[id]; if (!c) return;
            Object.keys(cache.crm[id].days || {}).forEach((d) => { c.days[d] = Object.assign(c.days[d] || {}, { crm: dayStats(cache.crm[id].days[d].hours), hours: cache.crm[id].days[d].hours }); });
        });
        const last = dates[dates.length - 1];
        cache.events.forEach((e) => { if (e.city && byCity[e.city] && e.to >= dates[0] && e.from <= last) byCity[e.city].events.push(e); });
        cache.em.forEach((e) => { if (e.city && byCity[e.city]) byCity[e.city].em = e; });
        cache.hubOutlook.forEach((o) => { if (o.city && byCity[o.city]) byCity[o.city].outlook = o; });
        cache.slack.forEach((m) => (m.cities || []).forEach((id) => { if (byCity[id]) byCity[id].slack.push(m); }));
        Object.values(byCity).forEach((c) => {
            c.maxGap = 0; c.worst = null; c.unNear = 0; c.shortToday = 0;
            dates.forEach((d, i) => {
                const x = c.days[d] || {};
                if (x.hub && x.hub.gap > c.maxGap) c.maxGap = x.hub.gap;
                if (x.crm && x.crm.worst != null && (c.worst == null || x.crm.worst < c.worst)) c.worst = x.crm.worst;
                if (i < 2) c.unNear += x.crm ? x.crm.un : (x.hub && x.hub.un) || 0;
                if (i === 0 && x.crm) c.shortToday = x.crm.shortUn;
            });
            c.actions = actionsFor(c, dates);
            c.open = c.actions.filter((a) => !done[a.key]).length;
            c.score = c.maxGap + (c.worst != null && c.worst < 1 ? 60 : 0) + c.open * 15 + (c.outlook ? (c.outlook.loss || 0) / 200 : 0);
        });
        return { dates: dates, cities: Object.values(byCity) };
    }

    function isHigh(e) { return /high|critical/i.test(e.gravity); }
    function noAction(e) { return !e.affected || /^(no|-|)$/i.test(e.affected.trim()); }

    // Suggested actions (a checklist; ticks are kept per city, action and day).
    function actionsFor(c, dates) {
        const out = [];
        const add = (key, text, why) => out.push({ key: c.id + '|' + key, text: text, why: why });
        if (c.em && /yes/i.test(c.em.raise) && c.unNear > 0) {
            add('raise|' + dates[0], 'Raise price ' + (c.em.much || '') + (c.em.car ? ' for ' + c.em.car : '') + (c.em.slot ? ' (' + c.em.slot + ')' : ''), c.unNear + ' unassigned today + tomorrow. EM rule: ' + (c.em.sku || 'raise price: yes'));
        }
        c.events.forEach((e) => {
            if (!isHigh(e) && !(e.supply != null && e.supply <= -30)) return;
            add('event|' + e.from + '|' + norm(e.name), 'Plan for ' + e.name + ' (' + e.from + (e.to !== e.from ? ' to ' + e.to : '') + ')',
                [e.type, e.gravity && 'gravity ' + e.gravity, e.supply != null && 'supply ' + e.supply + '%', noAction(e) ? 'nothing in "LiveOps affected" yet' : 'LiveOps affected: ' + e.affected, e.notes].filter(Boolean).join(' · '));
        });
        dates.forEach((d) => {
            const x = c.days[d];
            if (x && x.crm && x.crm.worst != null && x.crm.worst < 1) {
                add('short|' + d, 'Short at ' + d.slice(5) + ' ' + pad(x.crm.worstHour) + ':00 (' + x.crm.worst + 'x)', 'adj drivers below unassigned in that hour: block the slot, raise, or open to companies');
            }
        });
        if (c.outlook && c.outlook.lever && c.outlook.loss > 1000) add('lever|' + dates[0], c.outlook.lever.replace(/\d+%$/, '').trim(), 'hub Outlook: ' + (c.outlook.owner || '') + ' · loss / wk ' + (c.outlook.loss || 0));
        return out;
    }

    // ---- render ----
    function cellClass(x) {
        if (!x) return '';
        const gap = x.hub ? x.hub.gap || 0 : 0;
        const cov = x.crm ? x.crm.worst : null;
        if (gap >= 50 || (cov != null && cov < 1)) return 'red';
        if (gap >= 15 || (cov != null && cov < 1.5)) return 'amber';
        return '';
    }

    function render() {
        const m = model();
        const q = norm($('search').value);
        const list = m.cities.filter((c) => !q || norm(c.name).indexOf(q) >= 0);
        const sort = $('sort').value;
        const by = {
            action: (a, b) => b.score - a.score, gap: (a, b) => b.maxGap - a.maxGap,
            loss: (a, b) => ((b.outlook && b.outlook.loss) || 0) - ((a.outlook && a.outlook.loss) || 0),
            cov: (a, b) => (a.worst == null ? 99 : a.worst) - (b.worst == null ? 99 : b.worst), name: (a, b) => a.name.localeCompare(b.name)
        }[sort];
        list.sort(by);
        renderStrip(m);
        if (tab === 'overview') renderTable(m, list);
        if (tab === 'slack') renderSlack();
        if (tab === 'retro') renderRetro(m);
        if (tab === 'month') renderMonth();
        if (selected) renderPanel(m.cities.find((c) => c.id === selected), m.dates);
    }

    function renderStrip(m) {
        const red = m.cities.filter((c) => m.dates.some((d) => cellClass(c.days[d]) === 'red')).length;
        const amber = m.cities.filter((c) => !m.dates.some((d) => cellClass(c.days[d]) === 'red') && m.dates.some((d) => cellClass(c.days[d]) === 'amber')).length;
        const ev = m.cities.reduce((n, c) => n + c.events.length, 0);
        const evHigh = m.cities.reduce((n, c) => n + c.events.filter(isHigh).length, 0);
        const evNoAct = m.cities.reduce((n, c) => n + c.events.filter((e) => isHigh(e) && noAction(e)).length, 0);
        const slack24 = cache.slack.filter((s) => s.ts > Date.now() / 1000 - 86400).length;
        const actions = m.cities.reduce((n, c) => n + c.open, 0);
        const raise = m.cities.filter((c) => c.actions.some((a) => a.key.indexOf('|raise|') > 0 && !done[a.key])).length;
        const loss = cache.hubOutlook.reduce((n, o) => n + (o.loss || 0), 0);
        const stat = (v, t) => '<div class="card stat"><b>' + esc(v) + '</b><span>' + esc(t) + '</span></div>';
        $('strip').innerHTML = stat(red, 'cities red (gap 50+ or short hour)') + stat(amber, 'cities amber') + stat(evHigh + ' / ' + ev, 'high-gravity / all events, 7 days') +
            stat(evNoAct, 'high events without LiveOps action') + stat(raise, 'cities where a raise is due') + stat(actions, 'open actions') +
            stat(slack24, 'Slack posts, last 24 h') + stat(loss ? '€' + Math.round(loss).toLocaleString() : '-', 'hub projected loss / wk');
    }

    function renderTable(m, list) {
        const crmRead = Object.keys(cache.crm).length;
        let h = '<table><thead><tr><th>City</th><th>Open</th><th>Loss/wk</th>' + m.dates.map((d) => {
            const x = parseIso(d); return '<th>' + x.toDateString().slice(0, 3) + ' ' + x.getDate() + '/' + (x.getMonth() + 1) + '</th>';
        }).join('') + '</tr></thead><tbody>';
        list.slice(0, 400).forEach((c) => {
            h += '<tr class="city' + (c.id === selected ? ' sel' : '') + '" data-id="' + esc(c.id) + '"><td>' + esc(c.name) + (c.slack.length ? '<span class="badge sl">slack ' + c.slack.length + '</span>' : '') + '</td><td>' + (c.open || '') + '</td><td class="muted">' + (c.outlook && c.outlook.loss ? '€' + Math.round(c.outlook.loss).toLocaleString() : '') + '</td>';
            m.dates.forEach((d) => {
                const x = c.days[d] || {};
                const evs = c.events.filter((e) => e.from <= d && e.to >= d);
                let t = '';
                if (x.hub) t += '<span class="g" title="hub transfer gap (share of booked)">' + (x.hub.gap != null ? x.hub.gap : '') + '</span>';
                if (x.crm) t += ' <span class="muted" title="CRM: worst hour, adj drivers / unassigned · unassigned that day">' + (x.crm.worst != null ? x.crm.worst + 'x' : 'ok') + ' · ' + x.crm.un + 'u</span>';
                evs.slice(0, 2).forEach((e) => { t += '<span class="badge ' + (isHigh(e) ? 'hi' : /medium/i.test(e.gravity) ? 'md' : '') + '" title="' + esc(e.name + ' · ' + e.gravity) + '">' + esc((e.type || 'event').replace(/[^A-Za-z ]/g, '').trim().split(' ')[0].slice(0, 7).toLowerCase() || 'event') + '</span>'; });
                h += '<td class="day ' + cellClass(x) + '">' + (t || '<span class="faint">-</span>') + '</td>';
            });
            h += '</tr>';
        });
        h += '</tbody></table>';
        if (!crmRead) h += '<div class="muted" style="padding:10px">CRM hours not read yet: press Refresh.</div>';
        $('main').innerHTML = h;
    }

    function spark(values, color) {
        const v = values.filter((x) => x != null);
        if (v.length < 2) return '<span class="faint">not enough history yet</span>';
        const max = Math.max.apply(null, v.concat([1])), w = 380, hgt = 40;
        const pts = values.map((x, i) => x == null ? null : (i * w / (values.length - 1)).toFixed(1) + ',' + (hgt - (x / max) * hgt).toFixed(1)).filter(Boolean).join(' ');
        return '<svg class="spark" viewBox="0 0 ' + w + ' ' + (hgt + 2) + '" preserveAspectRatio="none"><polyline fill="none" stroke="' + color + '" stroke-width="1.5" points="' + pts + '"/></svg>';
    }

    function renderPanel(c, dates) {
        if (!c) { $('panel').innerHTML = '<span class="muted">Click a city.</span>'; return; }
        let h = '<h2>' + esc(c.name) + '</h2>';
        if (c.em) h += '<div class="muted">' + esc([c.em.prio, c.em.type, c.em.season, c.em.cm && 'CM ' + c.em.cm].filter(Boolean).join(' · ')) + '</div>';
        h += '<h3>Actions</h3>';
        if (!c.actions.length) h += '<div class="muted">Nothing needed from what mod can see.</div>';
        c.actions.forEach((a) => {
            h += '<label class="item act' + (done[a.key] ? ' done' : '') + '"><input type="checkbox" data-key="' + esc(a.key) + '"' + (done[a.key] ? ' checked' : '') + '><span><b>' + esc(a.text) + '</b><br><span class="muted">' + esc(a.why) + '</span></span></label>';
        });
        h += '<h3>Events, next 7 days</h3>';
        if (!c.events.length) h += '<div class="muted">None in the events sheet.</div>';
        c.events.forEach((e) => {
            h += '<div class="item"><b>' + esc(e.name) + '</b> <span class="badge ' + (isHigh(e) ? 'hi' : '') + '">' + esc(e.gravity || '-') + '</span><br><span class="muted">' + esc([e.from + (e.to !== e.from ? ' to ' + e.to : ''), e.type, e.supply != null && 'supply ' + e.supply + '%', e.dri && 'DRI ' + e.dri, e.affected && 'LiveOps: ' + e.affected].filter(Boolean).join(' · ')) + '</span>' + (e.notes ? '<br>' + esc(e.notes) : '') + (e.alerts ? '<br><span class="muted">alerts: ' + esc(e.alerts) + '</span>' : '') + (e.comments ? '<br><span class="muted">LiveOps comments: ' + esc(e.comments) + '</span>' : '') + '</div>';
        });
        h += '<h3>Days</h3>';
        const pick = c._day && dates.includes(c._day) ? c._day : dates.find((d) => c.days[d] && c.days[d].hours) || dates[0];
        c._day = pick;
        h += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">' + dates.map((d) => '<button class="' + (d === pick ? 'on' : '') + '" data-day="' + d + '">' + d.slice(8) + '/' + d.slice(5, 7) + '</button>').join('') + '</div>';
        const x = c.days[pick] || {};
        if (x.hub) h += '<div class="item">hub: gap <b>' + x.hub.gap + '</b>' + (x.hub.gapPct != null ? ' (' + x.hub.gapPct + '%)' : '') + ' · booked ' + (x.hub.booked || 0) + ' · forecast ~' + (x.hub.forecast || '-') + ' · unassigned ' + (x.hub.un || 0) + ' · net drivers ' + (x.hub.net || 0) + (x.hub.gfs != null ? ' · fwd GFS ' + x.hub.gfs + '%' : '') + '</div>';
        if (x.hours && x.hours.length) {
            const max = Math.max.apply(null, x.hours.map((y) => Math.max(y.adj || 0, y.un + y.as)).concat([1]));
            h += '<div class="hours">' + x.hours.map((y) => '<div class="' + (y.un > 0 && (y.adj || 0) < y.un ? 'short ' : '') + (y.blk ? 'blk' : '') + '" style="height:' + Math.max(2, Math.round(((y.adj || 0) / max) * 70)) + 'px" title="' + pad(y.h) + ':00 · ' + y.drv + ' drivers · ' + y.adj + ' adj · ' + y.as + ' assigned · ' + y.un + ' unassigned' + (y.blk ? ' · blocked' : '') + '"></div>').join('') + '</div>';
            h += '<div class="hlabels">' + x.hours.map((y) => '<span>' + (y.h % 3 === 0 ? y.h : '') + '</span>').join('') + '</div>';
            h += '<div class="muted" style="font-size:11px">bars = adj drivers per hour; red = fewer adj drivers than unassigned; dashed = blocked</div>';
        } else h += '<div class="muted">CRM hours not read for this city yet (Refresh reads the top ' + TOP_N + ' and cities with events; "Read all cities" reads all).</div>';
        if (c.outlook) h += '<h3>Hub outlook</h3><div class="item">loss / wk <b>€' + Math.round(c.outlook.loss || 0).toLocaleString() + '</b> · ' + esc(c.outlook.vs || '') + ' vs last 7 d · proj GFS ' + (c.outlook.gfs || '-') + '%<br>' + esc(c.outlook.lever || '') + ' · ' + esc(c.outlook.owner || '') + '</div>';
        if (c.em) h += '<h3>EM policy</h3><div class="item">raise price: <b>' + esc(c.em.raise || '-') + '</b>' + (c.em.much ? ' · ' + esc(c.em.much) : '') + (c.em.car ? ' · ' + esc(c.em.car) : '') + (c.em.slot ? ' · ' + esc(c.em.slot) : '') + (c.em.sku ? '<br>' + esc(c.em.sku) : '') + (c.em.notes ? '<br><span class="muted">' + esc(c.em.notes) + '</span>' : '') + '</div>';
        if (c.em && c.em.instr && c.em.instr.length) h += c.em.instr.map((x) => '<div class="item"><span class="muted">' + esc(x.h) + '</span><br>' + esc(x.v) + '</div>').join('');
        h += '<h3>Slack, last 7 days</h3>';
        if (!c.slack.length) h += '<div class="muted">No posts naming this city.</div>';
        c.slack.slice(0, 12).forEach((s) => { h += '<div class="item"><span class="muted">#' + esc(s.channel) + ' · ' + esc(s.who) + ' · ' + new Date(s.ts * 1000).toLocaleString() + '</span><br>' + esc(s.text.slice(0, 500)) + '</div>'; });
        h += '<h3>History (last 30 days)</h3>';
        const mine = history.filter((r) => r.city === c.id).sort((a, b) => a.date < b.date ? -1 : 1).slice(-30);
        h += '<div class="muted" style="font-size:11px">unassigned</div>' + spark(mine.map((r) => r.un), '#8fffd5');
        h += '<div class="muted" style="font-size:11px">hub gap</div>' + spark(mine.map((r) => r.gap), '#f2c27b');
        $('panel').innerHTML = h;
    }

    function renderSlack() {
        let h = '<table><thead><tr><th>When</th><th>Channel</th><th>From</th><th>Cities</th><th>Post</th></tr></thead><tbody>';
        const names = {}; cache.cities.forEach((c) => { names[c.id] = c.name; });
        cache.slack.slice(0, 300).forEach((s) => {
            h += '<tr><td class="muted">' + new Date(s.ts * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) + '</td><td>#' + esc(s.channel) + '</td><td>' + esc(s.who) + '</td><td>' + esc((s.cities || []).map((id) => names[id]).join(', ')) + '</td><td style="white-space:normal">' + esc(s.text.slice(0, 400)) + '</td></tr>';
        });
        h += '</tbody></table>';
        if (!cache.slack.length) h = '<div class="muted" style="padding:10px">No Slack posts read yet: press Refresh.</div>';
        $('main').innerHTML = h;
    }

    // Past events vs the same weekday in the 4 weeks before, from history.
    function renderRetro() {
        const byKey = {}; history.forEach((r) => { byKey[r.city + '|' + r.date] = r; });
        const t = iso(today());
        const names = {}; cache.cities.forEach((c) => { names[c.id] = c.name; });
        const rows = [];
        cache.events.filter((e) => e.city && e.to < t).forEach((e) => {
            const ev = [], base = [];
            for (let d = parseIso(e.from); iso(d) <= e.to; d = addDays(d, 1)) {
                const r = byKey[e.city + '|' + iso(d)]; if (r) ev.push(r);
                for (let w = 1; w <= 4; w++) { const b = byKey[e.city + '|' + iso(addDays(d, -7 * w))]; if (b) base.push(b); }
            }
            if (!ev.length) return;
            const avg = (a, f) => { const v = a.map(f).filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
            rows.push({ e: e, name: names[e.city], un: avg(ev, (r) => r.un), unB: avg(base, (r) => r.un), gap: avg(ev, (r) => r.gap), gapB: avg(base, (r) => r.gap), adj: avg(ev, (r) => r.adjPeak), adjB: avg(base, (r) => r.adjPeak) });
        });
        const f = (v) => v == null ? '-' : Math.round(v);
        const diff = (a, b) => a == null || b == null || !b ? '' : ' <span class="' + (a > b ? 'err' : 'muted') + '">(' + (a >= b ? '+' : '') + Math.round((a - b) / b * 100) + '%)</span>';
        let h = '<table><thead><tr><th>Event</th><th>City</th><th>Dates</th><th>Sheet gravity / supply</th><th>Unassigned vs normal</th><th>Hub gap vs normal</th><th>Peak adj drivers vs normal</th></tr></thead><tbody>';
        rows.sort((a, b) => a.e.from < b.e.from ? 1 : -1).forEach((r) => {
            h += '<tr><td>' + esc(r.e.name) + '</td><td>' + esc(r.name) + '</td><td class="muted">' + r.e.from + '</td><td>' + esc(r.e.gravity || '-') + ' / ' + (r.e.supply != null ? r.e.supply + '%' : '-') + '</td><td>' + f(r.un) + ' vs ' + f(r.unB) + diff(r.un, r.unB) + '</td><td>' + f(r.gap) + ' vs ' + f(r.gapB) + diff(r.gap, r.gapB) + '</td><td>' + f(r.adj) + ' vs ' + f(r.adjB) + diff(r.adj, r.adjB) + '</td></tr>';
        });
        h += '</tbody></table>';
        if (!rows.length) h = '<div class="muted" style="padding:10px">No finished event has history yet. History started on the day this version was installed; events that end from now on show up here, compared with the same weekday in the 4 weeks before.</div>';
        $('main').innerHTML = h;
    }

    function renderMonth() {
        const q = norm($('search').value);
        const names = {}; cache.cities.forEach((c) => { names[c.id] = c.name; });
        const g = {};
        history.forEach((r) => {
            if (q && norm(names[r.city] || '').indexOf(q) < 0) return;
            const k = r.city + '|' + r.date.slice(0, 7);
            const x = g[k] = g[k] || { city: r.city, month: r.date.slice(0, 7), n: 0, un: 0, gap: 0, short: 0, ev: 0 };
            x.n++; x.un += r.un || 0; x.gap += r.gap || 0; if (r.worst != null && r.worst < 1) x.short++; if (r.events) x.ev++;
        });
        const months = [...new Set(Object.values(g).map((x) => x.month))].sort();
        const cities = [...new Set(Object.values(g).map((x) => x.city))].sort((a, b) => String(names[a]).localeCompare(String(names[b])));
        let h = '<table><thead><tr><th>City</th>' + months.map((mo) => '<th>' + mo + '<br>unassigned / day · gap / day · short days · event days</th>').join('') + '</tr></thead><tbody>';
        cities.forEach((id) => {
            h += '<tr><td>' + esc(names[id] || id) + '</td>' + months.map((mo) => { const x = g[id + '|' + mo]; return '<td>' + (x ? (x.un / x.n).toFixed(1) + ' · ' + (x.gap / x.n).toFixed(1) + ' · ' + x.short + ' · ' + x.ev : '<span class="faint">-</span>') + '</td>'; }).join('') + '</tr>';
        });
        h += '</tbody></table>';
        if (!history.length) h = '<div class="muted" style="padding:10px">No history yet. mod saves one record per city and day from now on (the nightly read covers every city).</div>';
        $('main').innerHTML = h;
    }

    // ---- history: one record per city and day, the latest read wins ----
    async function saveHistory() {
        const m = model();
        const recs = [];
        m.cities.forEach((c) => {
            m.dates.forEach((d) => {
                const x = c.days[d];
                if (!x || (!x.hub && !x.crm)) return;
                recs.push({
                    k: c.id + '|' + d, city: c.id, date: d, at: Date.now(),
                    gap: x.hub ? x.hub.gap : null, gapPct: x.hub ? x.hub.gapPct : null, hubUn: x.hub ? x.hub.un : null, booked: x.hub ? x.hub.booked : null,
                    forecast: x.hub ? x.hub.forecast : null, net: x.hub ? x.hub.net : null, gfs: x.hub ? x.hub.gfs : null,
                    un: x.crm ? x.crm.un : (x.hub ? x.hub.un : null), as: x.crm ? x.crm.as : null, adjPeak: x.crm ? x.crm.adjPeak : null,
                    worst: x.crm ? x.crm.worst : null, blocked: x.crm ? x.crm.blocked : null,
                    events: c.events.filter((e) => e.from <= d && e.to >= d).length
                });
            });
        });
        // Days already past keep their last record; only today onwards is written.
        await historyPut(recs);
        history = await historyAll();
    }

    // ---- refresh ----
    async function step(name, fn) {
        try { await fn(); delete cache.errors[name]; return true; } catch (e) { cache.errors[name] = String(e && e.message || e); log(cache.errors[name], true); return false; }
    }

    async function refresh(all) {
        if (busy) return;
        busy = true;
        $('refresh').disabled = $('full').disabled = true;
        try {
            log('reading the CRM city list…');
            await step('cities', readCities);
            log('reading the events sheet and EM Project…');
            await step('events', readEvents);
            await step('em', readEm);
            log('reading the hub (background tab)…');
            await step('hub', readHub);
            render();
            log('reading Slack (background tab)…');
            await step('slack', readSlack);
            await saveCache();
            render();
            const m = model();
            let targets;
            if (all) targets = cache.cities.slice();
            else {
                const top = m.cities.slice().sort((a, b) => b.maxGap - a.maxGap).slice(0, TOP_N);
                const ev = m.cities.filter((c) => c.events.some(isHigh)).slice(0, MAX_EVENT_CITIES);
                if (selected) top.unshift(m.cities.find((c) => c.id === selected));
                const seen = {}; targets = top.concat(ev).filter((c) => c && !seen[c.id] && (seen[c.id] = 1));
            }
            for (let i = 0; i < targets.length; i++) {
                $('status').textContent = 'CRM hours ' + (i + 1) + ' / ' + targets.length + ': ' + targets[i].name;
                const ok = await step('crm', () => readCrmCity(targets[i]));
                if (!ok) break;
                if (i % 10 === 9) { await saveCache(); render(); }
            }
            cache.at.crm = Date.now();
            cache.at.all = Date.now();
            await saveCache();
            await saveHistory();
            render();
            const errs = Object.keys(cache.errors);
            log(errs.length ? 'done, with problems: ' + errs.join(', ') : 'up to date · ' + new Date().toLocaleTimeString().slice(0, 5));
        } finally {
            busy = false;
            $('refresh').disabled = $('full').disabled = false;
        }
    }

    // ---- events ----
    $('main').addEventListener('click', (e) => {
        const tr = e.target.closest('tr.city');
        if (!tr) return;
        selected = tr.getAttribute('data-id');
        render();
    });
    $('panel').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-day]');
        if (!b) return;
        const m = model();
        const c = m.cities.find((x) => x.id === selected);
        if (c) { c._day = b.getAttribute('data-day'); renderPanel(c, m.dates); }
    });
    $('panel').addEventListener('change', async (e) => {
        const k = e.target.getAttribute && e.target.getAttribute('data-key');
        if (!k) return;
        if (e.target.checked) done[k] = Date.now(); else delete done[k];
        await chrome.storage.local.set({ [DONE_KEY]: done });
        render();
    });
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
        tab = b.getAttribute('data-tab');
        document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
        render();
    }));
    $('search').addEventListener('input', render);
    $('sort').addEventListener('change', render);
    $('refresh').addEventListener('click', () => refresh(false));
    $('full').addEventListener('click', () => refresh(true));

    (async function start() {
        const got = await chrome.storage.local.get({ [CACHE_KEY]: null, [DONE_KEY]: {} });
        if (got[CACHE_KEY]) cache = Object.assign(cache, got[CACHE_KEY]);
        done = got[DONE_KEY] || {};
        // ticks older than 10 days are dropped
        Object.keys(done).forEach((k) => { if (Date.now() - done[k] > 10 * 86400000) delete done[k]; });
        try { history = await historyAll(); } catch (_) { history = []; }
        render();
        if (SNAPSHOT) {
            await refresh(true);
            try { const me = await chrome.tabs.getCurrent(); if (me) await chrome.tabs.remove(me.id); else window.close(); } catch (_) { window.close(); }
            return;
        }
        if (!cache.at.all || Date.now() - cache.at.all > 30 * 60 * 1000) refresh(false);
        else log('last read ' + new Date(cache.at.all).toLocaleTimeString().slice(0, 5));
        setInterval(() => refresh(false), REFRESH_MS);
    })();

    // stand-in tests reach the pure helpers through this
    window.wpOverviewTest = { parseCsv: parseCsv, sheetDate: sheetDate, hubDate: hubDate, parseCrmDash: parseCrmDash, dayStats: dayStats, citiesIn: citiesIn, colFinder: colFinder, setCities: (c) => { cache.cities = c; } };
})();
