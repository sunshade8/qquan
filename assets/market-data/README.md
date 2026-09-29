# SPY / QQQ historical assets

Massive adjusted 5-minute OHLCV, including 04:00–20:00 New York sessions.
Monthly `.json.gz` files retain source, acquired date coverage and compact daily bars.
`manifest.json` records the last requested range and actual session/bar counts.
These are private data assets, not browser-delivered files under `public/`.

Run from this repository with Node >=22.13:

```sh
node scripts/prefetch-market-data.mjs
# Or an explicit historical range:
node scripts/prefetch-market-data.mjs 2024-09-22 2026-09-21
```

The default is the last 730 days through yesterday in New York. Existing local
D1 bars are exported without network calls. On an initialized empty local D1,
monthly assets restore the cache. Only missing date ranges are downloaded from
Massive using `.dev.vars` or environment credentials, at most one call per 13s.
Failed months do not receive coverage and can be retried by running again.
Set `MARKET_DATA_DB` when the local D1 SQLite path cannot be uniquely discovered.

The app reads this same D1 cache; existing dates, even partial months, no longer
expire after six hours. New requested dates are fetched on demand. No scheduler
is installed. The files and script seed the local environment, not remote D1.
Historical provider corrections/split adjustments are not automatically refreshed;
a deliberate cache rebuild is needed to adopt a revised historical dataset.
