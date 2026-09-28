# trade-core

Shared foundation for the trading tools on this Mac. Started 2026-09-28.

- `bars.js`: the shared market-data store (`data/market.db`, closed 15m bars). It fetches only what's missing since the last stored bar. Crypto sources back each other up (Coinbase, Binance, Kraken, Bitstamp); stocks can fall back to Alpaca once a key is in Keychain (`alpaca-api`).
- `trade_core.py`: read-only access to the store from Python.
- `ledger.js`: every signal from every product, with net-of-cost outcomes, market-condition tags and evidence status.

Consumers: flip-notifier (headless watcher, stats, labs). Other projects keep their own specialised data: options chains (market-iv), headlines (event-desk), pump.fun candles (coin-launch), Kalshi quotes (market-lab).
