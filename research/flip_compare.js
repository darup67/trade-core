// Side project: TradingView chart flip watcher (Sep 4-28, emailed alerts) vs headless watcher (replayed/backfilled on the same dates).
// Part 1 agreement and timing. Part 2 outcomes net of costs (same rules as the ledger). Read-only; writes flip_compare.json.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const bars = require('../bars.js');
const COSTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'costs.json'), 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'flip-notifier/headless-config.json')));
const W0 = Date.parse('2026-09-04T00:00:00Z'), W1 = Date.parse('2026-09-28T17:00:00Z');
const BAR = 15 * 60e3;
const norm = (x) => x.replace('MGC1!', 'MGCV2026');

// chart alerts: multi-line TSV cells, so parse the whole file
const txt = fs.readFileSync(path.join(os.homedir(), 'flip-notifier/alerts.tsv'), 'utf8');
const chartRaw = [];
for (const m of txt.matchAll(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)\t(⚡ |🔥 |💤 )?(?:⬆️|⬇️) (\S+) → (BUY|SELL)\t/gm))
  chartRaw.push({ t: Date.parse(m[1]), sym: norm(m[3]), to: m[4], label: m[2] ? ({ '⚡ ': 'MODERATE', '🔥 ': 'STRONG', '💤 ': 'WEAK' })[m[2]] : 'unscored' });
const seen = new Set();
const chart = chartRaw.filter((c) => c.t >= W0 && c.t <= W1).sort((a, b) => a.t - b.t)
  .filter((c) => { const k = `${c.sym}|${c.to}|${Math.floor(c.t / BAR)}`; if (seen.has(k)) return false; seen.add(k); return true; });

const tvByName = {};
for (const s of cfg.symbols) tvByName[norm(s.tv.split(':')[1])] = s.tv;
const L = new (require('node:sqlite').DatabaseSync)(path.join(__dirname, '..', 'data', 'ledger.db'));
const headAll = L.prepare("select sym,side,t,price,kind from signals where product='headless' and kind like 'flip:%' and t>=? and t<=?").all(W0, W1)
  .map((r) => ({ tv: r.sym, sym: norm(r.sym.split(':')[1]), to: r.side === 'long' ? 'BUY' : 'SELL', t: r.t, price: r.price, label: r.kind.split(':')[1] }));
const chartSyms = new Set(chart.map((c) => c.sym));
const head = headAll.filter((h) => chartSyms.has(h.sym));
const headMod = head.filter((h) => h.label !== 'WEAK');       // the chart watcher only emailed MODERATE and up

// ---- Part 1: agreement (chart alert time within -35m..+45m of headless bar close, same symbol and direction; one-to-one)
function match(A, B, key) {   // A items looked up in B
  const used = new Set(); const pairs = []; const unA = [];
  for (const a of A) {
    const i = B.findIndex((b, k) => !used.has(k) && b.sym === a.sym && b.to === a.to && key(a, b));
    if (i >= 0) { used.add(i); pairs.push([a, B[i]]); } else unA.push(a);
  }
  return { pairs, unA, unB: B.filter((_, k) => !used.has(k)) };
}
const inWin = (h, c) => c.t >= h.t - 35 * 60e3 && c.t <= h.t + 45 * 60e3;
const M = match(headMod, chart, (h, c) => inWin(h, c));   // headless (MODERATE+) vs chart
const grp = (sym) => { const tv = tvByName[sym] || ''; return /^(COINBASE|BITSTAMP|BINANCE|KRAKEN)/.test(tv) ? 'crypto' : /^(CME|COMEX)/.test(tv) ? 'futures' : 'stocks'; };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const se = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1) / (a.length || 1)); };
function flipFlops(list) {   // opposite flips on the same symbol within 60 min of the previous flip
  const by = {}; let n = 0;
  for (const f of [...list].sort((a, b) => a.t - b.t)) { const p = by[f.sym]; if (p && p.to !== f.to && f.t - p.t <= 60 * 60e3) n++; by[f.sym] = f; }
  return n;
}
const byGroup = {};
for (const g of ['stocks', 'crypto', 'futures']) {
  const hh = headMod.filter((h) => grp(h.sym) === g), cc = chart.filter((c) => grp(c.sym) === g);
  const pairs = M.pairs.filter(([h]) => grp(h.sym) === g);
  byGroup[g] = { headless: hh.length, chart: cc.length, matched: pairs.length };
}
const part1 = {
  window: [new Date(W0).toISOString(), new Date(W1).toISOString()], symbolsCompared: chartSyms.size,
  chartEmailed: chart.length, chartByLabel: chart.reduce((o, c) => (o[c.label] = (o[c.label] || 0) + 1, o), {}),
  headlessAll: head.length, headlessModeratePlus: headMod.length,
  matched: M.pairs.length, headlessOnly: M.unA.length, chartOnly: M.unB.length,
  matchedOfHeadlessPct: +(100 * M.pairs.length / headMod.length).toFixed(1), matchedOfChartPct: +(100 * M.pairs.length / chart.length).toFixed(1),
  medianChartMinusHeadlessCloseMin: med(M.pairs.map(([h, c]) => (c.t - h.t) / 60e3)),
  flipFlops60m: { chart: flipFlops(chart), headlessModeratePlus: flipFlops(headMod), headlessAll: flipFlops(head) },
  byGroup,
};

// ---- Part 2: outcomes net of costs
const cache = {};
async function barsFor(tv) { if (!cache[tv]) { const rows = await bars.getBars({ tv, source: 'x', ticker: 'x', group: 'x' }, { days: 45, fetchNew: false }); cache[tv] = rows; } return cache[tv]; }
const isRTH = bars.isRTH;
function sideCost(tv, t) { const g = grp(norm(tv.split(':')[1])); return (g === 'crypto' ? COSTS.crypto_bps_side : g === 'futures' ? COSTS.future_bps_side : (isRTH(t) ? COSTS.stock_rth_bps_side : COSTS.stock_ext_bps_side)); }
async function outcomes(list, getEntry) {
  const res = { '1h': [], '4h': [], '24h': [] };
  for (const f of list) {
    const tv = f.tv || tvByName[f.sym]; if (!tv) continue;
    const bs = await barsFor(tv); if (!bs.length) continue;
    const e = getEntry(f, bs); if (!e) continue;
    const dir = f.to === 'BUY' ? 1 : -1;
    for (const [h, ms] of [['1h', 3600e3], ['4h', 4 * 3600e3], ['24h', 24 * 3600e3]]) {
      const x = bs.find((b) => b.t + BAR >= e.t + ms && b.t + BAR <= e.t + ms + 2 * BAR);   // bar that closes at about entry + horizon
      if (!x) continue;
      const gross = dir * (x.c / e.price - 1) * 1e4, net = gross - 2 * sideCost(tv, e.t);
      res[h].push({ gross, net });
    }
  }
  const sum = {};
  for (const h in res) { const r = res[h]; sum[h] = { n: r.length, grossBps: +mean(r.map((x) => x.gross)).toFixed(1), netBps: +mean(r.map((x) => x.net)).toFixed(1), netSE: +se(r.map((x) => x.net)).toFixed(1), hitGrossPct: +(100 * r.filter((x) => x.gross > 0).length / (r.length || 1)).toFixed(1), hitNetPct: +(100 * r.filter((x) => x.net > 0).length / (r.length || 1)).toFixed(1) }; }
  return sum;
}
const entryHead = (f) => ({ t: f.t, price: f.price });                                   // live headless enters at the flip bar's close
const entryChart = (f, bs) => { const b = bs.find((x) => x.t + BAR >= f.t); return b ? { t: b.t + BAR, price: b.c } : null; };   // chart alert: close of the first bar at/after the alert

(async () => {
  const pairedChart = M.pairs.map(([, c]) => c), pairedHead = M.pairs.map(([h]) => h);
  const part2 = {
    chartEmailed: await outcomes(chart, entryChart),
    headlessModeratePlus: await outcomes(headMod, entryHead),
    headlessAll: await outcomes(head, entryHead),
    matched_chartSide: await outcomes(pairedChart, entryChart),
    chartOnly: await outcomes(M.unB, entryChart),
    headlessOnlyModeratePlus: await outcomes(M.unA, entryHead),
  };
  fs.writeFileSync(path.join(__dirname, 'flip_compare.json'), JSON.stringify({ part1, part2 }, null, 1));
  console.log(JSON.stringify(part1, null, 1));
  for (const k in part2) console.log('\n' + k, JSON.stringify(part2[k]));
})();
