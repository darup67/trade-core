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
