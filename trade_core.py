"""Python read access to trade-core's shared market store (data/market.db, closed 15m bars).

    import sys; sys.path.insert(0, "/Users/dhruvpatel/trade-core"); import trade_core
    bars = trade_core.bars("US:NVDA", days=10)      # [{"t","o","h","l","c","v","src"}] ascending

Read-only: the Node side (bars.js) is the only writer, so there's one fetcher per symbol.
"""
import os, sqlite3, time

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "market.db")


def _conn():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
    c.row_factory = sqlite3.Row
    return c


def bars(sym, days=30):
    with _conn() as c:
        rows = c.execute("SELECT t,o,h,l,c,v,src FROM bars WHERE sym=? AND t>=? ORDER BY t",
                         (sym, int((time.time() - days * 86400) * 1000))).fetchall()
    return [dict(r) for r in rows]


def symbols():
    with _conn() as c:
        return [r[0] for r in c.execute("SELECT DISTINCT sym FROM bars ORDER BY sym")]


# ---- writers used by Python products (2026-09-28) ------------------------------------------
LEDGER = os.path.join(os.path.dirname(DB), "ledger.db")
EVIDENCE = os.path.join(os.path.dirname(DB), "evidence.json")


def evidence():
    import json
    try:
        with open(EVIDENCE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def option_ticket(t, account="Level 3 margin account ••7521 (enter by hand; the agent account is cash / Level 2 and cannot hold spreads)"):
    """Order ticket for a market-iv bull call spread. I never place it: the user enters it by hand. Claude can only pull live leg quotes for a ticket."""
    key = f'{t["ticker"]}:{t["exp"]}:{t["long"]}:{t["short"]}'
    h = 0
    for ch in key:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    b36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    s = ""
    while h:
        h, r = divmod(h, 36)
        s = b36[r] + s
    return {"id": "O" + s[:5], "sym": t["ticker"], "strategy": "bull call spread", "exp": t["exp"],
            "buy": f'{t["long"]:g}C', "sell": f'{t["short"]:g}C', "limit": round(t["limit"], 2), "qty": t["qty"],
            "maxLossUsd": round(t["cost"]), "maxGainUsd": round(t["max_gain"]), "account": account}


def add_spread(sector, t, ticket=None):
    """Log an ACT spread to the ledger (product market-iv, kind spread:<sector>); graded at expiry."""
    import json, sqlite3, datetime as dt
    day = dt.date.today().isoformat()
    ts = int(time.time() * 1000)
    sid = f'market-iv:spread:{sector}:US:{t["ticker"]}:{day}:{t["exp"]}:{t["long"]}/{t["short"]}'
    meta = {k: t.get(k) for k in ("exp", "long", "short", "qty", "spot", "p_profit", "max_gain", "cost", "be", "explode", "bias", "event_before_exp")}
    meta["sector"] = sector
    c = sqlite3.connect(LEDGER, timeout=10)
    try:
        c.execute("PRAGMA busy_timeout=10000")
        c.execute("""INSERT OR IGNORE INTO signals (id,product,kind,sym,asset,tf,side,t,price,stop,target,atr,regime,meta,source,emailed,ticket)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                  (sid, "market-iv", f"spread:{sector}", f'US:{t["ticker"]}', "option", 1440, "long", ts, t["limit"], None, None, None,
                   None, json.dumps(meta), "live", 1, json.dumps(ticket) if ticket else None))
        c.commit()
    finally:
        c.close()
    return sid


def add_event(product, kind, sym, asset, t_ms, price, outcome, side="long", meta=None):
    """Log an event-style signal whose outcome is already known (used by coin-launch prelaunch picks).
    outcome = {"net": float, "gross": float, "win": bool, "cost": float}. Graded rows need no market bars."""
    import json, sqlite3
    sid = f"{product}:{kind}:{sym}:{int(t_ms)}"
    m = dict(meta or {}); m["outcome"] = outcome
    c = sqlite3.connect(LEDGER, timeout=10)
    try:
        c.execute("PRAGMA busy_timeout=10000")
        c.execute("""INSERT OR IGNORE INTO signals (id,product,kind,sym,asset,tf,side,t,price,stop,target,atr,regime,meta,source,emailed,ticket)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                  (sid, product, kind, sym, asset, 5, side, int(t_ms), price, None, None, None, None, json.dumps(m), "live", 0, None))
        c.commit()
    finally:
        c.close()
    return sid
