"""Exports the derivative / Upbit parquet files to flat little-endian float64 columns for the ceiling measurement
(scripts/research/ct-ceiling-field.ts reads them with Float64Array). Read-only on the sources; output: <ROOT>/cache/ceiling-field/.

  .venv/bin/python scripts/data/export-ceiling-cache.py
"""
import os
from pathlib import Path
import numpy as np
import pyarrow.parquet as pq

ROOT = Path(os.environ.get("QQUAN_DATA_DIR") or Path.home() / ".qquan").expanduser().resolve()
OUT = ROOT / "cache" / "ceiling-field"
OUT.mkdir(parents=True, exist_ok=True)


def dump(table, prefix):
    for name in table.column_names:
        col = table.column(name).to_numpy(zero_copy_only=False).astype("<f8")
        (OUT / f"{prefix}.{name}.f64").write_bytes(col.tobytes())
    print(prefix, table.num_rows, "rows", table.column_names)


for symbol in ("BTCUSDT", "ETHUSDT", "SOLUSDT"):
    for kind in ("premium_1m", "funding", "metrics_5m"):
        dump(pq.read_table(ROOT / "parquet" / "binance-derivs" / symbol / f"{kind}.parquet"), f"{symbol}.{kind}")
for market in ("KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-USDT"):
    path = ROOT / "parquet" / "upbit" / market / "minute.parquet"
    if path.exists():
        dump(pq.read_table(path), f"upbit.{market}")
    else:
        print("missing", path)
