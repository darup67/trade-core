#!/usr/bin/env node
// Hourly (com.dhruv.tradecore.grade): import new plus50 and Kalshi results, grade every signal whose
// horizon has passed (net of costs), refresh data/evidence.json (which gates real-time emails),
// and prune bars older than the store's window.
'use strict';
const L = require('./ledger.js'), B = require('./bars.js'), { plus50, kalshi } = require('./backfill.js');
const t0 = Date.now();
let p = 0, k = 0;
try { p = plus50(); } catch (e) { console.error('plus50 import:', e.message); }
try { k = kalshi(); } catch (e) { console.error('kalshi import:', e.message); }
const g = L.grade(), ev = L.evidence();
B.prune();
const proven = Object.entries(ev.groups).filter(([, v]) => v['*'] && v['*'].proven).map(([key]) => key);
console.log(`${new Date().toISOString()} graded ${g} · imported plus50 ${p}, kalshi ${k} · proven: ${proven.join(', ') || 'none'} · ${Date.now() - t0} ms`);
