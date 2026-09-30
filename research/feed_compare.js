// Side project: Alpaca (IEX) vs Yahoo 15m bars for the watchlist stocks/ETFs. Read-only; writes feed_compare.json.
'use strict';
const fs = require('fs'), path = require('path');
const { F, BASE_MS } = require('../bars.js');
const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, 'flip-notifier/headless-config.json')));
const syms = cfg.symbols.filter((s) => s.source === 'yahoo' && s.group !== 'futures' && !s.ticker.endsWith('=F'));
const DAYS = 10, since = Date.now() - DAYS * 864e5, now = Date.now();
const closed = (bs) => new Map(bs.filter((b) => b.t % BASE_MS === 0 && b.t + BASE_MS <= now - 20000).map((b) => [b.t, b]));
const pct = (a, b) => (b ? (a - b) / b * 1e4 : 0);             // bps
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const corr = (x, y) => { const mx = mean(x), my = mean(y); let n = 0, dx = 0, dy = 0; x.forEach((v, i) => { n += (v - mx) * (y[i] - my); dx += (v - mx) ** 2; dy += (y[i] - my) ** 2; }); return n / Math.sqrt(dx * dy); };

(async () => {
  const rows = [];
  for (const s of syms) {
    const t0 = Date.now(); let y, a, ty, ta;
    try { y = closed(await F.yahoo(s.ticker, since)); ty = Date.now() - t0; } catch (e) { y = new Map(); }
    const t1 = Date.now();
    try { a = closed(await F.alpaca(s.ticker, since)); ta = Date.now() - t1; } catch (e) { a = new Map(); }
    const both = [...a.keys()].filter((t) => y.has(t)).sort((p, r) => p - r);
    const d = { c: [], o: [], h: [], l: [], v: [] }, rr = { a: [], y: [] };
    let prev = null;
    for (const t of both) {
      const A = a.get(t), Y = y.get(t);
      d.c.push(Math.abs(pct(A.c, Y.c))); d.o.push(Math.abs(pct(A.o, Y.o)));
      d.h.push(pct(A.h, Y.h)); d.l.push(pct(A.l, Y.l));                       // signed: IEX-only highs are <= consolidated highs
      if (Y.v > 0) d.v.push(A.v / Y.v);
      if (prev) { rr.a.push(pct(A.c, prev.A.c)); rr.y.push(pct(Y.c, prev.Y.c)); }
      prev = { A, Y };
    }
    const signAgree = rr.a.length ? rr.a.filter((v, i) => Math.sign(v) === Math.sign(rr.y[i])).length / rr.a.length : null;
    rows.push({
      ticker: s.ticker, group: s.group, yahooBars: y.size, alpacaBars: a.size, overlap: both.length,
      alpacaMissing: [...y.keys()].filter((t) => !a.has(t)).length, yahooMissing: [...a.keys()].filter((t) => !y.has(t)).length,
      closeDiffBpsMed: q(d.c, .5), closeDiffBpsP95: q(d.c, .95), closeDiffBpsMax: q(d.c, 1) ,
      highGapBpsMean: mean(d.h), lowGapBpsMean: mean(d.l),
      volShareMed: q(d.v, .5), retCorr: rr.a.length > 3 ? corr(rr.a, rr.y) : null, retSignAgree: signAgree,
      msYahoo: ty, msAlpaca: ta,
    });
    await new Promise((r) => setTimeout(r, 400));
  }
  fs.writeFileSync(path.join(__dirname, 'feed_compare.json'), JSON.stringify({ at: new Date().toISOString(), days: DAYS, rows }, null, 1));
  const f = (v, n = 1) => (v == null ? '  -  ' : v.toFixed(n));
  console.log('ticker  yBars aBars  aMiss yMiss | closeΔ bps med/p95/max | hiGap loGap | volShr | retCorr signAgr | ms y/a');
  for (const r of rows) console.log(`${r.ticker.padEnd(6)} ${String(r.yahooBars).padStart(5)} ${String(r.alpacaBars).padStart(5)} ${String(r.alpacaMissing).padStart(6)} ${String(r.yahooMissing).padStart(5)} | ${f(r.closeDiffBpsMed)}/${f(r.closeDiffBpsP95)}/${f(r.closeDiffBpsMax)} | ${f(r.highGapBpsMean)} ${f(r.lowGapBpsMean)} | ${f(r.volShareMed, 3)} | ${f(r.retCorr, 3)} ${f(r.retSignAgree, 3)} | ${r.msYahoo}/${r.msAlpaca}`);
})();
