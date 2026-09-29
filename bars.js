// trade-core/bars.js — the shared market-data store (2026-09-28).
//
// One SQLite file (data/market.db) holds closed 15-minute bars for every symbol any project watches.
// getBars() returns the stored history and fetches ONLY what is missing since the last stored bar,
// so a run downloads a handful of bars per symbol instead of 30 days. Every project reads the same
// bars: Node via this module, Python via trade_core.py (read-only).
//
// Sources and fallbacks:
//   stocks/ETFs/futures  Yahoo (unofficial). Stock fallback: Alpaca, active once an API key is in
//                        Keychain (service "alpaca-api", account = key id, password = secret).
//   crypto               tried in order; if one fails the next serves the gap:
//                        the symbol's home exchange first, then Coinbase, Binance, Kraken, Bitstamp.
// Only closed, on-grid bars are stored (Yahoo's off-grid stale-trade points are dropped).
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
// node:sqlite prints an ExperimentalWarning on every require; keep job logs clean.
const _emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w && w.message || w).includes('SQLite') ? undefined : _emit.call(process, w, ...a));
const { DatabaseSync } = require('node:sqlite');

const BASE_MIN = 15, BASE_MS = BASE_MIN * 60000;
const KEEP_DAYS = 45, FIRST_DAYS = 30;
const DB_PATH = path.join(__dirname, 'data', 'market.db');

let db;
function open() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS bars (sym TEXT, t INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL, src TEXT, PRIMARY KEY (sym, t)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS fetch_log (sym TEXT PRIMARY KEY, at INTEGER, src TEXT, ok INTEGER, err TEXT);`);
  return db;
}

async function getJSON(url, headers = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, signal: AbortSignal.timeout(15000) });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { fatal: true });
      return await r.json();
    } catch (e) {
      if (e.fatal || attempt === 2) throw e;
      await new Promise((res) => setTimeout(res, 800 * 2 ** attempt));
    }
  }
}

// ---- fetchers: (ticker, sinceMs) -> [{t,o,h,l,c,v}] ascending, 15m, possibly including the open bar
const F = {
  async yahoo(ticker, since) {
    const ext = ticker.endsWith('=F') ? '' : '&includePrePost=true';
    const win = since ? `&period1=${Math.floor(since / 1000)}&period2=${Math.ceil(Date.now() / 1000)}` : `&range=${FIRST_DAYS}d`;
    const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=15m${win}${ext}`);
    const res = j.chart.result[0], q = res.indicators.quote[0];
    return (res.timestamp || []).map((t, i) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume ? q.volume[i] || 0 : 0 }))
      .filter((b) => b.o != null && b.h != null && b.l != null && b.c != null);
  },
  async coinbase(product, since) {
    const out = [], start0 = since || Date.now() - 12.5 * 864e5;
    for (let end = Date.now(); end > start0; end -= 300 * BASE_MS) {
      const start = Math.max(start0, end - 300 * BASE_MS);
      const rows = await getJSON(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=900&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`);
      out.push(...rows.map(([ts, l, h, o, c, v]) => ({ t: ts * 1000, o, h, l, c, v })));
    }
    return out.sort((a, b) => a.t - b.t);
  },
  async binance(sym, since) {
    const k = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=15m&limit=1000${since ? '&startTime=' + since : ''}`);
    return k.map((x) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
  },
  async kraken(pair, since) {
    const j = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=15${since ? '&since=' + Math.floor(since / 1000) : ''}`);
    const key = Object.keys(j.result).find((k) => k !== 'last');
    return j.result[key].map((b) => ({ t: b[0] * 1000, o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +b[6] }));
  },
  async bitstamp(pair, since) {
    const j = await getJSON(`https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=900&limit=1000${since ? '&start=' + Math.floor(since / 1000) : ''}`);
    return j.data.ohlc.map((b) => ({ t: +b.timestamp * 1000, o: +b.open, h: +b.high, l: +b.low, c: +b.close, v: +b.volume }));
  },
  async alpaca(ticker, since) {
    const key = alpacaKey();
    if (!key) throw new Error('no Alpaca key in Keychain');
    const start = new Date(since || Date.now() - FIRST_DAYS * 864e5).toISOString();
    const out = []; let token = '';
    do {
      const j = await getJSON(`https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=15Min&start=${start}&limit=10000&feed=iex${token ? '&page_token=' + token : ''}`,
        { 'APCA-API-KEY-ID': key.id, 'APCA-API-SECRET-KEY': key.secret });
      out.push(...(j.bars || []).map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })));
      token = j.next_page_token;
    } while (token);
    return out;
  },
};

// GeckoTerminal (Coinbase Wallet / onchain tokens): free tier measured ~10 calls/min on this Mac, so
// calls are spaced >= 6.5 s apart within a process. ticker = "<network>:<pool address>".
let _lastGecko = 0;
F.gecko = async (ticker, since) => {
  const [net, pool] = ticker.split(':');
  const wait = _lastGecko + 6500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastGecko = Date.now();
  const limit = since ? Math.min(1000, Math.ceil((Date.now() - since) / BASE_MS) + 2) : 1000;
  const j = await getJSON(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/${pool}/ohlcv/minute?aggregate=15&limit=${limit}&currency=usd`);
  return (j.data.attributes.ohlcv_list || []).map(([t, o, h, l, c, v]) => ({ t: t * 1000, o, h, l, c, v })).sort((a, b) => a.t - b.t);
};

let _alpaca;
function alpacaKey() {
  if (_alpaca !== undefined) return _alpaca;
  try {
    const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'alpaca-api', '-g'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const all = out.toString() + '';
    const id = (all.match(/"acct"<blob>="([^"]+)"/) || [])[1];
    const secret = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'alpaca-api', '-w']).toString().trim();
    _alpaca = id && secret ? { id, secret } : null;
  } catch { _alpaca = null; }
  return _alpaca;
}

// Symbol definition: { tv: 'COINBASE:SOLUSD', source: 'coinbase', ticker: 'SOL-USD', group }
function chain(sym) {
  const home = [[sym.source, sym.ticker]];
  if (sym.group === 'crypto') {
    const base = sym.tv.split(':')[1].replace(/USDT?$/, '');
    const alt = [['coinbase', `${base}-USD`], ['binance', `${base}USDT`], ['kraken', `${base}USD`], ['bitstamp', `${base.toLowerCase()}usd`]];
    return home.concat(alt.filter(([s]) => s !== sym.source));
  }
  if (sym.source === 'yahoo' && !sym.ticker.endsWith('=F') && sym.group !== 'futures') return home.concat([['alpaca', sym.ticker]]);
  return home;
}

const onGrid = (b) => b.t % BASE_MS === 0;

/** Closed 15m bars for sym, from the store, topped up with only the missing bars. */
async function getBars(sym, { days = FIRST_DAYS, fetchNew = true } = {}) {
  const d = open(), now = Date.now();
  const last = d.prepare('SELECT max(t) AS t FROM bars WHERE sym = ?').get(sym.tv).t;
  if (fetchNew && (!last || last + 2 * BASE_MS <= now)) {
    const since = last ? last - 2 * BASE_MS : null;   // overlap two bars: the last one may have been revised
    let got = null, src = null, errs = [];
    for (const [s, tk] of chain(sym)) {
      try { got = await F[s](tk, since); src = s; if (got.length) break; } catch (e) { errs.push(`${s}: ${e.message}`); }
    }
    const closed = (got || []).filter((b) => onGrid(b) && b.t + BASE_MS <= now - 20000);
    if (closed.length) {
      const ins = d.prepare('INSERT OR REPLACE INTO bars VALUES (?,?,?,?,?,?,?,?)');
      d.exec('BEGIN');
      for (const b of closed) ins.run(sym.tv, b.t, b.o, b.h, b.l, b.c, b.v || 0, src);
      d.exec('COMMIT');
    }
    d.prepare('INSERT OR REPLACE INTO fetch_log VALUES (?,?,?,?,?)').run(sym.tv, now, src, got ? 1 : 0, errs.join('; ').slice(0, 300) || null);
    if (!got && !last) throw new Error(errs.join('; ') || 'no data');
  }
  return d.prepare('SELECT t,o,h,l,c,v,src FROM bars WHERE sym = ? AND t >= ? ORDER BY t').all(sym.tv, now - days * 864e5);
}

function prune() { open().prepare('DELETE FROM bars WHERE t < ?').run(Date.now() - KEEP_DAYS * 864e5); }

module.exports = { getBars, prune, open, BASE_MS, DB_PATH, chain, F };
