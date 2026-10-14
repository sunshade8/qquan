"""Binance USDⓈ-M futures public derivatives data for the CT ceiling measurement (no credentials).

Source: https://data.binance.vision (public archive; checksums published next to every file).
  premiumIndexKlines/1m  monthly  open_time = bar START (ms); usable once the bar has closed
  fundingRate            monthly  calc_time  = settlement time (ms); usable at/after it
  metrics (5-minute)     daily    create_time = period START (UTC, 'YYYY-MM-DD HH:MM:SS'); the row
                                  describes the COMPLETED window [create_time, +5m): verified against
                                  futures klines (taker ratio matches the [t, t+5m) window), so it is
                                  usable only from create_time + 5 minutes
  liquidationSnapshot             NOT PROVIDED for USDⓈ-M in the archive (no such prefix); the REST
                                  allForceOrders history is no longer served. Recorded as "not provided".

Resumable: every zip is cached under <ROOT>/parquet/binance-derivs/raw/ with its verified SHA-256; the
consolidated parquet files and manifest.json are rewritten atomically at the end.

  .venv/bin/python scripts/data/download-binance-derivs.py [--symbols BTCUSDT,ETHUSDT,SOLUSDT] [--months 36] [--end 2026-10-13]
"""

import argparse, csv, hashlib, io, json, os, sys, tempfile, time, zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(os.environ.get("QQUAN_DATA_DIR") or Path.home() / ".qquan").expanduser().resolve()
OUT = ROOT / "parquet" / "binance-derivs"
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
    """Returns zip bytes (verified), or None when the archive has no such file (e.g. before listing)."""
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


def num(x: str):
    return float(x) if x not in ("", None) else float("nan")


def csv_rows(data: bytes):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        with z.open(z.namelist()[0]) as f:
            reader = csv.reader(io.TextIOWrapper(f))
            header = next(reader)
            if not header or not header[0][0].isalpha():  # headerless files
                yield from ([header] + list(reader))
            else:
                yield from reader


def month_range(end: date, months: int):
    y, m = end.year, end.month
    out = []
    for _ in range(months):
        out.append((y, m))
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return list(reversed(out))


def write_parquet(path: Path, table: pa.Table):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    pq.write_table(table, tmp, compression="zstd")
    tmp.replace(path)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", default="BTCUSDT,ETHUSDT,SOLUSDT")
    ap.add_argument("--months", type=int, default=36)
    ap.add_argument("--end", default="2026-10-13", help="last day to include (UTC)")
    args = ap.parse_args()
    end = date.fromisoformat(args.end)
    manifest = {"generatedAt": datetime.now(timezone.utc).isoformat(), "source": BASE, "files": {}, "notProvided": ["liquidationSnapshot (USDⓈ-M): no archive prefix; REST allForceOrders history discontinued"]}
    months = month_range(end, args.months)
    # Months entirely before `end`'s month come from monthly files; the current month from daily files.
    full_months = [(y, m) for (y, m) in months if (y, m) != (end.year, end.month)]
    start_day = date(months[0][0], months[0][1], 1)
    t0 = time.time()
    for symbol in args.symbols.split(","):
        print(f"[{symbol}] premium index 1m ...", flush=True)
        prem_rows, funding_rows, metric_rows = [], [], []

        def month_file(ym):
            y, m = ym
            return cached_zip(f"monthly/premiumIndexKlines/{symbol}/1m/{symbol}-1m-{y}-{m:02d}.zip")

        with ThreadPoolExecutor(6) as pool:
            for ym, data in zip(full_months, pool.map(month_file, full_months)):
                if data is None:
                    print(f"  missing premium {ym}", flush=True)
                    continue
                for r in csv_rows(data):
                    prem_rows.append((int(r[0]), int(r[6]) + 1, float(r[1]), float(r[2]), float(r[3]), float(r[4])))
        # current (partial) month: daily files
        days = [date(end.year, end.month, 1) + timedelta(d) for d in range((end - date(end.year, end.month, 1)).days + 1)]

        def day_prem(d):
            return cached_zip(f"daily/premiumIndexKlines/{symbol}/1m/{symbol}-1m-{d.isoformat()}.zip")

        with ThreadPoolExecutor(6) as pool:
            for d, data in zip(days, pool.map(day_prem, days)):
                if data is None:
                    print(f"  missing daily premium {d}", flush=True)
                    continue
                for r in csv_rows(data):
                    prem_rows.append((int(r[0]), int(r[6]) + 1, float(r[1]), float(r[2]), float(r[3]), float(r[4])))
        prem_rows = sorted(set(prem_rows))
        print(f"[{symbol}] funding ...", flush=True)

        def fund_file(ym):
            y, m = ym
            return cached_zip(f"monthly/fundingRate/{symbol}/{symbol}-fundingRate-{y}-{m:02d}.zip")

        with ThreadPoolExecutor(6) as pool:
            for ym, data in zip(months, pool.map(fund_file, months)):
                if data is None:
                    continue  # the newest month may not be published yet
                for r in csv_rows(data):
                    funding_rows.append((int(r[0]), int(r[1]), float(r[2])))
        funding_rows = sorted(set(funding_rows))
        # The newest month is not in the monthly archive yet: continue from the public REST endpoint (no key needed).
        end_ms = int(datetime.combine(end + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc).timestamp() * 1000)
        cursor = (funding_rows[-1][0] + 1) if funding_rows else 0
        while cursor < end_ms:
            rest = json.loads(fetch(f"https://fapi.binance.com/fapi/v1/fundingRate?symbol={symbol}&startTime={cursor}&limit=1000"))
            if not rest:
                break
            for r in rest:
                if int(r["fundingTime"]) < end_ms:
                    funding_rows.append((int(r["fundingTime"]), 8, float(r["fundingRate"])))
            cursor = int(rest[-1]["fundingTime"]) + 1
        funding_rows = sorted(set(funding_rows))
        print(f"[{symbol}] metrics (5m) ...", flush=True)
        all_days = [start_day + timedelta(d) for d in range((end - start_day).days + 1)]

        def metric_file(d):
            return cached_zip(f"daily/metrics/{symbol}/{symbol}-metrics-{d.isoformat()}.zip")

        missing_days = []
        with ThreadPoolExecutor(6) as pool:
            for d, data in zip(all_days, pool.map(metric_file, all_days)):
                if data is None:
                    missing_days.append(d.isoformat())
                    continue
                for r in csv_rows(data):
                    ts = int(datetime.strptime(r[0], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp() * 1000)
                    metric_rows.append((ts, *(num(r[i]) for i in range(2, 8))))
        metric_rows = sorted(set(metric_rows))
        base = OUT / symbol
        files = {
            "premium_1m.parquet": pa.table(
                {
                    "startMs": pa.array([r[0] for r in prem_rows], pa.int64()),
                    "endMs": pa.array([r[1] for r in prem_rows], pa.int64()),
                    "open": [r[2] for r in prem_rows], "high": [r[3] for r in prem_rows],
                    "low": [r[4] for r in prem_rows], "close": [r[5] for r in prem_rows],
                }
            ),
            "funding.parquet": pa.table(
                {"calcMs": pa.array([r[0] for r in funding_rows], pa.int64()), "intervalHours": pa.array([r[1] for r in funding_rows], pa.int32()), "rate": [r[2] for r in funding_rows]}
            ),
            "metrics_5m.parquet": pa.table(
                {
                    "startMs": pa.array([r[0] for r in metric_rows], pa.int64()),
                    "openInterest": [r[1] for r in metric_rows], "openInterestValue": [r[2] for r in metric_rows],
                    "topTraderCountRatio": [r[3] for r in metric_rows], "topTraderSumRatio": [r[4] for r in metric_rows],
                    "accountRatio": [r[5] for r in metric_rows], "takerVolRatio": [r[6] for r in metric_rows],
                }
            ),
        }
        for name, table in files.items():
            digest = write_parquet(base / name, table)
            manifest["files"][f"{symbol}/{name}"] = {"rows": table.num_rows, "sha256": digest, "firstMs": int(table.column(0)[0].as_py()) if table.num_rows else None, "lastMs": int(table.column(0)[-1].as_py()) if table.num_rows else None}
        manifest["files"][f"{symbol}/metrics_5m.parquet"]["missingDays"] = missing_days
        print(f"[{symbol}] premium {len(prem_rows)} · funding {len(funding_rows)} · metrics {len(metric_rows)} (missing days {len(missing_days)}) · {time.time() - t0:.0f}s", flush=True)
    (OUT).mkdir(parents=True, exist_ok=True)
    tmp = OUT / "manifest.json.tmp"
    tmp.write_text(json.dumps(manifest, indent=1))
    tmp.replace(OUT / "manifest.json")
    print("done", flush=True)


if __name__ == "__main__":
    main()
