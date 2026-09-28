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
(async () => {
let o = 0; try { o = await L.gradeOptions(); } catch (e) { console.error('options:', e.message); }
const g = L.grade(), ev = L.evidence();
B.prune();
// Backup (2026-09-28): the user has no machine backup (no Time Machine; not using Backblaze), and live
// ledger rows can't be recreated. Export them to a git-tracked text file; commit at most every 6 hours.
try {
  const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  const rows = L.open().prepare(`SELECT s.*, o.net_1h, o.net_4h, o.net_24h, o.gross_24h, o.win, o.cost, o.graded_at
    FROM signals s LEFT JOIN outcomes o ON o.id = s.id WHERE s.source = 'live' ORDER BY s.t, s.id`).all();
  const file = path.join(__dirname, 'export', 'ledger-live.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const git = (...a) => execFileSync('/usr/local/bin/git', a, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const dirty = git('status', '--porcelain', 'export/ledger-live.jsonl');
  const last = +(git('log', '-1', '--format=%ct', '--', 'export/ledger-live.jsonl') || 0);
  if (dirty && Date.now() / 1000 - last >= 6 * 3600) {
    git('add', 'export/ledger-live.jsonl');
    git('-c', 'user.name=trade-core', '-c', 'user.email=darup67@gmail.com', 'commit', '-q', '-m', `ledger backup: ${rows.length} live rows`, '--', 'export/ledger-live.jsonl');
    git('push', '-q', 'origin', 'HEAD');
    console.log(`ledger backup committed: ${rows.length} live rows`);
  }
} catch (e) { console.error('ledger backup:', e.message); }
const proven = Object.entries(ev.groups).filter(([, v]) => v['*'] && v['*'].proven).map(([key]) => key);
console.log(`${new Date().toISOString()} graded ${g} (options settled ${o}) · imported plus50 ${p}, kalshi ${k} · proven: ${proven.join(', ') || 'none'} · ${Date.now() - t0} ms`);
})();
