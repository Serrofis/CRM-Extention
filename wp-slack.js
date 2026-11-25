// wlcm 1.7.538: Slack for the tablet's Chats tab, read in the box's browser (user, 22 Nov 2026: "Box's browser";
// only the channels picked on the tablet + your DMs; a reply goes out only when you tap Send on the tablet).
// Runs on the box only (Linux, not ChromeOS / Android), in its Slack web tab (background.js keeps one open). It asks
// Slack's own web API from this page with this page's own sign-in — the calls Slack's web app makes itself; the
// sign-in never leaves the browser. To the relay go only chat names, unread / mention counts, the newest message
// line of an unread chat, and an opened chat's last 30 messages. Nothing is clicked or typed on Slack's page.
(function() {
    'use strict';
    if (window.top !== window) return;
    const ua = navigator.userAgent || '';
    if (!/Linux/.test(ua) || /Android|CrOS/.test(ua)) return;

    const send = function(body) {
        // 1.7.543: wlcm was reloaded (an update): this page lost it — reload, so the new wlcm reads Slack again
        try { if (!chrome.runtime || !chrome.runtime.id) { location.reload(); return Promise.resolve(null); } } catch (_) { location.reload(); return Promise.resolve(null); }
        return new Promise(function(resolve) {
            try { chrome.runtime.sendMessage({ type: 'WP_SLACK_SYNC', body: body }, function(answer) { void chrome.runtime.lastError; resolve(answer || null); }); }
            catch (_) { resolve(null); }
        });
    };
    const OUT = 'Slack is signed out on the box — sign in there once (noVNC).';
    // Slack's sign-in pages (slack.com, <workspace>.slack.com): only the tablet is told
    if (location.hostname !== 'app.slack.com') {
        if (/sign-?in|login|sso|oauth|get-started|checkcookie/i.test(location.pathname + location.search)) {
            setTimeout(function() { send({ signedIn: false, why: OUT }); }, 4000);
            setInterval(function() { send({ signedIn: false, why: OUT }); }, 60000);
        }
        return;
    }

    let team = null;          // { id, name, url, token, user } from Slack's own local settings
    const names = {};         // conversation / user id -> name
    const previews = {};      // conversation id -> { latest, text }
    let pick = [];            // channel ids picked on the tablet
    let chansAt = 0, roundAt = 0, pollAt = 0, busy = false, fast = false;

    const readTeam = function() {
        try {
            const cfg = JSON.parse(localStorage.getItem('localConfig_v2') || 'null');
            const teams = cfg && cfg.teams && typeof cfg.teams === 'object' ? cfg.teams : null;
            if (!teams) return null;
            const id = cfg.lastActiveTeamId && teams[cfg.lastActiveTeamId] ? cfg.lastActiveTeamId : Object.keys(teams)[0];
            const t = id ? teams[id] : null;
            if (!t || !t.token) return null;
            const url = String(t.url || (t.domain ? 'https://' + t.domain + '.slack.com/' : '')).replace(/\/*$/, '/');
            if (!/^https:\/\/[a-z0-9-]+(\.enterprise)?\.slack\.com\/$/i.test(url)) return null;
            return { id: String(id), name: String(t.name || ''), url: url, token: String(t.token), user: String(t.user_id || '') };
        } catch (_) { return null; }
    };
    // One Slack web API call. Blocked here (CORS / network) → background.js asks the same thing.
    const api = async function(method, params) {
        const url = team.url + 'api/' + method;
        const fields = Object.assign({ token: team.token }, params || {});
        const form = new FormData();
        Object.keys(fields).forEach(function(k) { if (fields[k] !== undefined && fields[k] !== null && fields[k] !== '') form.append(k, String(fields[k])); });
        // 1.7.543: the page asks first (as up to 1.7.541: it read fine); background.js only when the page's request
        // fails, with a 10 s limit (1.7.542 asked the background first and stalled with no answer).
        let j = null, pageFailed = false;
        try {
            const r = await fetch(url, { method: 'POST', body: form, credentials: 'include' });
            j = await r.json();
        } catch (_) { pageFailed = true; }
        if (pageFailed) {
            // a reply may have reached Slack although the page could not read the answer: never sent twice
            if (method === 'chat.postMessage' && params && params.channel && await landed(params.channel, params.text, params.thread_ts)) return { ok: true, checked: true };
            j = await new Promise(function(resolve) {
                const limit = setTimeout(function() { resolve(null); }, 10000);
                try { chrome.runtime.sendMessage({ type: 'WP_SLACK_API', url: url, form: fields }, function(a) { void chrome.runtime.lastError; clearTimeout(limit); resolve(a || null); }); }
                catch (__) { clearTimeout(limit); resolve(null); }
            });
        }
        if (j && j.ok) return j;
        throw new Error((j && j.error) || 'no answer');
    };
    // 1.7.543: is this text already the newest message from me in that chat (sent in the last 2 min)?
    const landed = async function(channel, text, th) {
        try {
            const h = th ? await api('conversations.replies', { channel: channel, ts: th, limit: '200' }) : await api('conversations.history', { channel: channel, limit: '5' }); // 1.7.554: a thread reply is only in its thread
            const want = String(text || '').trim();
            return (h.messages || []).some(function(m) { return m.user === team.user && String(m.text || '').trim() === want && Date.now() - Number(String(m.ts).split('.')[0]) * 1000 < 120000; });
        } catch (_) { return false; }
    };
    const tsMs = function(ts) { const n = Number(String(ts || '').split('.')[0]); return n > 0 ? n * 1000 : 0; };
    const hhmm = function(ts) {
        const ms = tsMs(ts);
        if (!ms) return '';
        const d = new Date(ms), n = new Date();
        const t = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        return d.toDateString() === n.toDateString() ? t : String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + ' ' + t;
    };
    const userName = async function(id) {
        if (!id) return '';
        if (names[id]) return names[id];
        try {
            const u = (await api('users.info', { user: id })).user || {};
            const p = u.profile || {};
            names[id] = String(p.display_name || p.real_name || u.real_name || u.name || id).slice(0, 60);
        } catch (_) { names[id] = id; }
        return names[id];
    };
    const chatName = async function(id) {
        if (names[id]) return names[id];
        try {
            const ch = (await api('conversations.info', { channel: id })).channel || {};
            if (ch.is_im && ch.user) names[id] = await userName(ch.user);
            else if (ch.is_mpim && ch.name) names[id] = String(ch.name).replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').join(', ');
            else names[id] = ch.name ? '#' + ch.name : id;
        } catch (_) { names[id] = id; }
        return names[id];
    };
    // Slack's message markup → plain text (people and channels by name, links by their label)
    const clean = async function(text) {
        let t = String(text || '');
        const people = t.match(/<@[A-Z0-9]+(?:\|[^>]*)?>/g) || [];
        for (const m of people) t = t.split(m).join('@' + await userName(m.slice(2).replace(/[|>].*$/, '')));
        t = t.replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1').replace(/<!(here|channel|everyone)[^>]*>/g, '@$1').replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '$1')
            .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '[$2]($1)') /* 1.7.539: a linked word keeps its link (the tablet opens transfers from it) */.replace(/<(https?:[^>]+)>/g, '$1').replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1');
        return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
    };
    const fromOf = async function(m) { return m.user ? await userName(m.user) : String(m.username || (m.bot_profile && m.bot_profile.name) || 'app'); };
    // Unread / mention counts of every conversation (the numbers Slack's own sidebar shows)
    const counts = async function() {
        const out = [];
        try {
            const c = await api('client.counts', { thread_counts_by_channel: 'false', org_wide_aware: 'true' });
            (c.channels || []).forEach(function(x) { out.push({ id: x.id, kind: 'ch', unread: Boolean(x.has_unreads), mentions: Number(x.mention_count) || 0, latest: String(x.latest || '') }); });
            (c.mpims || []).concat(c.ims || []).forEach(function(x) { out.push({ id: x.id, kind: 'dm', unread: Boolean(x.has_unreads), mentions: Number(x.mention_count) || 0, latest: String(x.latest || '') }); });
            return out;
        } catch (e) {
            if (/invalid_auth|not_authed|token_revoked|account_inactive/.test(String(e && e.message))) throw e;
        }
        const c = await api('users.counts', { simple_unreads: 'true', mpim_aware: 'true', include_threads: 'false' }); // older method
        (c.channels || []).concat(c.groups || []).forEach(function(x) { if (x.is_member === false) return; out.push({ id: x.id, kind: 'ch', unread: Number(x.unread_count_display || x.unread_count || 0) > 0, mentions: Number(x.mention_count_display || x.mention_count || 0), latest: String(x.latest || '') }); });
        (c.mpims || []).concat(c.ims || []).forEach(function(x) { out.push({ id: x.id, kind: 'dm', unread: Number(x.dm_count || x.unread_count_display || 0) > 0, mentions: Number(x.dm_count || x.mention_count_display || 0), latest: String(x.latest || '') }); });
        return out;
    };
    // The channels you are in, for the picker on the tablet
    const channels = async function() {
        const out = [];
        let cursor = '';
        for (let i = 0; i < 6; i++) {
            const r = await api('users.conversations', { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200', cursor: cursor });
            (r.channels || []).forEach(function(c) { if (c && c.id && c.name) { names[c.id] = '#' + c.name; out.push({ id: c.id, name: '#' + c.name }); } });
            cursor = r.response_metadata && r.response_metadata.next_cursor ? String(r.response_metadata.next_cursor) : '';
            if (!cursor) break;
        }
        return out.sort(function(a, b) { return a.name.localeCompare(b.name); }).slice(0, 600);
    };
    // 1.7.554: th = a thread (its parent message's ts): that thread's messages instead of the channel's
    const readChat = async function(id, th) {
        const h = th ? await api('conversations.replies', { channel: id, ts: th, limit: '60' }) : await api('conversations.history', { channel: id, limit: '30' });
        const skip = ['channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'group_join', 'group_leave'];
        const msgs = [];
        for (const m of (th ? (h.messages || []) : (h.messages || []).slice().reverse())) { // replies come oldest first
            if (m.subtype && skip.indexOf(m.subtype) >= 0) continue;
            let x = await clean(m.text || '');
            if (!x && Array.isArray(m.files) && m.files.length) x = '[file: ' + m.files.map(function(f) { return f.name || f.title || 'file'; }).join(', ').slice(0, 120) + ']';
            if (!x) continue;
            msgs.push({ t: hhmm(m.ts), w: await fromOf(m), x: x.slice(0, 1000), me: Boolean(team.user && m.user === team.user), ts: String(m.ts || ''), rc: th ? 0 : Number(m.reply_count) || 0 }); // 1.7.554: ts + reply count (threads)
        }
        return { id: id, th: th || '', name: await chatName(id), ok: true, msgs: msgs, at: Date.now() };
    };
    // A command from the tablet: read a chat, or send a reply (typed there, Send tapped there) and read it again
    const ranKeys = {}; // 1.7.542: a command is run once, whatever hands it over again
    const run = async function(cmd) {
        const key = String(cmd && cmd.key || '');
        if (key) { if (ranKeys[key]) return null; ranKeys[key] = Date.now(); }
        const id = String(cmd && cmd.item || '');
        if (!/^[CDG][A-Z0-9]{6,15}$/.test(id)) return null;
        if (!team) team = readTeam();
        const th = /^\d{9,11}\.\d{1,8}$/.test(String(cmd.th || '')) ? String(cmd.th) : ''; // 1.7.554: a thread
        if (cmd.th && !th) return { id: id, ok: false, err: 'That thread could not be found — nothing sent', at: Date.now() }; // never posted in the channel instead
        if (!team) return { id: id, th: th, ok: false, err: OUT, at: Date.now() };
        if (cmd.op === 'reply') {
            const text = String(cmd.text || '').trim().slice(0, 2000);
            if (!text) return null;
            try { await api('chat.postMessage', th ? { channel: id, text: text, thread_ts: th } : { channel: id, text: text }); }
            catch (e) { return { id: id, th: th, ok: false, err: 'Your reply was NOT sent: ' + String(e && e.message || e).slice(0, 120), at: Date.now() }; }
        } else if (cmd.op !== 'open') return null;
        try { return await readChat(id, th); }
        catch (e) { return { id: id, th: th, ok: false, err: (cmd.op === 'reply' ? 'Sent, but the chat could not be read again: ' : 'Could not read it: ') + String(e && e.message || e).slice(0, 120), at: Date.now() }; }
    };
    // The relay's answer: the picked channels, whether the tablet is open (then commands are asked for every 5 s), commands
    const take = async function(answer) {
        const queue = [];
        const absorb = function(a) {
            if (!a || !a.ok) return;
            if (Array.isArray(a.pick)) pick = a.pick.map(String);
            fast = Boolean(a.fast);
            (Array.isArray(a.cmds) ? a.cmds : []).forEach(function(c) { queue.push(c); });
        };
        absorb(answer);
        for (let n = 0; n < 6 && queue.length; n++) {
            const chat = await run(queue.shift());
            if (chat) absorb(await send({ chat: chat }));
        }
    };
    const round = async function() {
        if (busy) return;
        busy = true;
        roundAt = Date.now();
        try {
            team = readTeam();
            if (!team) { await take(await send({ signedIn: false, why: OUT })); return; }
            let all = [];
            try { all = await counts(); }
            catch (e) {
                const why = String(e && e.message || e);
                const out = /invalid_auth|not_authed|token_revoked|account_inactive/.test(why);
                await take(await send({ signedIn: !out, team: team.name, why: out ? OUT : 'Slack did not answer on the box (' + why.slice(0, 80) + ')', list: [] }));
                return;
            }
            const now = Date.now();
            const want = all.filter(function(e) { return e.kind === 'dm' ? (e.unread || now - tsMs(e.latest) < 24 * 3600000) : pick.indexOf(e.id) >= 0; });
            pick.forEach(function(id) { if (!want.some(function(e) { return e.id === id; })) want.push({ id: id, kind: 'ch', unread: false, mentions: 0, latest: '' }); });
            want.sort(function(a, b) { return (Number(b.unread) - Number(a.unread)) || (tsMs(b.latest) - tsMs(a.latest)); });
            const list = [];
            for (const e of want.slice(0, 30)) {
                const name = await chatName(e.id);
                let p = '';
                if (e.unread && e.latest) { // the newest line, read once per new message
                    const kept = previews[e.id];
                    if (kept && kept.latest === e.latest) p = kept.text;
                    else {
                        try {
                            const m = ((await api('conversations.history', { channel: e.id, limit: '1' })).messages || [])[0];
                            if (m) p = ((await fromOf(m)) + ': ' + ((await clean(m.text || '')) || (Array.isArray(m.files) && m.files.length ? '[file]' : ''))).slice(0, 200);
                        } catch (_) {}
                        previews[e.id] = { latest: e.latest, text: p };
                    }
                }
                list.push({ id: e.id, name: name, kind: e.kind, unread: Boolean(e.unread), mentions: e.mentions || 0, at: tsMs(e.latest), p: p });
            }
            const body = { signedIn: true, team: team.name, list: list };
            if (now - chansAt > 30 * 60000) { try { body.chans = await channels(); chansAt = now; } catch (_) {} }
            await take(await send(body));
        } finally { busy = false; }
    };
    const poll = async function() {
        if (busy || !team) return;
        if (!fast && Date.now() - pollAt < 20000) return;
        pollAt = Date.now();
        busy = true;
        try { await take(await send({ poll: true })); } finally { busy = false; }
    };
    // Slack's page sets itself up first; then a full round every 45 s and commands every 5 s while the tablet is open
    setTimeout(function() { round().catch(function() { busy = false; }); }, 8000);
    setInterval(function() {
        if (Date.now() - roundAt > 45000) round().catch(function() { busy = false; });
        else poll().catch(function() { busy = false; });
    }, 5000);
})();
