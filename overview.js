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
    let tab = 'home';
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

    // 1.7.306: the Em Hailing page (content.js) saves its Today / Tomorrow
    // lists per city; fresh for 15 minutes.
    const EM_LIST_KEY = 'wp_em_list_counts_v1';
    let emList = null;
    function emFresh() { return !!(emList && Date.now() - (emList.at || 0) < 15 * 60 * 1000); }
    function unOf(x) { return !x ? 0 : x.em != null ? x.em : x.crm ? x.crm.un : 0; }
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[EM_LIST_KEY]) { emList = changes[EM_LIST_KEY].newValue || null; try { render(); } catch (_) {} }
        });
    } catch (_) {}

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
        // 1.7.306: Today / Tomorrow "without a driver" = the Em Hailing list (same numbers as that page)
        if (emFresh()) {
            [['today', dates[0]], ['tomorrow', dates[1]]].forEach((pair) => {
                Object.values(byCity).forEach((c) => { c.days[pair[1]] = Object.assign(c.days[pair[1]] || {}, { em: 0 }); });
                ((emList[pair[0]] || {}).cities || []).forEach((e) => {
                    const city = matchCity(e.c);
                    const c = city ? byCity[city.id] : (byCity['em:' + e.c] = byCity['em:' + e.c] || { id: 'em:' + e.c, name: e.c, days: {}, events: [], slack: [], em: null, outlook: null });
                    c.days[pair[1]] = Object.assign(c.days[pair[1]] || {}, { em: (c.days[pair[1]] && c.days[pair[1]].em || 0) + e.n });
                });
            });
        }
        cache.slack.forEach((m) => (m.cities || []).forEach((id) => { if (byCity[id]) byCity[id].slack.push(m); }));
        Object.values(byCity).forEach((c) => {
            c.maxGap = 0; c.worst = null; c.unNear = 0; c.shortToday = 0;
            dates.forEach((d, i) => {
                const x = c.days[d] || {};
                c.maxGap += unOf(x); // 1.7.305: transfers without a driver (CRM), not the hub gap
                if (x.crm && x.crm.worst != null && (c.worst == null || x.crm.worst < c.worst)) c.worst = x.crm.worst;
                if (i < 2) c.unNear += unOf(x);
                if (i === 0 && x.crm) c.shortToday = x.crm.shortUn;
            });
            c.actions = actionsFor(c, dates);
            c.open = c.actions.filter((a) => !done[a.key]).length;
            c.score = c.maxGap + (c.worst != null && c.worst < 1 ? 60 : 0) + c.open * 15;
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
            add('event|' + e.from + '|' + norm(e.name), 'Plan for ' + e.name + ' (' + dayName(e.from) + (e.to !== e.from ? ' to ' + dayName(e.to) : '') + ')',
                [e.type, e.gravity && 'gravity ' + e.gravity, e.supply != null && 'supply ' + e.supply + '%', noAction(e) ? 'nothing in "LiveOps affected" yet' : 'LiveOps affected: ' + e.affected, e.notes].filter(Boolean).join(' · '));
        });
        dates.forEach((d) => {
            const x = c.days[d];
            if (x && x.crm && x.crm.worst != null && x.crm.worst < 1) {
                add('short|' + d, 'Short of drivers ' + dayName(d) + ' at ' + pad(x.crm.worstHour) + ':00', x.crm.worst + ' drivers per unassigned job in that hour: block the slot, raise, or open to companies');
            }
        });
        if (c.outlook && c.outlook.lever && c.outlook.loss > 1000) add('lever|' + dates[0], c.outlook.lever.replace(/\d+%$/, '').trim(), 'hub Outlook: ' + (c.outlook.owner || '') + ' · loss / wk ' + (c.outlook.loss || 0));
        return out;
    }

    // ---- render (1.7.303: light card dashboard) ----
    const KPI_KEY = 'wp_ov_kpi_v1';
    let kpiHist = {};
    const fmt = (n) => n == null ? '-' : Math.round(n).toLocaleString();
    const dayName = (d) => { const x = parseIso(d); return x.toDateString().slice(0, 3) + ' ' + x.getDate(); };

    // 1.7.305: from the CRM only (the hub's numbers are off)
    function cellClass(x) {
        if (!x || (!x.crm && x.em == null)) return '';
        if (x.crm && x.crm.worst != null && x.crm.worst < 1 && unOf(x) > 0) return 'red';
        if (unOf(x) > 0) return 'amber';
        return '';
    }
    function cityLevel(c, dates) {
        if (dates.some((d) => cellClass(c.days[d]) === 'red')) return 'red';
        if (dates.some((d) => cellClass(c.days[d]) === 'amber')) return 'amber';
        return '';
    }
    function sorted(m) {
        const q = norm($('search').value);
        const list = m.cities.filter((c) => !q || norm(c.name).indexOf(q) >= 0);
        const by = {
            action: (a, b) => b.score - a.score, gap: (a, b) => b.maxGap - a.maxGap,
            loss: (a, b) => ((b.outlook && b.outlook.loss) || 0) - ((a.outlook && a.outlook.loss) || 0),
            cov: (a, b) => (a.worst == null ? 99 : a.worst) - (b.worst == null ? 99 : b.worst), name: (a, b) => a.name.localeCompare(b.name)
        }[$('sort').value];
        return list.sort(by);
    }

    // 1.7.304: Home is one period at a time (Today / Tomorrow / Rest of week),
    // built around "where to act": per city, how many jobs have no driver,
    // which hours are short of drivers, and what the policy says.
    const PERIOD_KEY = 'wp_ov_period';
    let period = (function() { try { return localStorage.getItem(PERIOD_KEY) || 'today'; } catch (_) { return 'today'; } })();
    function periodDates(m) { return period === 'today' ? m.dates.slice(0, 1) : period === 'tomorrow' ? m.dates.slice(1, 2) : m.dates.slice(2); }
    // Consecutive short hours → "15-18h"
    function hourRanges(hours) {
        const hs = hours.slice().sort((a, b) => a - b), out = [];
        hs.forEach((h) => { const last = out[out.length - 1]; if (last && h === last[1] + 1) last[1] = h; else out.push([h, h]); });
        return out.map((r) => r[0] === r[1] ? pad(r[0]) + 'h' : pad(r[0]) + '-' + pad(r[1] + 1) + 'h').join(', ');
    }
    function cityPeriod(c, ds) {
        const p = { c: c, un: 0, unC: 0, as: 0, gap: 0, booked: 0, short: [], shortUn: 0, shortAdj: 0, hasHours: false, events: [], days: [] };
        ds.forEach((d) => {
            const x = c.days[d] || {};
            const un = unOf(x);
            p.as += x.crm ? x.crm.as : 0;
            p.unC += x.crm ? x.crm.un : 0;
            p.un += un;
            p.gap += Math.max(0, (x.hub && x.hub.gap) || 0);
            p.booked += (x.hub && x.hub.booked) || 0;
            if (x.hours && x.hours.length) {
                p.hasHours = true;
                x.hours.forEach((y) => { if (y.un > 0 && (y.adj || 0) < y.un) { p.short.push({ d: d, h: y.h }); p.shortUn += y.un; p.shortAdj += y.adj || 0; } });
            }
            p.days.push({ d: d, un: un, gap: (x.hub && x.hub.gap) || 0, cls: cellClass(x) });
        });
        p.events = c.events.filter((e) => ds.some((d) => e.from <= d && e.to >= d));
        p.raise = !!(c.em && /yes/i.test(c.em.raise) && p.un > 0 && period !== 'week');
        p.score = p.shortUn * 3 + p.un + p.events.filter(isHigh).length * 20;
        return p;
    }

    function render() {
        const m = model();
        if (tab === 'home') renderHome(m);
        if (tab === 'cities') renderTable(m, sorted(m));
        if (tab === 'slack') renderSlack();
        if (tab === 'retro') renderRetro(m);
        if (tab === 'month') renderMonth();
        if (selected) renderDrawer(m.cities.find((c) => c.id === selected), drawerDates(m)); // 1.7.308: from Home, only the chosen period's days
    }

    function renderHome(m) {
        const ds = periodDates(m);
        const rows = m.cities.map((c) => cityPeriod(c, ds)).filter((p) => p.un > 0 || p.events.some(isHigh)).sort((a, b) => (b.un > 0) - (a.un > 0) || b.score - a.score); // 1.7.307: cities with nothing unassigned go last
        const all = m.cities.map((c) => cityPeriod(c, ds));
        const k = {
            un: all.reduce((n, p) => n + p.un, 0),
            gap: all.reduce((n, p) => n + p.gap, 0),
            as: all.reduce((n, p) => n + p.as, 0),
            unC: all.reduce((n, p) => n + p.unC, 0),
            shortCities: all.filter((p) => p.short.length).length,
            shortUn: all.reduce((n, p) => n + p.shortUn, 0),
            high: all.reduce((n, p) => n + p.events.filter(isHigh).length, 0),
            noPlan: all.reduce((n, p) => n + p.events.filter((e) => isHigh(e) && noAction(e)).length, 0),
            raise: all.filter((p) => p.raise).length,
            read: all.filter((p) => p.hasHours).length
        };
        const label = period === 'today' ? 'Today' : period === 'tomorrow' ? 'Tomorrow' : 'Rest of the week';
        const range = ds.length > 1 ? dayName(ds[0]) + ' to ' + dayName(ds[ds.length - 1]) : dayName(ds[0]);
        let h = '<div class="seg">' + [['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Rest of week']].map((x) => '<button class="' + (x[0] === period ? 'on' : '') + '" data-period="' + x[0] + '">' + x[1] + '</button>').join('') + '<span class="note">' + esc(range) + '</span></div>';
        const tile = (title, value, help, cls, key) => '<div class="card kpi' + (cls ? ' ' + cls : '') + (key ? ' click' + (openTile === key ? ' on' : '') + '" data-tile="' + key : '') + '"><div class="top">' + title + '</div><div class="num">' + value + '</div><div class="help">' + help + '</div></div>';
        h += '<div class="kpis">' +
            tile('Transfers without a driver', fmt(k.un), (period !== 'week' && emFresh() ? 'in the Em Hailing list now (' + ago(emList.at / 1000) + ')' : period !== 'week' ? 'CRM dashboard; open Em Hailing for the live list' : 'CRM dashboard'), k.un ? 'warnv' : '') +
            tile('Short of drivers', k.shortCities + (k.shortCities === 1 ? ' city' : ' cities'), fmt(k.shortUn) + ' jobs in hours with fewer drivers than jobs (' + k.read + ' cities read hour by hour)', k.shortCities ? 'badv' : '', 'short') +
            tile('Covered', (k.as + k.unC ? Math.round(k.as / (k.as + k.unC) * 100) : 0) + '%', fmt(k.as) + ' of ' + fmt(k.as + k.unC) + ' transfers have a driver (CRM dashboard)', '') +
            tile('Big events', k.high, k.high ? 'click to list them' : 'none in the events sheet', '', 'events') + '</div>'; // 1.7.309: no "no plan" count
        // 1.7.309: Short of drivers / Big events tiles open a list of the cities or events.
        if (openTile === 'short') {
            const sl = all.filter((p) => p.short.length).sort((a, b) => b.shortUn - a.shortUn);
            h += '<div class="card list tilelist"><div class="head"><h2>Short of drivers ' + label.toLowerCase() + '</h2><span class="note">hours with fewer drivers (adj) than jobs without a driver</span></div>';
            h += sl.length ? sl.map((p) => '<div class="li" data-city="' + esc(p.c.id) + '"><div><b>' + esc(p.c.name) + '</b><div class="s">' + (period === 'week' ? p.short.length + ' hours over ' + new Set(p.short.map((x) => x.d)).size + ' days' : hourRanges(p.short.map((x) => x.h))) + '</div></div><span class="pill red">' + fmt(p.shortUn) + ' jobs</span></div>').join('') : '<div class="empty">No city is short of drivers.</div>';
            h += '</div>';
        } else if (openTile === 'events') {
            const el = [];
            all.forEach((p) => p.events.filter(isHigh).forEach((e) => el.push({ c: p.c, e: e })));
            el.sort((a, b) => a.e.from < b.e.from ? -1 : 1);
            h += '<div class="card list tilelist"><div class="head"><h2>Big events ' + label.toLowerCase() + '</h2><span class="note">' + el.length + '</span></div>';
            h += el.length ? el.map((x) => '<div class="li" data-city="' + esc(x.c.id) + '"><div><b>' + esc(x.e.name) + '</b><div class="s">' + esc(x.c.name) + ' &middot; ' + dayName(x.e.from) + (x.e.to !== x.e.from ? ' to ' + dayName(x.e.to) : '') + (x.e.type ? ' &middot; ' + esc(x.e.type) : '') + (x.e.supply != null ? ' &middot; supply ' + x.e.supply + '%' : '') + '</div></div><span class="pill red">' + esc(x.e.gravity || 'High') + '</span></div>').join('') : '<div class="empty">No big events.</div>';
            h += '</div>';
        }

        // where to act
        h += '<div class="card"><div class="head"><h2>Where to act ' + label.toLowerCase() + '</h2><span class="note">most urgent first &middot; click a city for hour by hour</span></div>';
        if (!rows.length) h += '<div class="empty">' + (Object.keys(cache.at).length ? 'Nothing open for ' + label.toLowerCase() + '.' : 'Nothing read yet: press Refresh.') + '</div>';
        else {
            h += '<table class="act-table"><thead><tr><th>City</th><th>No driver</th><th>Short hours</th>' + (period === 'week' ? '<th>By day</th>' : '') + '<th>Assigned</th><th>Event</th><th>Policy</th></tr></thead><tbody>';
            rows.slice(0, showAll ? 400 : 15).forEach((p) => {
                const c = p.c;
                const shortTxt = p.short.length ? (period === 'week' ? p.short.length + ' hours over ' + new Set(p.short.map((s) => s.d)).size + ' days' : hourRanges(p.short.map((s) => s.h))) : (p.hasHours ? 'none' : '');
                h += '<tr class="city" data-city="' + esc(c.id) + '"><td><b>' + esc(c.name) + '</b>' + (c.slack.length ? ' <span class="pill grey">Slack ' + c.slack.length + '</span>' : '') + '</td>';
                h += '<td><span class="chip ' + (p.shortUn ? 'red' : p.un ? 'amber' : 'ok') + '">' + fmt(p.un) + '</span></td>';
                h += '<td>' + (p.short.length ? '<span class="bad">' + esc(shortTxt) + '</span><div class="s">' + fmt(p.shortAdj) + ' drivers for ' + fmt(p.shortUn) + ' jobs</div>' : '<span class="s">' + esc(shortTxt || 'not read') + '</span>') + '</td>';
                if (period === 'week') h += '<td class="minis">' + p.days.map((x) => '<span class="mini ' + (x.cls || 'ok') + '" title="' + dayName(x.d) + ': ' + x.un + ' without driver">' + dayName(x.d).slice(0, 2) + '</span>').join('') + '</td>';
                h += '<td>' + (p.hasHours ? fmt(p.as) + ' of ' + fmt(p.as + p.unC) : '<span class="s">not read</span>') + '</td>';
                h += '<td>' + (p.events.length ? esc(p.events[0].name.slice(0, 22)) + ' <span class="pill ' + (isHigh(p.events[0]) ? 'red' : 'grey') + '">' + esc(p.events[0].gravity || '-') + '</span>' : '') + '</td>';
                h += '<td>' + (p.raise ? '<span class="pill amber">raise ' + esc(c.em.much || '') + '</span><div class="s">' + esc((c.em.sku || '').replace(/^-\s*/, '').slice(0, 40)) + '</div>' : c.em ? '<span class="s">' + (/yes/i.test(c.em.raise) ? 'raise allowed' : 'no raise') + '</span>' : '') + '</td></tr>';
            });
            h += '</tbody></table>';
            if (rows.length > 15) h += '<button class="link" data-showall="1" style="margin-top:10px">' + (showAll ? 'Show top 15' : 'Show all ' + rows.length + ' cities') + ' &rarr;</button>';
        }
        h += '</div>';

        // hour by hour (the availability dashboard, for the cities that matter)
        if (period !== 'week') {
            const d = ds[0];
            const grid = rows.filter((p) => p.c.days[d] && p.c.days[d].hours && p.c.days[d].hours.some((y) => y.un > 0)).slice(0, 14);
            h += '<div class="card"><div class="head"><h2>Hour by hour, ' + label.toLowerCase() + '</h2><span class="note">number = transfers without a driver &middot; <span class="bad">red</span>: transfers without a driver &middot; <span style="color:var(--amber)">striped</span>: blocked hour &middot; hover for drivers</span></div>';
            if (!grid.length) h += '<div class="empty">No unassigned transfers in the cities read hour by hour.</div>';
            else {
                h += '<div class="grid"><div class="gl"></div>' + Array.from({ length: 24 }, (_, i) => '<div class="gh">' + pad(i) + '</div>').join('');
                grid.forEach((p) => {
                    h += '<div class="gl" data-city="' + esc(p.c.id) + '">' + esc(p.c.name) + '</div>';
                    const byH = {}; p.c.days[d].hours.forEach((y) => { byH[y.h] = y; });
                    for (let i = 0; i < 24; i++) {
                        const y = byH[i];
                        const cls = (y && y.un ? 'red' : '') + (y && y.blk ? ' blk' : ''); // 1.7.309: every unassigned hour red; blocked hours striped
                        h += '<div class="gc ' + cls + '" data-city="' + esc(p.c.id) + '" title="' + esc(p.c.name) + ' ' + pad(i) + ':00' + (y ? ' · ' + y.un + ' without driver · ' + y.as + ' assigned · ' + y.adj + ' drivers (adj) · ' + y.drv + ' drivers' + (y.blk ? ' · blocked' : '') : '') + '">' + (y && y.un ? y.un : '') + '</div>';
                    }
                });
                h += '</div>';
            }
            h += '</div>';
        }

        // events + Slack for the period
        const evs = [];
        all.forEach((p) => p.events.forEach((e) => evs.push({ c: p.c, e: e })));
        evs.sort((a, b) => (isHigh(b.e) - isHigh(a.e)) || (a.e.from < b.e.from ? -1 : 1));
        h += '<div class="row3"><div class="card list"><div class="head"><h2>Events ' + label.toLowerCase() + '</h2><span class="note">' + k.high + ' big of ' + evs.length + '</span></div>';
        h += evs.length ? evs.slice(0, 10).map((x) => '<div class="li" data-city="' + esc(x.c.id) + '"><div><b>' + esc(x.e.name) + '</b><div class="s">' + esc(x.c.name) + ' &middot; ' + dayName(x.e.from) + (x.e.to !== x.e.from ? ' to ' + dayName(x.e.to) : '') + (x.e.supply != null ? ' &middot; supply ' + x.e.supply + '%' : '') + '' + '</div></div><span class="pill ' + (isHigh(x.e) ? 'red' : /medium/i.test(x.e.gravity) ? 'amber' : 'grey') + '">' + esc(x.e.gravity || 'event') + '</span></div>').join('') : '<div class="empty">No events in the sheet for ' + label.toLowerCase() + '.</div>';
        h += '</div><div class="card list"><div class="head"><h2>Latest from Slack</h2><button class="link" data-go="slack">All &rarr;</button></div>';
        h += cache.slack.length ? cache.slack.slice(0, 6).map((s) => '<div class="li"' + (s.cities && s.cities[0] ? ' data-city="' + esc(s.cities[0]) + '"' : '') + '><div><div class="s">#' + esc(s.channel) + ' &middot; ' + esc(s.who) + ' &middot; ' + ago(s.ts) + '</div>' + esc(s.text.slice(0, 160)) + (s.text.length > 160 ? '&hellip;' : '') + '</div></div>').join('') : '<div class="empty">No Slack posts read yet.</div>';
        h += '</div></div>';
        $('main').innerHTML = h;
    }
    let showAll = false;
    let openTile = null;
    function ago(ts) {
        const min = Math.round((Date.now() / 1000 - ts) / 60);
        if (min < 60) return min + ' min ago';
        if (min < 1440) return Math.round(min / 60) + ' h ago';
        return Math.round(min / 1440) + ' d ago';
    }

    function renderTable(m, list) {
        let h = '<div class="legend"><span><span class="chip red">red</span> fewer drivers than jobs in some hour</span><span><span class="chip amber">amber</span> transfers without a driver</span><span>big number = transfers without a driver (CRM) &middot; small = drivers per unassigned job in the worst hour</span></div>';
        h += '<div class="card tablecard"><table><thead><tr><th>City</th><th>Open actions</th><th>Loss / wk</th>' + m.dates.map((d, i) => '<th style="text-align:center">' + (i === 0 ? 'Today' : dayName(d)) + '</th>').join('') + '</tr></thead><tbody>';
        list.slice(0, 400).forEach((c) => {
            h += '<tr class="city" data-city="' + esc(c.id) + '"><td><b>' + esc(c.name) + '</b>' + (c.slack.length ? ' <span class="pill grey">Slack ' + c.slack.length + '</span>' : '') + '</td><td>' + (c.open ? '<span class="pill ' + (cityLevel(c, m.dates) || 'grey') + '">' + c.open + '</span>' : '') + '</td><td>' + (c.outlook && c.outlook.loss ? '&euro;' + fmt(c.outlook.loss) : '') + '</td>';
            m.dates.forEach((d) => {
                const x = c.days[d] || {};
                const evs = c.events.filter((e) => e.from <= d && e.to >= d);
                const cls = cellClass(x) || 'ok';
                let t = '';
                if (x.crm || x.em != null) t = '<span class="chip ' + cls + '" title="without a driver (' + (x.em != null ? 'Em Hailing list' : 'CRM') + ')' + (x.crm ? ' · worst hour: ' + (x.crm.worst != null ? x.crm.worst + ' drivers per unassigned job' : 'no unassigned') + ' · ' + x.crm.un + ' unassigned' : '') + '">' + fmt(unOf(x)) + (x.crm && x.crm.worst != null ? '<small>' + x.crm.worst + '&times;</small>' : '') + '</span>';
                if (evs.length) t += '<span class="ev" title="' + esc(evs.map((e) => e.name + ' (' + (e.gravity || '-') + ')').join(', ')) + '">' + esc(evs[0].name.slice(0, 14)) + (evs.length > 1 ? ' +' + (evs.length - 1) : '') + '</span>';
                h += '<td class="day">' + (t || '<span style="color:var(--faint)">&middot;</span>') + '</td>';
            });
            h += '</tr>';
        });
        h += '</tbody></table></div>';
        if (!Object.keys(cache.crm).length) h += '<p class="note">CRM hours not read yet: press Refresh.</p>';
        $('main').innerHTML = h;
    }

    function spark(values, color) {
        const v = values.filter((x) => x != null);
        if (v.length < 2) return '<span class="note">Not enough history yet.</span>';
        const max = Math.max.apply(null, v.concat([1])), w = 480, hgt = 44;
        const pts = values.map((x, i) => x == null ? null : (i * w / (values.length - 1)).toFixed(1) + ',' + (hgt - (x / max) * hgt).toFixed(1)).filter(Boolean).join(' ');
        return '<svg class="spark" viewBox="0 0 ' + w + ' ' + (hgt + 2) + '" preserveAspectRatio="none"><polyline fill="none" stroke="' + color + '" stroke-width="2" points="' + pts + '"/></svg>';
    }

    // 1.7.307: ghas summary of a city's Slack posts. Uses the local AI on
    // this PC (settings copied from the CRM page) when it is on; otherwise a
    // plain summary. Slack text only goes to localhost, never to the relay.
    const ghasCache = {};
    let aiCfg = null, aiModels = null;
    chrome.storage.local.get('wp_ai_cfg_mirror_v1').then((o) => { aiCfg = o.wp_ai_cfg_mirror_v1 || null; }).catch(() => {});
    // 1.7.308: model dropdown. The list comes from the model server on this
    // PC; a pick is saved here and copied back to mod's settings on the CRM.
    async function ghasModels() {
        const el = $('ghasModel');
        if (!el) return;
        if (!aiCfg) { el.innerHTML = '<option>open the CRM once</option>'; el.disabled = true; return; }
        if (!aiModels) {
            let r = null;
            try { r = await chrome.runtime.sendMessage({ type: 'WP_AI_MODELS', url: aiCfg.url }); } catch (_) {}
            aiModels = r && r.ok ? r.models : [];
        }
        const list = aiModels.slice();
        if (aiCfg.model && !list.includes(aiCfg.model)) list.unshift(aiCfg.model);
        const box = $('ghasModel');
        if (!box) return;
        box.disabled = !list.length;
        box.innerHTML = list.length ? (aiCfg.model ? '' : '<option value="">choose a model</option>') + list.map((x) => '<option' + (x === aiCfg.model ? ' selected' : '') + '>' + esc(x) + '</option>').join('') : '<option>no model server found</option>';
    }
    async function ghasPickModel(name) {
        aiCfg = Object.assign({}, aiCfg, { model: name, on: true });
        try { await chrome.storage.local.set({ wp_ai_cfg_mirror_v1: aiCfg, wp_ai_model_pick_v1: { model: name, at: Date.now() } }); } catch (_) {}
        Object.keys(ghasCache).forEach((k) => delete ghasCache[k]);
        const m = model();
        const c = m.cities.find((x) => x.id === selected);
        if (c) renderDrawer(c, drawerDates(m));
    }
    const GHAS_WORDS = [['strike', /strike|walkout/i], ['marathon / race', /marathon|race\b|run\b/i], ['closures', /clos(ed|ure)|road ?block|traffic/i], ['raise prices', /raise|surge|price/i], ['blocked slots', /block/i], ['cancellations', /cancel/i], ['weather', /storm|snow|flood|weather|wind/i], ['airport / flights', /airport|flight|terminal/i], ['events', /event|concert|festival|match|conference|congress/i]];
    function ghasSig(c) { return c.slack.slice(0, 10).map((s) => s.ts).join(','); }
    function ghasPlain(c) {
        const posts = c.slack.slice(0, 10);
        const per = {};
        posts.forEach((s) => { per[s.channel] = (per[s.channel] || 0) + 1; });
        const all = posts.map((s) => s.text).join(' ');
        const topics = GHAS_WORDS.filter((w) => w[1].test(all)).map((w) => w[0]);
        return posts.length + ' post' + (posts.length === 1 ? '' : 's') + ' in the last 7 days (' + Object.keys(per).map((k) => '#' + k + ' ' + per[k]).join(', ') + '), latest ' + ago(posts[0].ts) + ' by ' + (posts[0].who || 'someone') + '.' + (topics.length ? ' Topics: ' + topics.join(', ') + '.' : '');
    }
    function ghasHtml(c) {
        if (!c.slack.length) return '<div class="note">Nothing on Slack about this city in the last 7 days.</div>';
        const hit = ghasCache[c.id];
        if (hit && hit.sig === ghasSig(c) && hit.text) return '<div>' + esc(hit.text).replace(/\n/g, '<br>') + '</div><div class="note">Local AI' + (hit.model ? ' (' + esc(hit.model) + ')' : '') + '.</div>';
        return '<div>' + esc(ghasPlain(c)) + '</div>' + (hit && hit.busy ? '<div class="note">Asking the local AI...</div>' : '<div class="note">Plain summary. Turn on the local AI in mod on the CRM for a written one.</div>');
    }
    async function ghasAsk(c) {
        if (!c || !c.slack.length) return;
        const sig = ghasSig(c);
        const hit = ghasCache[c.id];
        if (hit && hit.sig === sig && (hit.text || hit.busy || hit.failed)) return;
        let cfg = null;
        try { cfg = (await chrome.storage.local.get('wp_ai_cfg_mirror_v1')).wp_ai_cfg_mirror_v1; } catch (_) {}
        aiCfg = cfg || aiCfg;
        if (!cfg || !cfg.on || !cfg.model) return;
        ghasCache[c.id] = { sig, busy: true };
        const paint = () => { const el = $('ghas'); if (el && selected === c.id) el.innerHTML = ghasHtml(c); };
        paint();
        const posts = c.slack.slice(0, 10).map((s) => '#' + s.channel + ' ' + new Date(s.ts * 1000).toISOString().slice(0, 16) + ' ' + (s.who || '') + ': ' + s.text.slice(0, 600)).join('\n');
        let r = null;
        try {
            r = await chrome.runtime.sendMessage({ type: 'WP_AI_ASK', url: cfg.url, model: cfg.model, messages: [
                { role: 'system', content: 'You help an operations manager of an airport transfer company. Summarise the Slack posts about ' + c.name + ' in at most 4 short plain sentences: what is happening, which dates, and what the team is asked to do. No lists, no greetings.' },
                { role: 'user', content: posts }
            ] });
        } catch (_) {}
        ghasCache[c.id] = r && r.ok && r.text ? { sig, text: String(r.text).trim(), model: cfg.model } : { sig, failed: true };
        paint();
    }
    function renderDrawer(c, dates) {
        if (!c) { closeDrawer(); return; }
        $('backdrop').hidden = false; $('drawer').hidden = false;
        const lvl = cityLevel(c, dates);
        let h = '<div class="dh"><div style="flex:1"><h2>' + esc(c.name) + '</h2><div class="sub">' + esc([c.em && c.em.prio, c.em && c.em.type, c.em && c.em.cm && 'City manager ' + c.em.cm].filter(Boolean).join(' · ')) + '</div></div><span class="pill ' + (lvl || 'green') + '" style="margin-top:8px">' + (lvl === 'red' ? 'needs attention' : lvl === 'amber' ? 'watch' : 'fine') + '</span><button class="close" id="close" title="Close">&times;</button></div>';
        // 1.7.308: order is ghas summary (purple, like mod's suggestions in the CRM), Slack posts, day by day, what to do.
        h += '<div class="card ghas"><div class="ghead"><h3>ghas summary</h3><select id="ghasModel" title="Local AI model"><option>' + esc(aiCfg && aiCfg.model || 'model') + '</option></select></div><div id="ghas">' + ghasHtml(c) + '</div></div>';
        h += '<div class="card"><h3>Slack, last 7 days</h3>';
        if (!c.slack.length) h += '<div class="note">No posts naming this city.</div>';
        c.slack.slice(0, 10).forEach((s) => { h += '<div class="msg"><div class="m">#' + esc(s.channel) + ' &middot; ' + esc(s.who) + ' &middot; ' + ago(s.ts) + '</div>' + esc(s.text.slice(0, 500)) + '</div>'; });
        h += '</div>';
        h += '<div class="card"><h3>Day by day</h3>';
        dates.forEach((d, i) => {
            const x = c.days[d] || {};
            const un = unOf(x);
            const hrs = x.hours || [];
            const unH = hrs.filter((y) => y.un > 0);
            const row = (y) => '<tr class="' + (y.un > 0 && (y.adj || 0) < y.un ? 'shortrow' : '') + '"><td>' + pad(y.h) + ':00</td><td>' + y.drv + '</td><td>' + y.adj + '</td><td>' + y.as + '</td><td>' + (y.un || '') + '</td><td>' + (y.blk ? '<span class="pill amber">blocked</span>' : '') + '</td></tr>';
            const head = '<table><thead><tr><th>Hour</th><th>Drivers</th><th>Adj</th><th>Assigned</th><th>No driver</th><th></th></tr></thead><tbody>';
            h += '<details class="dayrow"' + (un > 0 || unH.length ? ' open' : '') + '><summary><b>' + (d === iso(new Date()) ? 'Today' : d === iso(new Date(Date.now() + 864e5)) ? 'Tomorrow' : dayName(d)) + '</b> <span class="pill ' + (cellClass(x) || 'green') + '">' + (x.crm || x.em != null ? fmt(un) + ' without a driver' : 'not read yet') + '</span>' + (x.crm && x.crm.worst != null && un > 0 ? ' <span class="m">worst hour ' + x.crm.worst + '&times;' + (x.crm.worstHour != null ? ' at ' + pad(x.crm.worstHour) + ':00' : '') + '</span>' : '') + '</summary>';
            if (unH.length) h += '<div class="htable">' + head + unH.map(row).join('') + '</tbody></table></div>';
            else if (un > 0) h += '<p class="note">' + fmt(un) + ' without a driver on the Em Hailing list; hours not read yet.</p>';
            if (hrs.length) h += '<details class="htable"><summary>All time slots</summary>' + head + hrs.map(row).join('') + '</tbody></table></details>';
            if (x.hub) h += '<p class="note">Hub, for comparison: ' + fmt(x.hub.booked) + ' booked, about ' + fmt(x.hub.forecast) + ' expected, ' + fmt(x.hub.net) + ' drivers free.</p>';
            h += '</details>';
        });
        h += '<p class="note"><span style="color:var(--red)">Red rows</span>: fewer drivers (adjusted for acceptance) than unassigned jobs.</p></div>';
        h += '<div class="card"><h3>What to do</h3>';
        if (!c.actions.length) h += '<div class="note">Nothing needed from what mod can see.</div>';
        c.actions.forEach((a) => {
            h += '<label class="act' + (done[a.key] ? ' done' : '') + '"><input type="checkbox" data-key="' + esc(a.key) + '"' + (done[a.key] ? ' checked' : '') + '><span><b>' + esc(a.text) + '</b><div class="w">' + esc(a.why) + '</div></span></label>';
        });
        h += '</div>';
        h += '<div class="card"><h3>Events this week</h3>';
        if (!c.events.length) h += '<div class="note">None in the events sheet.</div>';
        c.events.forEach((e) => {
            h += '<div class="msg"><b>' + esc(e.name) + '</b> <span class="pill ' + (isHigh(e) ? 'red' : /medium/i.test(e.gravity) ? 'amber' : 'grey') + '">' + esc(e.gravity || '-') + '</span><div class="m">' + esc([dayName(e.from) + (e.to !== e.from ? ' to ' + dayName(e.to) : ''), e.type, e.supply != null && 'supply ' + e.supply + '%', e.dri && 'DRI ' + e.dri, 'LiveOps: ' + (e.affected || 'nothing yet')].filter(Boolean).join(' · ')) + '</div>' + (e.notes ? '<div>' + esc(e.notes) + '</div>' : '') + (e.comments ? '<div class="m">' + esc(e.comments) + '</div>' : '') + '</div>';
        });
        h += '</div>';
        if (c.outlook) h += '<div class="card"><h3>Hub outlook</h3><div><b>&euro;' + fmt(c.outlook.loss) + '</b> loss / week &middot; ' + esc(c.outlook.vs || '') + ' vs last week</div><div class="note">' + esc(c.outlook.lever || '') + ' &middot; ' + esc(c.outlook.owner || '') + '</div></div>';
        const mine = history.filter((r) => r.city === c.id).sort((a, b) => a.date < b.date ? -1 : 1).slice(-30);
        h += '<div class="card"><h3>Last 30 days</h3><div class="note">Unassigned</div>' + spark(mine.map((r) => r.un), '#121a3a') + '<div class="note">Hub gap</div>' + spark(mine.map((r) => r.gap), '#5b6ee1') + '</div>';
        $('drawer').innerHTML = h;
        ghasAsk(c);
        ghasModels();
    }
    function closeDrawer() { selected = null; $('backdrop').hidden = true; $('drawer').hidden = true; }

    function renderSlack() {
        const names = {}; cache.cities.forEach((c) => { names[c.id] = c.name; });
        let h = '<div class="card list">';
        if (!cache.slack.length) h += '<div class="empty">No Slack posts read yet: press Refresh.</div>';
        cache.slack.slice(0, 300).forEach((s) => {
            h += '<div class="li"' + (s.cities && s.cities[0] ? ' data-city="' + esc(s.cities[0]) + '"' : '') + '><div><div class="s">#' + esc(s.channel) + ' &middot; ' + esc(s.who) + ' &middot; ' + ago(s.ts) + ((s.cities || []).length ? ' &middot; ' + esc(s.cities.map((id) => names[id]).join(', ')) : '') + '</div>' + esc(s.text.slice(0, 600)) + '</div></div>';
        });
        $('main').innerHTML = h + '</div>';
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
        const diff = (a, b) => a == null || b == null || !b ? '' : ' <span class="pill ' + (a > b ? 'red' : 'green') + '">' + (a >= b ? '+' : '') + Math.round((a - b) / b * 100) + '%</span>';
        let h = '<div class="card tablecard"><table><thead><tr><th>Event</th><th>City</th><th>Date</th><th>Sheet said</th><th>Unassigned vs a normal week</th><th>Hub gap vs normal</th><th>Peak drivers vs normal</th></tr></thead><tbody>';
        rows.sort((a, b) => a.e.from < b.e.from ? 1 : -1).forEach((r) => {
            h += '<tr><td><b>' + esc(r.e.name) + '</b></td><td>' + esc(r.name) + '</td><td>' + dayName(r.e.from) + '</td><td>' + esc(r.e.gravity || '-') + (r.e.supply != null ? ', supply ' + r.e.supply + '%' : '') + '</td><td>' + fmt(r.un) + ' vs ' + fmt(r.unB) + diff(r.un, r.unB) + '</td><td>' + fmt(r.gap) + ' vs ' + fmt(r.gapB) + diff(r.gap, r.gapB) + '</td><td>' + fmt(r.adj) + ' vs ' + fmt(r.adjB) + diff(r.adj, r.adjB) + '</td></tr>';
        });
        h += '</tbody></table></div>';
        if (!rows.length) h = '<div class="card"><h2>Event retro</h2><p class="note">No finished event has history yet. History started on the day this version was installed. Events that end from now on show up here, compared with the same weekday in the 4 weeks before, so you can see which events really hurt and whether the sheet’s gravity was right.</p></div>';
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
        let h = '<div class="legend">Per day on average: unassigned &middot; hub gap. Then: days with a short hour &middot; days with an event.</div><div class="card tablecard"><table><thead><tr><th>City</th>' + months.map((mo) => '<th>' + mo + '</th>').join('') + '</tr></thead><tbody>';
        cities.forEach((id) => {
            h += '<tr class="city" data-city="' + esc(id) + '"><td><b>' + esc(names[id] || id) + '</b></td>' + months.map((mo) => { const x = g[id + '|' + mo]; return '<td>' + (x ? (x.un / x.n).toFixed(1) + ' &middot; ' + (x.gap / x.n).toFixed(1) + ' &middot; ' + x.short + ' &middot; ' + x.ev : '<span style="color:var(--faint)">&middot;</span>') + '</td>'; }).join('') + '</tr>';
        });
        h += '</tbody></table></div>';
        if (!history.length) h = '<div class="card"><h2>Month</h2><p class="note">No history yet. mod saves one record per city and day from now on (the nightly read covers every city), so next month you can compare month against month.</p></div>';
        $('main').innerHTML = h;
    }

    // ---- history: one record per city and day, the latest read wins ----
    async function saveHistory() {
        const m = model();
        const recs = [];
        m.cities.forEach((c) => {
            m.dates.forEach((d) => {
                const x = c.days[d];
                if (!x || (!x.hub && !x.crm && x.em == null)) return;
                recs.push({
                    k: c.id + '|' + d, city: c.id, date: d, at: Date.now(),
                    gap: x.hub ? x.hub.gap : null, gapPct: x.hub ? x.hub.gapPct : null, hubUn: x.hub ? x.hub.un : null, booked: x.hub ? x.hub.booked : null,
                    forecast: x.hub ? x.hub.forecast : null, net: x.hub ? x.hub.net : null, gfs: x.hub ? x.hub.gfs : null,
                    un: x.crm || x.em != null ? unOf(x) : null, as: x.crm ? x.crm.as : null, adjPeak: x.crm ? x.crm.adjPeak : null,
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
            // 1.7.305: every city from the CRM (the hub is off), 4 pages at a time;
            // the open city and cities with big events first
            const m = model();
            const first = m.cities.filter((c) => c.id === selected || c.events.some(isHigh));
            const seen = {};
            const targets = first.concat(cache.cities).filter((c) => c && !seen[c.id] && (seen[c.id] = 1));
            let next = 0, doneN = 0, stop = false;
            const worker = async () => {
                while (!stop && next < targets.length) {
                    const c = targets[next++];
                    const ok = await step('crm', () => readCrmCity(c));
                    if (!ok) { stop = true; break; }
                    doneN++;
                    $('status').textContent = 'CRM ' + doneN + ' / ' + targets.length + ' cities';
                    if (doneN % 25 === 0) { await saveCache(); render(); }
                }
            };
            await Promise.all([worker(), worker(), worker(), worker()]);
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
    function openCity(id) { selected = id; render(); }
    function drawerDates(m) { return tab === 'home' ? periodDates(m) : m.dates; }
    $('main').addEventListener('click', (e) => {
        const per = e.target.closest('[data-period]');
        const tl = e.target.closest('[data-tile]');
        if (tl) { const t = tl.getAttribute('data-tile'); openTile = openTile === t ? null : t; render(); return; }
        if (per) { period = per.getAttribute('data-period'); showAll = false; try { localStorage.setItem(PERIOD_KEY, period); } catch (_) {} render(); return; }
        if (e.target.closest('[data-showall]')) { showAll = !showAll; render(); return; }
        const go = e.target.closest('[data-go]');
        if (go) { const t = go.getAttribute('data-go'); setTab(t === 'slack' ? 'slack' : 'cities'); if (t === 'red' || t === 'cities') $('sort').value = 'action'; if (t === 'loss') $('sort').value = 'loss'; render(); return; }
        const row = e.target.closest('[data-city]');
        if (row) openCity(row.getAttribute('data-city'));
    });
    $('backdrop').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
    $('drawer').addEventListener('click', (e) => {
        if (e.target.closest('#close')) { closeDrawer(); return; }
        const b = e.target.closest('button[data-day]');
        if (!b) return;
        const m = model();
        const c = m.cities.find((x) => x.id === selected);
        if (c) { c._day = b.getAttribute('data-day'); renderDrawer(c, drawerDates(m)); }
    });
    $('drawer').addEventListener('change', async (e) => {
        if (e.target.id === 'ghasModel') { if (e.target.value) ghasPickModel(e.target.value); return; }
        const k = e.target.getAttribute && e.target.getAttribute('data-key');
        if (!k) return;
        if (e.target.checked) done[k] = Date.now(); else delete done[k];
        await chrome.storage.local.set({ [DONE_KEY]: done });
        render();
    });
    function setTab(t) {
        tab = t;
        document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x.getAttribute('data-tab') === t));
    }
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { setTab(b.getAttribute('data-tab')); render(); }));
    $('search').addEventListener('input', () => { if (tab === 'home' && $('search').value) setTab('cities'); render(); });
    $('sort').addEventListener('change', () => { if (tab === 'home') setTab('cities'); render(); });
    // 1.7.304: dark by default; the choice is remembered
    function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); $('theme').textContent = t === 'dark' ? 'Light' : 'Dark'; try { localStorage.setItem('wp_ov_theme', t); } catch (_) {} }
    applyTheme((function() { try { return localStorage.getItem('wp_ov_theme') || 'dark'; } catch (_) { return 'dark'; } })());
    $('theme').addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
    $('refresh').addEventListener('click', () => refresh(false));
    $('full').addEventListener('click', () => refresh(true));

    (async function start() {
        const got = await chrome.storage.local.get({ [CACHE_KEY]: null, [DONE_KEY]: {}, [KPI_KEY]: {}, [EM_LIST_KEY]: null });
        emList = got[EM_LIST_KEY];
        kpiHist = got[KPI_KEY] || {};
        Object.keys(kpiHist).forEach((d) => { if (d < iso(addDays(today(), -14))) delete kpiHist[d]; });
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
