// Runs the Director phone relay (director/worker.js, the CRM tool's Cloudflare Worker) on this
// machine with Bun, instead of on Cloudflare. It is a separate service from the app hub, with
// its own address and storage.
//
//   bun director/server.js
//
// Cloudflare's D1 database is replaced by a SQLite file (director/data/director.sqlite) behind
// the small part of D1's API the relay uses: prepare(sql).bind(...).first() / .all() / .run().
//
// Updating the relay: when the CRM tool's extension comes with a new worker.js, copy it over
// director/worker.js and restart (it used to be pasted into Cloudflare instead).
//
// Settings (environment variables, optional):
//   DIRECTOR_PORT   port to listen on (8790)
//   DIRECTOR_URL    the address the phone and the extension use, e.g. https://hub.tail1234.ts.net:8443
//   DATA_DIR        where director.sqlite is kept (director/data)

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import relay from './worker.js';

const PORT = Number(process.env.DIRECTOR_PORT || 8790);
const PUBLIC_URL = (process.env.DIRECTOR_URL || '').replace(/\/+$/, '');
const DATA_DIR = process.env.DATA_DIR || join(import.meta.dir, 'data');

mkdirSync(DATA_DIR, { recursive: true });
const sqlite = new Database(join(DATA_DIR, 'director.sqlite'), { create: true });
sqlite.exec('PRAGMA journal_mode = WAL');

// D1's statement API on top of bun:sqlite.
function statement(sql, args = []) {
  return {
    bind: (...values) => statement(sql, values),
    async first(column) {
      const row = sqlite.prepare(sql).get(...args) || null;
      return row && column ? row[column] : row;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...args), success: true, meta: {} };
    },
    async run() {
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
    },
    async raw() {
      return sqlite.prepare(sql).values(...args);
    },
  };
}
const DB = {
  prepare: sql => statement(sql),
  async batch(statements) { return Promise.all(statements.map(s => s.run())); },
  async exec(sql) { sqlite.exec(sql); return { count: 1 }; },
};

// wlcm 1.7.462: on the box, "Connect to Box" in the app makes the box look after itself
// (worker.js calls this from /api/connect): Chromium up, the WhatsApp side panel open.
// Only where the script is there (the box), so the same file runs anywhere.
import { existsSync } from 'node:fs';
const BOX_UP = '/home/serr/wlcm/box-up.sh';
if (existsSync(BOX_UP)) {
  globalThis.wlcmBoxEnsure = silentMs => {
    try { Bun.spawn(['/bin/sh', BOX_UP, String(Math.round(Number(silentMs)) || 0)], { stdout: 'ignore', stderr: 'ignore' }); }
    catch (e) { console.error('box-up failed:', e); }
  };
}

// wlcm 1.7.464 (5 min since 2026-11-19): the app (phone / tablet) not opened for 5 minutes -> the box's Chromium (CRM, WhatsApp
// side panel) is closed. "Box" / "Start" in the app starts it again. worker.js notes each app request in
// globalThis.wlcmAppAt; after a relay restart the 5 minutes count from the restart.
const BOX_IDLE = '/home/serr/wlcm/box-idle.sh';
// 2026-11-23 (rebuild, stage 1): the box's browser stays on — a restart was the riskiest moment (sign-in, cached
// code, everything switched off). The 5-minute idle close only runs with WLCM_BOX_IDLE=1.
if (existsSync(BOX_IDLE) && process.env.WLCM_BOX_IDLE === '1') {
  const IDLE_MS = 5 * 60 * 1000;
  globalThis.wlcmAppAt = Date.now();
  setInterval(() => {
    if (Date.now() - Number(globalThis.wlcmAppAt || 0) < IDLE_MS) return;
    if (Number(globalThis.wlcmKeepUntil || 0) > Date.now()) return; // wlcm 1.7.530: an automation runs on the box (worker.js)
    try { Bun.spawn(['/bin/sh', BOX_IDLE], { stdout: 'ignore', stderr: 'ignore' }); }
    catch (e) { console.error('box-idle failed:', e); }
  }, 60000);
}

const env = { DB };
const ctx = { waitUntil: promise => Promise.resolve(promise).catch(e => console.error('background task failed:', e)) };

Bun.serve({
  port: PORT,
  async fetch(request) {
    // Behind Tailscale Funnel the request arrives as plain http on this port; the relay builds
    // links and notification details from its public address.
    if (PUBLIC_URL) {
      const url = new URL(request.url);
      request = new Request(PUBLIC_URL + url.pathname + url.search, request);
    }
    const response = await relay.fetch(request, env, ctx);
    const set = res => {
      if (!res.headers.has('strict-transport-security')) res.headers.set('strict-transport-security', 'max-age=31536000');
      if (!res.headers.has('content-security-policy')) res.headers.set('content-security-policy', "frame-ancestors 'none'");
    };
    try { set(response); return response; }
    catch { const res = new Response(response.body, response); set(res); return res; }   // fetched responses have read-only headers
  },
});

console.log(`Director relay running on http://localhost:${PORT}` + (PUBLIC_URL ? ` (public address ${PUBLIC_URL})` : ''));
