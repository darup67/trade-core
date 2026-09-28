#!/usr/bin/env node
// Seed the ledger so evidence exists from day one (2026-09-28). Re-runnable: add() ignores duplicates.
//   headless : replay the store's history exactly as the live watcher would have signalled
//              (flips on 15m with their 0-5 label, 🚀 rallies on 30m, gaps on 1h), source=backfill
//   plus50   : coins already judged live, with their real 1h result
//   kalshi   : settled Kalshi BTC calls from evals.jsonl, net of Kalshi's fee
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const L = require('./ledger.js'), B = require('./bars.js');
const H = require(path.join(os.homedir(), 'flip-notifier', 'headless-flip.js'));
const CFG = H.CFG, rallyX = (CFG.fvg && CFG.fvg.rallyVolX) || 2.5, minAtr = (CFG.fvg && CFG.fvg.minAtr) || 0.2;
const assetOf = (s) => (s.group === 'futures' ? 'future' : s.group === 'crypto' ? 'crypto' : 'stock');

async function headless() {
  const series = [];
  for (const s of CFG.symbols) {
    const base = await B.getBars(s, { days: 45, fetchNew: false });
    if (base.length < 200) continue;
    const mk = (tf) => { const b = H.agg(base, tf); return { tf, b, regs: H.supertrendRegimes(b, CFG.factor, CFG.atrLen), atr: H.atrSeries(b) }; };
    series.push({ s, f15: mk(15), f30: mk(30), f60: mk(60) });
  }
  let n = 0;
  // flips with the live 0-5 score (needs the whole field per bar)
  const byT = new Map();
  for (const x of series) {
    const f = x.f15; x.flipIdx = [];
    for (let i = 1; i < f.b.length; i++) if (f.regs[i] && f.regs[i - 1] && f.regs[i] !== f.regs[i - 1]) {
      x.flipIdx.push(i); (byT.get(f.b[i].t) || byT.set(f.b[i].t, []).get(f.b[i].t)).push({ x, i, side: f.regs[i] });
    }
  }
  const regAt = (x, t) => { const b = x.f15.b; let lo = 0, hi = b.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (b[m].t <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a < 0 ? null : x.f15.regs[a]; };
  for (const [t, list] of byT) {
    const regimes = {}; for (const x of series) { const r = regAt(x, t); if (r) regimes[x.s.tv] = r; }
    for (const e of list) {
      const same = list.filter((y) => y.side === e.side).length;
      const recent = e.x.flipIdx.filter((j) => j < e.i && e.x.f15.b[j].t >= t - 864e5).length;
      const { label, score } = H.scoreCore(e.side, same, regimes, recent);
      const b = e.x.f15.b[e.i];
      L.add({ product: 'headless', kind: `flip:${label}`, sym: e.x.s.tv, asset: assetOf(e.x.s), tf: 15, side: e.side === 'BUY' ? 'long' : 'short',
              t: b.t + 15 * 60000, price: b.c, meta: { score }, source: 'backfill' }); n++;
    }
  }
  for (const x of series) {
    const volx = (f, i) => { const p = f.b.slice(Math.max(0, i - 20), i).map((y) => y.v || 0), a = p.reduce((q, y) => q + y, 0) / (p.length || 1); return a > 0 ? (f.b[i].v || 0) / a : 0; };
    if (x.s.group !== 'futures') for (let i = 2; i < x.f30.b.length; i++) {       // 🚀 rallies on 30m
      const g = x.f30.regs[i] ? H.fvgAt(x.f30.b, i, x.f30.atr, minAtr) : null;
      if (!g || g.side !== 'BULL' || volx(x.f30, i) < rallyX) continue;
      const b = x.f30.b[i], a = x.f30.atr[i];
      L.add({ product: 'headless', kind: 'rally', sym: x.s.tv, asset: assetOf(x.s), tf: 30, side: 'long', t: b.t + 30 * 60000, price: b.c,
              stop: b.c - a, target: b.c + 2 * a, atr: a, meta: { volx: volx(x.f30, i) }, source: 'backfill' }); n++;
    }
    for (let i = 2; i < x.f60.b.length; i++) {                                    // gaps on 1h
      const g = x.f60.regs[i] ? H.fvgAt(x.f60.b, i, x.f60.atr, minAtr) : null;
      if (!g || (g.side === 'BEAR' && x.s.group !== 'futures')) continue;
      const b = x.f60.b[i], a = x.f60.atr[i], dir = g.side === 'BULL' ? 1 : -1;
      L.add({ product: 'headless', kind: x.s.group === 'futures' ? 'gap:futures' : 'gap:bull', sym: x.s.tv, asset: assetOf(x.s), tf: 60,
              side: dir > 0 ? 'long' : 'short', t: b.t + 3600e3, price: b.c, stop: b.c - dir * a, target: b.c + dir * 2 * a, atr: a,
              meta: { size: g.size }, source: 'backfill' }); n++;
    }
  }
  return n;
}

function plus50() {
  const st = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'coin-launch-agent', 'data', 'plus50_state.json'), 'utf8')).judged;
  let n = 0;
  for (const [tok, j] of Object.entries(st)) {
    if (j.end_mult == null) continue;
    const cost = L.roundTrip('pumpfun', j.t_entry);
    L.add({ product: 'plus50', kind: j.cand ? 'candidate' : 'judged', sym: `SOL:${tok}`, asset: 'pumpfun', tf: 5, side: 'long', t: j.t_entry,
            price: j.entry_mc, regime: null, meta: { p: j.p, symbol: j.symbol, outcome: { net: j.end_mult - 1 - cost, gross: j.end_mult - 1, win: j.end_mult >= 1.5, cost } },
            source: 'live' }); n++;
  }
  return n;
}

function kalshi() {
  const fee = (p) => Math.ceil(0.07 * p * (1 - p) * 100) / 100;     // Kalshi taker fee per contract
  let n = 0;
  for (const line of fs.readFileSync(path.join(os.homedir(), 'kalshi-btc-agent', 'data', 'evals.jsonl'), 'utf8').split('\n')) {
    if (!line.includes('"settled"')) continue;
    const r = JSON.parse(line); if (r.status !== 'settled' || r.ask == null) continue;
    const ask = Math.min(Math.max(r.ask, 0.01), 0.99), won = r.won ? 1 : 0, net = won - ask - fee(ask);
    L.add({ product: 'kalshi-btc', kind: 'call', sym: `KALSHI:${r.ticker}`, asset: 'kalshi', tf: 15, side: 'long', t: Date.parse(r.close) || r.t * 1000,
            price: ask, regime: null, meta: { side: r.side, hist_hit: r.hist_hit, outcome: { net, gross: won - ask, win: !!won, cost: fee(ask) } }, source: 'live' }); n++;
  }
  return n;
}

module.exports = { headless, plus50, kalshi };

if (require.main === module) (async () => {
  const a = await headless(), b = plus50(), c = kalshi();
  const g = L.grade();
  const ev = L.evidence();
  console.log(`added: headless ${a}, plus50 ${b}, kalshi ${c} · graded ${g}`);
  for (const [k, v] of Object.entries(ev.groups)) {
    const r = v['*'];
    console.log(`${k.padEnd(28)} n ${String(r.n).padStart(5)}  win ${(100 * r.win).toFixed(0).padStart(3)}%  lower ${(100 * r.lower).toFixed(0).padStart(3)}%  random ${r.baseline == null ? '  –' : (100 * r.baseline).toFixed(0).padStart(3) + '%'}  mean net ${r.meanNet == null ? '–' : (100 * r.meanNet).toFixed(2) + '%'}  ${r.proven ? 'PROVEN' : 'not proven'}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
