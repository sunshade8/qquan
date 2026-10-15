"""Binance USDⓈ-M perpetual 1-minute klines for the CT execution ceiling (docs/research/ct-ceiling-2026-10-15-execution.md).

Source: https://data.binance.vision/data/futures/um (public archive, no credentials; SHA-256 checksum next to every file).
  klines/1m   open_time = bar START (ms), close_time = start + 59,999 ms
Monthly files for full months, daily files for the current (partial) month. Every zip is cached under
<ROOT>/parquet/binance-derivs/raw/ with its verified digest (resumable). Output:
  <ROOT>/parquet/binance-derivs/<SYMBOL>/klines_1m.parquet
  <ROOT>/cache/ceiling-field/<SYMBOL>.um_1m.{startMs,open,high,low,close,volume}.f64   (read by scripts/research/ct-ceiling-execution.ts)

  .venv/bin/python scripts/data/download-binance-um-klines.py [--symbols BTCUSDT,ETHUSDT,SOLUSDT] [--start 2023-11-01] [--end 2026-10-12]
"""

import argparse, csv, hashlib, io, os, time, zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(os.environ.get("QQUAN_DATA_DIR") or Path.home() / ".qquan").expanduser().resolve()
OUT = ROOT / "parquet" / "binance-derivs"
CACHE = ROOT / "cache" / "ceiling-field"
BASE = "https://data.binance.vision/data/futures/um"


def fetch(url: str, optional=False):
    for attempt in range(5):
        try:
            with urlopen(Request(url, headers={"User-Agent": "qquan-ct-research/1"}), timeout=60) as r:
                return r.read()
        except HTTPError as e:
            if e.code == 404 and optional:
                return None
            if e.code in (403, 404):
                raise
            time.sleep(2 * (attempt + 1))
        except (URLError, TimeoutError, ConnectionError):
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}")


def cached_zip(rel: str):
    path = OUT / "raw" / rel
    if path.exists():
        return path.read_bytes()
    data = fetch(f"{BASE}/{rel}", optional=True)
    if data is None:
        return None
    check = fetch(f"{BASE}/{rel}.CHECKSUM", optional=True)
    digest = hashlib.sha256(data).hexdigest()
    if check is not None and check.decode().split()[0] != digest:
        raise RuntimeError(f"checksum mismatch: {rel}")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    tmp.write_bytes(data)
    tmp.replace(path)
    path.with_suffix(path.suffix + ".sha256").write_text(digest + "\n")
    return data


def rows(data: bytes):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        with z.open(z.namelist()[0]) as f:
            for r in csv.reader(io.TextIOWrapper(f)):
                if r and r[0][:1].isdigit():  # skip the header line of newer files
                    yield int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", default="BTCUSDT,ETHUSDT,SOLUSDT")
    ap.add_argument("--start", default="2023-11-01")
    ap.add_argument("--end", default="2026-10-12", help="last UTC day to include")
    args = ap.parse_args()
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    months = []
    y, m = start.year, start.month
    while (y, m) < (end.year, end.month):
        months.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    days = [date(end.year, end.month, 1) + timedelta(d) for d in range((end - date(end.year, end.month, 1)).days + 1)]
    CACHE.mkdir(parents=True, exist_ok=True)
    for symbol in args.symbols.split(","):
        t0 = time.time()
        rels = [f"monthly/klines/{symbol}/1m/{symbol}-1m-{y}-{m:02d}.zip" for (y, m) in months] + [
            f"daily/klines/{symbol}/1m/{symbol}-1m-{d.isoformat()}.zip" for d in days
        ]
        with ThreadPoolExecutor(6) as pool:
            blobs = list(pool.map(cached_zip, rels))
        missing = [r for r, b in zip(rels, blobs) if b is None]
        bars = sorted({r[0]: r for b in blobs if b is not None for r in rows(b)}.values())
        arr = np.array(bars, dtype="<f8")
        cols = {"startMs": arr[:, 0], "open": arr[:, 1], "high": arr[:, 2], "low": arr[:, 3], "close": arr[:, 4], "volume": arr[:, 5]}
        target = OUT / symbol / "klines_1m.parquet"
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp")
        pq.write_table(pa.table({"startMs": pa.array(arr[:, 0].astype("int64")), **{k: v for k, v in cols.items() if k != "startMs"}}), tmp, compression="zstd")
        tmp.replace(target)
        for name, col in cols.items():
            (CACHE / f"{symbol}.um_1m.{name}.f64").write_bytes(np.ascontiguousarray(col).tobytes())
        gaps = int(np.sum(np.diff(arr[:, 0]) != 60_000))
        print(f"[{symbol}] {len(bars)} bars {date.fromtimestamp(arr[0, 0] / 1000)}..{date.fromtimestamp(arr[-1, 0] / 1000)} gaps {gaps} missing files {missing} {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
