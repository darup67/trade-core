#!/usr/bin/env node
// Rebuild data/ledger.db after a disk loss: live rows from export/ledger-live.jsonl (git), then
// re-run backfill.js for the replayable history and grade.js to regrade.
'use strict';
const fs = require('fs'), path = require('path'), L = require('./ledger.js');
const d = L.open();
const lines = fs.readFileSync(path.join(__dirname, 'export', 'ledger-live.jsonl'), 'utf8').split('\n').filter(Boolean);
const sig = d.prepare(`INSERT OR IGNORE INTO signals (id,product,kind,sym,asset,tf,side,t,price,stop,target,atr,regime,meta,source,emailed,ticket) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const out = d.prepare('INSERT OR IGNORE INTO outcomes VALUES (?,?,?,?,?,?,?,?)');
d.exec('BEGIN');
for (const l of lines) {
  const r = JSON.parse(l);
  sig.run(r.id, r.product, r.kind, r.sym, r.asset, r.tf, r.side, r.t, r.price, r.stop, r.target, r.atr, r.regime, r.meta, r.source, r.emailed, r.ticket);
  if (r.graded_at != null) out.run(r.id, r.net_1h, r.net_4h, r.net_24h, r.gross_24h, r.win, r.cost, r.graded_at);
}
d.exec('COMMIT');
console.log(`restored ${lines.length} live rows; now run: node backfill.js && node grade.js`);
