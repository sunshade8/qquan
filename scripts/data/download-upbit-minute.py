"""Upbit KRW 1-minute candles (public Quotation API, no credentials) for the CT ceiling's Upbit price path
and the Upbit–Binance gap (docs/research/ct-ceiling-2026-10-14-field.md).

API facts (https://docs.upbit.com/kr/reference/list-candles-minutes, rate-limits; confirmed against real responses):
  - GET /v1/candles/minutes/1?market=KRW-BTC&count=200&to=<ISO8601 Z>; count ≤ 200
  - `to` is EXCLUSIVE: to=T returns candles that started before T, newest first
  - candle_date_time_utc is the candle START; a candle covers [start, start+1m)
  - minutes with NO trade are OMITTED (no candle) — see filled() below for how they are treated
  - candle group limit: 10 requests/second per IP (Remaining-Req: sec=N); HTTP 429 → wait for the next second,
    repeated violations → 418 temporary block. We send ≤ 8/second and honour Remaining-Req.

Resumable: pages are appended to <ROOT>/parquet/upbit/raw/<market>.jsonl as they arrive; a restart continues
from the oldest stored candle. When the range is complete the consolidated parquet is written atomically:
  <ROOT>/parquet/upbit/<market>/minute.parquet  (startMs, endMs, open, high, low, close, volume, quoteVolume)
Empty minutes stay absent in the parquet (raw truth). `lib`-side loaders / the ceiling script forward-fill a
missing minute as a flat zero-volume bar at the previous close (a price that did not trade did not move) and
count how many were filled.

  .venv/bin/python scripts/data/download-upbit-minute.py [--markets KRW-BTC,KRW-USDT,KRW-ETH,KRW-SOL] [--from 2025-10-13] [--to 2026-10-14]
"""

import argparse, hashlib, json, os, time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(os.environ.get("QQUAN_DATA_DIR") or Path.home() / ".qquan").expanduser().resolve()
OUT = ROOT / "parquet" / "upbit"
API = "https://api.upbit.com/v1/candles/minutes/1"
MIN_GAP = 0.125  # ≤ 8 requests per second


def to_ms(day: str):
    return int(datetime.fromisoformat(day).replace(tzinfo=timezone.utc).timestamp() * 1000)


def iso(ms: int):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


last_call = 0.0


def page(market: str, before_ms: int):
    global last_call
    for attempt in range(8):
        wait = MIN_GAP - (time.time() - last_call)
        if wait > 0:
            time.sleep(wait)
        last_call = time.time()
        try:
            req = Request(f"{API}?market={market}&count=200&to={iso(before_ms)}", headers={"Accept": "application/json", "User-Agent": "qquan-ct-research/1"})
            with urlopen(req, timeout=30) as r:
                remaining = r.headers.get("Remaining-Req", "")
                if "sec=0" in remaining:
                    time.sleep(1.1)
                return json.loads(r.read())
        except HTTPError as e:
            if e.code == 429:
                time.sleep(1.2 * (attempt + 1))
                continue
            if e.code == 418:
                raise RuntimeError("Upbit temporary block (418); stop and retry later")
            raise
        except (URLError, TimeoutError, ConnectionError):
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("Upbit request failed")


def download(market: str, start_ms: int, end_ms: int):
    raw = OUT / "raw" / f"{market}.jsonl"
    raw.parent.mkdir(parents=True, exist_ok=True)
    seen: dict[int, list] = {}
    if raw.exists():
        for line in raw.read_text().splitlines():
            if line:
                c = json.loads(line)
                seen[c[0]] = c
    cursor = min(seen) if seen else end_ms
    pages = 0
    t0 = time.time()
    with raw.open("a") as out:
        while cursor > start_ms:
            data = page(market, cursor)
            if not data:
                break
            fresh = []
            for c in data:
                s = int(datetime.fromisoformat(c["candle_date_time_utc"]).replace(tzinfo=timezone.utc).timestamp() * 1000)
                row = [s, c["opening_price"], c["high_price"], c["low_price"], c["trade_price"], c["candle_acc_trade_volume"], c["candle_acc_trade_price"]]
                if s not in seen:
                    seen[s] = row
                    fresh.append(row)
            for row in fresh:
                out.write(json.dumps(row) + "\n")
            out.flush()
            oldest = min(int(datetime.fromisoformat(c["candle_date_time_utc"]).replace(tzinfo=timezone.utc).timestamp() * 1000) for c in data)
            if oldest >= cursor:
                raise RuntimeError("cursor did not advance")
            cursor = oldest
            pages += 1
            if pages % 100 == 0:
                print(f"  {market}: {pages} pages · back to {iso(cursor)} · {time.time() - t0:.0f}s", flush=True)
    rows = sorted((r for s, r in seen.items() if start_ms <= s < end_ms), key=lambda r: r[0])
    table = pa.table(
        {
            "startMs": pa.array([r[0] for r in rows], pa.int64()),
            "endMs": pa.array([r[0] + 60_000 for r in rows], pa.int64()),
            "open": [r[1] for r in rows], "high": [r[2] for r in rows], "low": [r[3] for r in rows],
            "close": [r[4] for r in rows], "volume": [r[5] for r in rows], "quoteVolume": [r[6] for r in rows],
        }
    )
    path = OUT / market / "minute.parquet"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    pq.write_table(table, tmp, compression="zstd")
    tmp.replace(path)
    minutes = (end_ms - start_ms) // 60_000
    info = {"market": market, "rows": table.num_rows, "expectedMinutes": minutes, "emptyMinutes": minutes - table.num_rows, "firstMs": rows[0][0] if rows else None, "lastMs": rows[-1][0] if rows else None, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "seconds": round(time.time() - t0)}
    (OUT / market / "manifest.json").write_text(json.dumps(info, indent=1))
    print(json.dumps(info), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--markets", default="KRW-BTC,KRW-USDT,KRW-ETH,KRW-SOL")
    ap.add_argument("--from", dest="start", default="2025-10-13")
    ap.add_argument("--to", dest="end", default="2026-10-14")
    args = ap.parse_args()
    for market in args.markets.split(","):
        download(market, to_ms(args.start), to_ms(args.end))
    print("done", flush=True)


if __name__ == "__main__":
    main()
