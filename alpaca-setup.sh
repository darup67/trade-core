#!/bin/bash
# Stores your Alpaca API key in the macOS Keychain (service "alpaca-api") and tests it.
# Get keys free at https://app.alpaca.markets (paper account is fine) -> Home -> API Keys.
set -e
read -r -p "Alpaca API key id: " KID
read -r -s -p "Alpaca secret key (hidden): " SEC; echo
security delete-generic-password -s alpaca-api >/dev/null 2>&1 || true
security add-generic-password -s alpaca-api -a "$KID" -w "$SEC"
echo "Testing..."
curl -s -f -H "APCA-API-KEY-ID: $KID" -H "APCA-API-SECRET-KEY: $SEC" \
  "https://data.alpaca.markets/v2/stocks/SPY/trades/latest?feed=iex" && echo && echo "OK: key works, stored in Keychain."
