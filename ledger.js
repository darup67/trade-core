// trade-core/ledger.js — one ledger for every signal from every product (2026-09-28).
//
//   add(signal)        record a signal (idempotent on product:kind:sym:t)
//   grade()            fill net-of-cost outcomes once their horizons have passed (bars from market.db)
//   evidence()         per product/kind (and per market regime): n, win rate after costs, random-entry
//                      baseline, lift, and PROVEN / not — written to data/evidence.json
//   isProven(p, k, r)  what producers ask before sending a real-time alert
//
// A signal: { product, kind, sym (tv id), asset: stock|crypto|future|pumpfun|kalshi, tf, side: long|short,
//             t (signal time = bar close, ms), price, stop?, target?, atr?, meta?, source: live|backfill }
// Outcomes for market assets are computed here from stored bars. Products whose instrument isn't in
// the store (pump.fun coins, Kalshi) pass a finished outcome in meta: { net, win }.
//
// "Proven" (the only thing that earns a real-time email): over the last 60 days, at least 30 graded
// signals, and the win rate's lower bound (z = 1.0, ~84% one-sided) is above the random-entry
// baseline for the same assets. Win = the tested 2:1 setup (+2 ATR before -1 ATR within 24h) when the
// signal has a stop/target, else "net 24h return > 0".
'use strict';
const fs = require('fs');
const path = require('path');
const bars = require('./bars.js');

const DIR = path.join(__dirname, 'data');
const COSTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'costs.json'), 'utf8'));
const EVIDENCE = path.join(DIR, 'evidence.json');
const H = { '1h': 3600e3, '4h': 4 * 3600e3, '24h': 24 * 3600e3 };
const WINDOW_DAYS = 60, MIN_N = 30, Z = 1.0;
const BENCH = { stock: 'US:SPY', crypto: 'BITSTAMP:BTCUSD', future: 'CME_MINI_DL:MES1!' };

let db;
function open() {
  if (db) return db;
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(path.join(DIR, 'ledger.db'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS signals (id TEXT PRIMARY KEY, product TEXT, kind TEXT, sym TEXT, asset TEXT, tf INTEGER, side TEXT,
      t INTEGER, price REAL, stop REAL, target REAL, atr REAL, regime TEXT, meta TEXT, source TEXT, emailed INTEGER DEFAULT 0, ticket TEXT);
    CREATE TABLE IF NOT EXISTS outcomes (id TEXT PRIMARY KEY, net_1h REAL, net_4h REAL, net_24h REAL, gross_24h REAL, win INTEGER, cost REAL, graded_at INTEGER);
    CREATE INDEX IF NOT EXISTS sig_pk ON signals(product, kind, t);`);
  return db;
}

// ---- costs (#2): round-trip fraction of price
function isExtHours(t) {
  const d = new Date(t), et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const m = et.getHours() * 60 + et.getMinutes(), wd = et.getDay();
  return wd === 0 || wd === 6 || m < 570 || m >= 960;
}
function roundTrip(asset, t) {
  const side = asset === 'stock' ? (isExtHours(t) ? COSTS.stock_ext_bps_side : COSTS.stock_rth_bps_side)
    : asset === 'crypto' ? COSTS.crypto_bps_side : asset === 'future' ? COSTS.future_bps_side
    : asset === 'pumpfun' ? COSTS.pumpfun_bps_side : 0;
  return (2 * side) / 1e4;
}

// ---- market regime (#3): trend and volatility of the asset class's benchmark at time t (1h bars)
const _regimeCache = new Map();
function regimeAt(asset, t) {
  const sym = BENCH[asset];
  if (!sym) return null;
  const key = `${asset}:${Math.floor(t / 3600e3)}`;
  if (_regimeCache.has(key)) return _regimeCache.get(key);
  const rows = bars.open().prepare('SELECT t,h,l,c FROM bars WHERE sym=? AND t<=? AND t>=? ORDER BY t').all(sym, t - 15 * 60000, t - 25 * 864e5);
  const hourly = [];
  for (const b of rows) {
    const k = Math.floor(b.t / 3600e3);
    const last = hourly[hourly.length - 1];
    if (last && last.k === k) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; }
    else hourly.push({ k, h: b.h, l: b.l, c: b.c });
  }
  let r = null;
  if (hourly.length >= 60) {
    let e = hourly[0].c; const k = 2 / 51;
    const trs = [];
    hourly.forEach((b, i) => { e = b.c * k + e * (1 - k); if (i) trs.push(Math.max(b.h - b.l, Math.abs(b.h - hourly[i - 1].c), Math.abs(b.l - hourly[i - 1].c)) / b.c); });
    const atr = (xs) => xs.slice(-14).reduce((a, x) => a + x, 0) / Math.min(14, xs.length);
    const now = atr(trs), hist = [];
    for (let i = 14; i <= trs.length; i++) hist.push(atr(trs.slice(0, i)));
    const med = [...hist].sort((a, b) => a - b)[hist.length >> 1];
    r = `${hourly[hourly.length - 1].c >= e ? 'up' : 'down'}-${now >= med ? 'hivol' : 'lovol'}`;
  }
  _regimeCache.set(key, r);
  return r;
}

function add(sig) {
  const d = open();
  const id = `${sig.product}:${sig.kind}:${sig.sym}:${sig.t}`;
  const regime = sig.regime !== undefined ? sig.regime : regimeAt(sig.asset, sig.t);
  d.prepare(`INSERT OR IGNORE INTO signals (id,product,kind,sym,asset,tf,side,t,price,stop,target,atr,regime,meta,source,emailed)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, sig.product, sig.kind, sig.sym, sig.asset, sig.tf || null, sig.side, sig.t, sig.price, sig.stop ?? null, sig.target ?? null,
         sig.atr ?? null, regime, JSON.stringify(sig.meta || {}), sig.source || 'live', sig.emailed ? 1 : 0);
  return id;
}
function markEmailed(id, ticket) { open().prepare('UPDATE signals SET emailed=1, ticket=COALESCE(?, ticket) WHERE id=?').run(ticket ? JSON.stringify(ticket) : null, id); }

// ---- grading
function gradeOne(s) {
  const meta = JSON.parse(s.meta || '{}');
  if (meta.outcome) return { net_1h: null, net_4h: null, net_24h: meta.outcome.net, gross_24h: meta.outcome.gross ?? null, win: meta.outcome.win ? 1 : 0, cost: meta.outcome.cost ?? null };
  const rows = bars.open().prepare('SELECT t,h,l,c FROM bars WHERE sym=? AND t>=? AND t<=? ORDER BY t').all(s.sym, s.t, s.t + H['24h'] + 15 * 60000);
  const lastClose = rows.length ? rows[rows.length - 1].t + bars.BASE_MS : 0;
  if (lastClose < s.t + H['24h'] && Date.now() < s.t + H['24h'] + 6 * 3600e3) return null;   // wait for the full day
  const dir = s.side === 'short' ? -1 : 1, cost = roundTrip(s.asset, s.t);
  const at = (ms) => { let c = null; for (const b of rows) if (b.t + bars.BASE_MS <= s.t + ms) c = b.c; return c; };
  const net = (ms) => { const c = at(ms); return c == null ? null : dir * (c / s.price - 1) - cost; };
  let win = null;
  if (s.stop != null && s.target != null) {
    win = 0;
    for (const b of rows) {
      if (b.t < s.t) continue;
      if (dir > 0 ? b.l <= s.stop : b.h >= s.stop) { win = 0; break; }
      if (dir > 0 ? b.h >= s.target : b.l <= s.target) { win = 1; break; }
    }
  } else { const n24 = net(H['24h']); win = n24 == null ? null : n24 > 0 ? 1 : 0; }
  const c24 = at(H['24h']);
  return { net_1h: net(H['1h']), net_4h: net(H['4h']), net_24h: net(H['24h']), gross_24h: c24 == null ? null : dir * (c24 / s.price - 1), win, cost };
}

function grade() {
  const d = open();
  const due = d.prepare(`SELECT s.* FROM signals s LEFT JOIN outcomes o ON o.id = s.id WHERE o.id IS NULL AND (s.t <= ? OR s.meta LIKE '%"outcome"%')`).all(Date.now() - H['24h']);
  const ins = d.prepare('INSERT OR REPLACE INTO outcomes VALUES (?,?,?,?,?,?,?,?)');
  let n = 0;
  d.exec('BEGIN');
  for (const s of due) { const o = gradeOne(s); if (o) { ins.run(s.id, o.net_1h, o.net_4h, o.net_24h, o.gross_24h, o.win, o.cost, Date.now()); n++; } }
  d.exec('COMMIT');
  return n;
}

// ---- random-entry baseline for the same symbols, sides and setup type, after costs
function baseline(rows) {
  const syms = [...new Set(rows.map((r) => r.sym))], asset = rows[0].asset, useR21 = rows.some((r) => r.stop != null);
  const shortShare = rows.filter((r) => r.side === 'short').length / rows.length;
  if (!BENCH[asset]) return null;                     // products outside the store judge themselves
  const since = Math.min(...rows.map((r) => r.t)), wins = [];
  for (const sym of syms) {
    const b = bars.open().prepare('SELECT t,h,l,c FROM bars WHERE sym=? AND t>=? ORDER BY t').all(sym, since - 3 * 864e5);
    if (b.length < 150) continue;
    const trs = b.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l));
    for (let i = 60; i < b.length - 96; i += 8) {
      const atr = trs.slice(i - 14, i).reduce((a, x) => a + x, 0) / 14, dir = (i / 8) % 100 < shortShare * 100 ? -1 : 1, e = b[i].c;
      if (useR21) {
        let w = 0;
        for (let j = i + 1; j <= i + 96; j++) {
          if (dir > 0 ? b[j].l <= e - atr : b[j].h >= e + atr) break;
          if (dir > 0 ? b[j].h >= e + 2 * atr : b[j].l <= e - 2 * atr) { w = 1; break; }
        }
        wins.push(w);
      } else wins.push(dir * (b[i + 96].c / e - 1) - roundTrip(asset, b[i].t) > 0 ? 1 : 0);
    }
  }
  return wins.length ? wins.reduce((a, x) => a + x, 0) / wins.length : null;
}

const wilsonLo = (k, n, z = Z) => { if (!n) return 0; const p = k / n, d = 1 + z * z / n; return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; };

function evidence() {
  const d = open(), since = Date.now() - WINDOW_DAYS * 864e5;
  const rows = d.prepare(`SELECT s.*, o.win, o.net_24h FROM signals s JOIN outcomes o ON o.id = s.id WHERE s.t >= ? AND o.win IS NOT NULL`).all(since);
  const groups = new Map();
  for (const r of rows) for (const key of [`${r.product}|${r.kind}|*`, `${r.product}|${r.kind}|${r.regime || '?'}`]) {
    (groups.get(key) || groups.set(key, []).get(key)).push(r);
  }
  const out = {};
  for (const [key, g] of groups) {
    const [product, kind, regime] = key.split('|');
    const n = g.length, k = g.reduce((a, r) => a + r.win, 0), rate = k / n;
    // Contracts bought at a price (Kalshi) break even at win rate = price + fee, so that is the baseline.
    // Pump.fun coins have no random-entry series in the store: they're judged by their own gate.
    const base = g[0].asset === 'kalshi' ? g.reduce((a, r) => { const m = JSON.parse(r.meta || '{}'); return a + r.price + ((m.outcome && m.outcome.cost) || 0); }, 0) / n
      : g[0].asset === 'pumpfun' ? null : baseline(g);
    const lo = wilsonLo(k, n), nets = g.map((r) => r.net_24h).filter((x) => x != null);
    const meanNet = nets.length ? nets.reduce((a, x) => a + x, 0) / nets.length : null;
    const proven = n >= MIN_N && base != null && lo > base && (meanNet == null || meanNet > 0);
    (out[`${product}|${kind}`] = out[`${product}|${kind}`] || {})[regime] =
      { n, win: rate, lower: lo, baseline: base, lift: base != null ? rate - base : null, meanNet, proven,
        live: g.filter((r) => r.source === 'live').length };
  }
  const doc = { updated: new Date().toISOString(), windowDays: WINDOW_DAYS, minN: MIN_N, z: Z, groups: out };
  fs.writeFileSync(EVIDENCE, JSON.stringify(doc, null, 1));
  return doc;
}

function isProven(product, kind, regime) {
  let doc; try { doc = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8')); } catch { return { proven: false, why: 'no evidence yet' }; }
  const g = doc.groups[`${product}|${kind}`];
  if (!g) return { proven: false, why: 'no graded signals' };
  const r = regime && g[regime] && g[regime].n >= MIN_N ? g[regime] : g['*'];
  return { ...r, scope: r === g['*'] ? 'all regimes' : regime };
}

module.exports = { add, markEmailed, grade, evidence, isProven, regimeAt, roundTrip, open, EVIDENCE };
