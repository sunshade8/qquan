"""Durable local market catalog. All times are UTC milliseconds, intervals [start,end)."""

import fcntl
import threading
import calendar, csv, hashlib, io, json, math, os, sqlite3, sys, time, uuid, zipfile
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import pyarrow as pa
import pyarrow.parquet as pq

ROOT = (
    Path(os.environ.get("QQUAN_DATA_DIR") or Path.home() / ".qquan")
    .expanduser()
    .resolve()
)
MINUTE = 60000
VERSION = "minute-v1-raw"
DATASETS = {
    "stock": dict(
        market="stock",
        instrument="NVDA",
        venue="US",
        provider="Massive",
        quoteCurrency="USD",
        adjustmentPolicy="unadjusted-session-isolated",
    ),
    "btc": dict(
        market="crypto",
        instrument="BTCUSDT",
        venue="BinanceSpot",
        provider="BinancePublicData",
        quoteCurrency="USDT",
        adjustmentPolicy="none",
    ),
}
FIELDS = ["startMs", "endMs", "open", "high", "low", "close", "volume", "quoteVolume"]
SCHEMA = pa.schema(
    [("startMs", pa.int64()), ("endMs", pa.int64())]
    + [(x, pa.decimal128(30, 10)) for x in FIELDS[2:]]
)


def connect():
    (ROOT / "state").mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(
        ROOT / "state/research.sqlite", timeout=30, isolation_level=None
    )
    db.row_factory = sqlite3.Row
    db.executescript(
        """PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS local_data_jobs(id TEXT PRIMARY KEY,dataset TEXT NOT NULL,status TEXT NOT NULL,start INTEGER,end INTEGER,done INTEGER DEFAULT 0,total INTEGER DEFAULT 0,errors TEXT DEFAULT '[]',updated INTEGER,lease TEXT,lease_until INTEGER DEFAULT 0,refresh INTEGER DEFAULT 0);
 CREATE UNIQUE INDEX IF NOT EXISTS local_download_active ON local_data_jobs(dataset) WHERE status IN ('queued','running');
 CREATE TABLE IF NOT EXISTS local_data_parts(id TEXT PRIMARY KEY,dataset TEXT,start INTEGER,end INTEGER,path TEXT,sha256 TEXT,rows INTEGER,bytes INTEGER,first INTEGER,last INTEGER,source TEXT,verified INTEGER,quality TEXT,version TEXT);
 CREATE INDEX IF NOT EXISTS local_parts_range ON local_data_parts(dataset,start,end);
 CREATE TABLE IF NOT EXISTS local_data_units(job TEXT,start INTEGER,end INTEGER,status TEXT,error TEXT,PRIMARY KEY(job,start,end));
 CREATE TABLE IF NOT EXISTS local_data_snapshots(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS local_data_limits(provider TEXT PRIMARY KEY,next_at REAL NOT NULL);
 """
    )
    return db


def ms(d):
    return int(d.timestamp() * 1000)


def dt(t):
    return datetime.fromtimestamp(t / 1000, timezone.utc)


def iso(t):
    return dt(t).isoformat()


def target():
    end = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    try:
        start = end.replace(year=end.year - 5)
    except ValueError:
        start = end.replace(year=end.year - 5, day=28)
    return ms(start), ms(end)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def filehash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def valid_part(p):
    try:
        path = ROOT / p["path"]
        meta = pq.read_metadata(path)
        identity = pq.read_schema(path).metadata or {}
        expected = DATASETS[p["dataset"]]
        return (
            all(
                identity.get(k.encode()) == str(v).encode() for k, v in expected.items()
            )
            and identity.get(b"schemaVersion") == VERSION.encode()
            and filehash(path) == p["sha256"]
            and meta.num_rows == p["rows"]
            and pq.read_schema(path).remove_metadata() == SCHEMA
        )
    except Exception:
        return False


def parts(db, dataset, start, end):
    return [
        dict(r)
        for r in db.execute(
            "SELECT * FROM local_data_parts WHERE dataset=? AND start<? AND end>? ORDER BY verified,rowid",
            (dataset, end, start),
        )
    ]


def active_parts(rows):
    # Keep old files for snapshots, but avoid counting/reading fully superseded partitions.
    selected = []
    for part in reversed(rows):
        if missing(selected, part["start"], part["end"]):
            selected.append(part)
    return list(reversed(selected))


def missing(parts, start, end):
    cursor = start
    gaps = []
    for p in sorted(parts, key=lambda p: p["start"]):
        if p["start"] > cursor:
            gaps.append([cursor, min(end, p["start"])])
        cursor = max(cursor, p["end"])
        if cursor >= end:
            break
    if cursor < end:
        gaps.append([cursor, end])
    return gaps


def request(url, headers=None, optional=False, provider=None):
    assert_active()
    if os.environ.get("QQUAN_DENY_MARKET_NETWORK") == "1":
        raise RuntimeError("Market network disabled by verification")
    if provider == "Massive":
        db = connect()
        spacing = (
            60 / max(1, int(os.environ.get("MASSIVE_CALLS_PER_MINUTE", "5"))) + 0.5
        )
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT next_at FROM local_data_limits WHERE provider='Massive'"
        ).fetchone()
        at = max(time.time(), row[0] if row else 0)
        db.execute(
            "INSERT OR REPLACE INTO local_data_limits VALUES ('Massive',?)",
            (at + spacing,),
        )
        db.execute("COMMIT")
        db.close()
        time.sleep(max(0, at - time.time()))
    for attempt in range(5):
        try:
            with urlopen(Request(url, headers=headers or {}), timeout=60) as r:
                return r.read()
        except HTTPError as e:
            if e.code == 404 and optional:
                return None
            if e.code in (401, 403):
                raise RuntimeError(
                    f"HTTP {e.code}: provider authorization/entitlement refused"
                ) from None
            if e.code != 429 and e.code < 500:
                raise RuntimeError(f"HTTP {e.code}") from None
            if attempt == 4:
                raise RuntimeError(f"HTTP {e.code}: retry limit") from None
            delay = e.headers.get("Retry-After", "")
            try:
                wait = float(delay)
            except ValueError:
                try:
                    from email.utils import parsedate_to_datetime

                    wait = parsedate_to_datetime(delay).timestamp() - time.time()
                except Exception:
                    wait = 2**attempt * 2
            time.sleep(min(120, max(1, wait)))
        except (OSError, TimeoutError):
            if attempt == 4:
                raise RuntimeError("Provider connection failed after retries") from None
            time.sleep(2**attempt)


def normalize_time(n):
    n = int(n)
    return n // 1000 if n >= 10**14 else n


def parse_binance(content, start, end):
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        names = z.namelist()
        if (
            len(names) != 1
            or not names[0].endswith(".csv")
            or z.getinfo(names[0]).file_size > 150_000_000
        ):
            raise ValueError("Invalid ZIP contents")
        with z.open(names[0]) as f:
            result = []
            for r in csv.reader(io.TextIOWrapper(f)):
                t = normalize_time(r[0])
                if start <= t < end:
                    result.append([t, t + MINUTE, *r[1:6], r[7]])
            return result


def binance(start, end):
    if end - start > 86400000 and not (
        dt(start).day == 1 and dt(end).day == 1 and dt(end).month != dt(start).month
    ):
        rows = []
        sources = []
        for a in range(start, end, 86400000):
            r, s = binance(a, min(a + 86400000, end))
            publish(connect(), "btc", a, min(a + 86400000, end), r, s)
            rows.extend(r)
            sources.append(s)
        return rows, json.dumps(sources)
    d = dt(start)
    monthly = d.day == 1 and dt(end).day == 1 and dt(end).month != (d.month)
    label = d.strftime("%Y-%m" if monthly else "%Y-%m-%d")
    kind = "monthly" if monthly else "daily"
    url = f"https://data.binance.vision/data/spot/{kind}/klines/BTCUSDT/1m/BTCUSDT-1m-{label}.zip"
    checksum = request(url + ".CHECKSUM", optional=True)
    if checksum is None:
        if monthly:
            rows = []
            sources = []
            for a in range(start, end, 86400000):
                r, s = binance(a, min(a + 86400000, end))
                publish(connect(), "btc", a, min(a + 86400000, end), r, s)
                rows.extend(r)
                sources.append(s)
            return rows, json.dumps(sources)
        raise RuntimeError("Archive not published (404); resume after public release")
    data = request(url)
    expected = checksum.decode().split()[0]
    if len(expected) != 64 or digest(data) != expected:
        raise ValueError("Binance CHECKSUM mismatch")
    return parse_binance(data, start, end), url + " sha256=" + expected


def stock(start, end):
    key = os.environ.get("MASSIVE_API_KEY") or os.environ.get("POLYGON_API_KEY")
    if not key:
        raise RuntimeError("MASSIVE_API_KEY or POLYGON_API_KEY required")
    from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse

    url = f"https://api.massive.com/v2/aggs/ticker/NVDA/range/1/minute/{start}/{end-1}?adjusted=false&sort=asc&limit=50000"
    source = url
    rows = []
    for page in range(20):
        data = json.loads(
            request(url, {"Authorization": "Bearer " + key}, provider="Massive")
        )
        if data.get("status") not in ("OK", "DELAYED"):
            raise RuntimeError("Massive unsuccessful aggregate response")
        for b in data.get("results", []):
            t = int(b["t"])
            if start <= t and t + MINUTE <= end:
                rows.append(
                    [t, t + MINUTE, b["o"], b["h"], b["l"], b["c"], b["v"], None]
                )
        url = data.get("next_url")
        if not url:
            return rows, source
        u = urlparse(url)
        if u.scheme != "https" or u.netloc != "api.massive.com":
            raise ValueError("Invalid pagination host")
        url = urlunparse(
            u._replace(
                query=urlencode(
                    [(k, v) for k, v in parse_qsl(u.query) if k != "apiKey"]
                )
            )
        )
    raise RuntimeError("Massive pagination limit; partition not published")


def validate(rows, start, end):
    unique = {}
    duplicates = 0
    for row in rows:
        t = int(row[0])
        converted = [t, int(row[1])] + [
            Decimal(str(x)).quantize(Decimal("0.0000000001")) if x is not None else None
            for x in row[2:]
        ]
        o, h, l, c, v = converted[2:7]
        if (
            t % MINUTE
            or converted[1] != t + MINUTE
            or not start <= t < end
            or converted[1] > end
        ):
            raise ValueError("Invalid minute boundary")
        if (
            not all(x.is_finite() for x in (o, h, l, c, v))
            or min(o, h, l, c) <= 0
            or v < 0
            or h < max(o, l, c)
            or l > min(o, h, c)
        ):
            raise ValueError("Invalid OHLCV")
        if t in unique:
            duplicates += 1
            if unique[t] != converted:
                raise ValueError("Conflicting duplicate bars")
        unique[t] = converted
    return sorted(unique.values()), duplicates


def publish(db, dataset, start, end, rows, source):
    assert_active()
    rows, duplicates = validate(rows, start, end)
    # Immutable hash-named files: running snapshots remain valid after corrections.
    meta = {
        **DATASETS[dataset],
        "schemaVersion": VERSION,
        "datasetVersion": VERSION,
        "source": source,
        "interval": "1m",
        "volumeUnit": "shares" if dataset == "stock" else "BTC",
        "numericPrecision": "decimal128(30,10)",
        "requestedStart": str(start),
        "requestedEnd": str(end),
    }
    table = pa.Table.from_pylist(
        [dict(zip(FIELDS, r)) for r in rows],
        schema=SCHEMA.with_metadata({k: str(v).encode() for k, v in meta.items()}),
    )
    directory = ROOT / "parquet" / dataset / dt(start).strftime("%Y-%m")
    directory.mkdir(parents=True, exist_ok=True)
    tmp = directory / (str(uuid.uuid4()) + ".tmp")
    pq.write_table(table, tmp, compression="zstd")
    if pq.read_table(tmp).num_rows != len(rows):
        raise ValueError("Parquet readback failed")
    sha = filehash(tmp)
    path = directory / (sha + ".parquet")
    os.replace(tmp, path)
    quality = {
        "duplicates": duplicates,
        "invalidRows": 0,
        "absentMinutes": (end - start) // MINUTE - len(rows),
        "absencePolicy": "no synthetic bars; stock absence may be no trades/closed/halts; upstream omissions indistinguishable",
        "splitPolicy": "raw prices; stock research history resets every session",
        "schemaVersion": VERSION,
    }
    db.execute("BEGIN IMMEDIATE")
    try:
        assert_active()
        db.execute(
            "INSERT OR IGNORE INTO local_data_parts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                sha,
                dataset,
                start,
                end,
                str(path.relative_to(ROOT)),
                sha,
                len(rows),
                path.stat().st_size,
                rows[0][0] if rows else None,
                rows[-1][1] if rows else None,
                source,
                int(time.time() * 1000),
                json.dumps(quality),
                VERSION,
            ),
        )
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return sha


def units(dataset, start, end):
    if dataset == "stock":
        return [
            (a, min(a + 7 * 86400000, end)) for a in range(start, end, 7 * 86400000)
        ][::-1]
    result = []
    a = start
    while a < end:
        d = dt(a)
        n = d.replace(day=1) + timedelta(days=32)
        n = n.replace(day=1)
        b = (
            ms(n)
            if d.day == 1 and ms(n) <= end
            else min(end, ms(d + timedelta(days=1)))
        )
        result.append((a, b))
        a = b
    return result


def enqueue(db, dataset, start=None, end=None, refresh=False):
    if dataset not in DATASETS:
        raise ValueError("Unsupported dataset")
    a, b = target()
    start = a if start is None else int(start)
    end = b if end is None else int(end)
    if (
        start % 86400000
        or end % 86400000
        or start >= end
        or end > b
        or end - start > 6 * 366 * 86400000
    ):
        raise ValueError("Historical UTC day range required (max six years)")
    old = db.execute(
        "SELECT id FROM local_data_jobs WHERE dataset=? AND status IN ('queued','running')",
        (dataset,),
    ).fetchone()
    if old:
        return old[0]
    id = str(uuid.uuid4())
    chunks = units(dataset, start, end)
    db.execute("BEGIN IMMEDIATE")
    old = db.execute(
        "SELECT id FROM local_data_jobs WHERE dataset=? AND status IN ('queued','running')",
        (dataset,),
    ).fetchone()
    if old:
        db.execute("COMMIT")
        return old[0]
    try:
        db.execute(
            "INSERT INTO local_data_jobs(id,dataset,status,start,end,total,updated,refresh) VALUES (?,?,?,?,?,?,?,?)",
            (
                id,
                dataset,
                "queued",
                start,
                end,
                len(chunks),
                int(time.time() * 1000),
                int(refresh),
            ),
        )
        db.executemany(
            "INSERT INTO local_data_units VALUES (?,?,?,'pending',NULL)",
            [(id, a, b) for a, b in chunks],
        )
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return id


ACTIVE = None


def assert_active():
    if ACTIVE:
        conn = connect()
        row = conn.execute(
            "SELECT status,lease FROM local_data_jobs WHERE id=?", (ACTIVE[0],)
        ).fetchone()
        conn.close()
        if not row or row["status"] != "running" or row["lease"] != ACTIVE[1]:
            raise RuntimeError("Download canceled; completed partitions preserved")


def heartbeat(id, token, stop):
    conn = connect()
    while not stop.wait(20):
        conn.execute(
            "UPDATE local_data_jobs SET lease_until=?,updated=? WHERE id=? AND lease=? AND status='running'",
            (int(time.time() * 1000) + 120000, int(time.time() * 1000), id, token),
        )
    conn.close()


def work(db):
    global ACTIVE
    token = str(uuid.uuid4())
    now = int(time.time() * 1000)
    db.execute("BEGIN IMMEDIATE")
    job = db.execute(
        "SELECT * FROM local_data_jobs WHERE status IN ('queued','running') AND lease_until<? ORDER BY updated LIMIT 1",
        (now,),
    ).fetchone()
    if not job:
        db.execute("COMMIT")
        return False
    db.execute(
        "UPDATE local_data_jobs SET status='running',lease=?,lease_until=?,updated=? WHERE id=?",
        (token, now + 120000, now, job["id"]),
    )
    db.execute("COMMIT")
    ACTIVE = (job["id"], token)
    stop = threading.Event()
    thread = threading.Thread(
        target=heartbeat, args=(job["id"], token, stop), daemon=True
    )
    thread.start()
    unit = db.execute(
        "SELECT * FROM local_data_units WHERE job=? AND status!='done' ORDER BY start "
        + ("DESC" if job["dataset"] == "stock" else "ASC")
        + " LIMIT 1",
        (job["id"],),
    ).fetchone()
    if unit:
        a, b = unit["start"], unit["end"]
        try:
            known = [p for p in parts(db, job["dataset"], a, b) if valid_part(p)]
            gaps = [[a, b]] if job["refresh"] else missing(known, a, b)
            for x, y in gaps:
                rows, source = (stock if job["dataset"] == "stock" else binance)(x, y)
                publish(db, job["dataset"], x, y, rows, source)
            assert_active()
            db.execute(
                "UPDATE local_data_units SET status='done',error=NULL WHERE job=? AND start=? AND end=?",
                (job["id"], a, b),
            )
        except Exception as e:
            # No key values or provider response bodies are persisted.
            current = db.execute(
                "SELECT lease FROM local_data_jobs WHERE id=?", (job["id"],)
            ).fetchone()
            if not current or current[0] != token:
                stop.set()
                ACTIVE = None
                return True
            error = f"{iso(a)} .. {iso(b)}: {type(e).__name__}: {str(e)[:220]}"
            db.execute(
                "UPDATE local_data_units SET status='failed',error=? WHERE job=? AND start=? AND end=?",
                (error, job["id"], a, b),
            )
            db.execute(
                "UPDATE local_data_jobs SET status='error',errors=?,lease_until=0,updated=? WHERE id=? AND lease=? AND status='running'",
                (json.dumps([error]), int(time.time() * 1000), job["id"], token),
            )
            stop.set()
            ACTIVE = None
            return True
    done = db.execute(
        "SELECT count(*) FROM local_data_units WHERE job=? AND status='done'",
        (job["id"],),
    ).fetchone()[0]
    db.execute(
        "UPDATE local_data_jobs SET done=?,status=?,lease=NULL,lease_until=0,updated=? WHERE id=? AND lease=? AND status='running'",
        (
            done,
            "complete" if done == job["total"] else "queued",
            int(time.time() * 1000),
            job["id"],
            token,
        ),
    )
    stop.set()
    ACTIVE = None
    return True


def status(db):
    a, b = target()
    result = []
    for name, meta in DATASETS.items():
        allparts = parts(db, name, a, b)
        validated = [p for p in allparts if valid_part(p)]
        good = active_parts(validated)
        gaps = missing(good, a, b)
        ordered = sorted(good, key=lambda p: p["start"])
        overlap = any(p["start"] < q["end"] for p, q in zip(ordered[1:], ordered))
        rows = sum(p["rows"] for p in good)
        if overlap:
            import pyarrow.compute as pc

            columns = [
                pq.ParquetFile(ROOT / p["path"])
                .read(columns=["startMs"])
                .column(0)
                .combine_chunks()
                for p in good
            ]
            rows = pc.count_distinct(pa.concat_arrays(columns)).as_py()
        sessions = 0
        if name == "stock":
            dates = set()
            for p in good:
                for t in (
                    pq.ParquetFile(ROOT / p["path"])
                    .read(columns=["startMs"])
                    .column(0)
                    .to_pylist()
                ):
                    dates.add(dt(t).date())
            sessions = len(dates)
        job = db.execute(
            "SELECT * FROM local_data_jobs WHERE dataset=? ORDER BY updated DESC LIMIT 1",
            (name,),
        ).fetchone()
        result.append(
            dict(
                dataset=name,
                **meta,
                location=str(ROOT / "parquet" / name),
                target=[a, b],
                coverage=[[p["start"], p["end"]] for p in good],
                missingRanges=gaps,
                rows=rows,
                sessions=sessions,
                bytes=sum(p["bytes"] for p in good),
                latest=max([p["last"] or 0 for p in good], default=None),
                updated=max([p["verified"] for p in good], default=None),
                corruptFiles=len(allparts) - len(validated),
                status="ready" if not gaps else "partial" if good else "empty",
                job=dict(job) if job else None,
            )
        )
    return result


def query(db, q):
    name = q["dataset"]
    meta = DATASETS[name]
    a = int(q["from"])
    b = int(q["to"])
    minutes = int(q.get("minutes", 1))
    if minutes not in (1, 5, 15, 60, 1440) or a >= b or b > int(time.time() * 1000):
        raise ValueError("Invalid query interval")
    for k in ("instrument", "venue", "quoteCurrency", "adjustmentPolicy"):
        if k in q and q[k] != meta[k]:
            raise ValueError("Unsupported dataset identity: " + k)
    if q.get("networkPolicy", "local-only") != "local-only":
        raise ValueError("Use explicit download queue for network access")
    snapshot = q.get("snapshot")
    if snapshot:
        r = db.execute(
            "SELECT payload FROM local_data_snapshots WHERE id=?", (snapshot,)
        ).fetchone()
        if not r:
            raise ValueError("Unknown dataset snapshot")
        payload = json.loads(r[0])
        if payload["dataset"] != name or a < payload["from"] or b > payload["to"]:
            raise ValueError("Snapshot range/identity mismatch")
        chosen = payload["parts"]
    else:
        chosen = active_parts(parts(db, name, a, b))
    good = [p for p in chosen if valid_part(p)]
    gaps = missing(good, a, b)
    if gaps:
        raise ValueError(
            "데이터 준비 필요: 설정 → "
            + ("주식 1분봉" if name == "stock" else "코인 1분봉")
            + " 다운로드. Missing "
            + json.dumps(gaps)
        )
    if not snapshot:
        payload = {"dataset": name, "from": a, "to": b, "parts": good}
        serialized = json.dumps(payload, sort_keys=True)
        snapshot = digest(serialized.encode())
        db.execute(
            "INSERT OR IGNORE INTO local_data_snapshots VALUES (?,?)",
            (snapshot, serialized),
        )
    if (
        name == "stock"
        and minutes == 1440
        and any(a < boundary < b for boundary in (1626739200000, 1717977600000))
    ):
        raise ValueError(
            "Unadjusted daily study crosses NVDA split: adjusted derived dataset required"
        )
    if q.get("metadataOnly"):
        return dict(
            bars=[],
            datasetVersion=VERSION,
            snapshot=snapshot,
            provenance=meta,
            coverage=[[p["start"], p["end"]] for p in good],
            missingRanges=[],
            qualityReport=[json.loads(p["quality"]) for p in good],
            localReadCount=0,
            externalRequestCount=0,
        )
    bytime = {}
    reads = 0
    for p in good:
        if p["start"] >= b or p["end"] <= a:
            continue
        table = pq.ParquetFile(ROOT / p["path"]).read()
        reads += 1
        for r in table.to_pylist():
            if a <= r["startMs"] and r["endMs"] <= b:
                bytime[r["startMs"]] = r
    rows = sorted(bytime.values(), key=lambda r: r["startMs"])
    groups = {}
    bounds = None
    if name == "stock" and q.get("session", "regular") == "regular":
        import exchange_calendars as xc

        cal = xc.get_calendar(
            "XNYS",
            start=dt(a).date() - timedelta(days=7),
            end=dt(b).date() + timedelta(days=7),
        )
        bounds = {
            str(day.date()): (ms(row["open"]), ms(row["close"]))
            for day, row in cal.schedule.iterrows()
        }
    for r in rows:
        if bounds is not None:
            session = bounds.get(dt(r["startMs"]).strftime("%Y-%m-%d"))
            if session is None or not (
                session[0] <= r["startMs"] and r["endMs"] <= session[1]
            ):
                continue
        at = r["startMs"] // (minutes * MINUTE) * (minutes * MINUTE)
        groups.setdefault(at, []).append(r)
    bars = []
    for at, rs in groups.items():
        if minutes == 1440:
            if name == "stock" and any(
                a < boundary < b for boundary in (1626739200000, 1717977600000)
            ):
                raise ValueError(
                    "Unadjusted daily study crosses NVDA split: adjusted derived dataset required"
                )
            if at + minutes * MINUTE > b:
                continue
        elif (
            len(rs) != minutes
            or any(r["startMs"] != at + i * MINUTE for i, r in enumerate(rs))
            or at + minutes * MINUTE > b
        ):
            continue
        bars.append(
            dict(
                startMs=at,
                endMs=at + minutes * MINUTE,
                open=float(rs[0]["open"]),
                high=float(max(r["high"] for r in rs)),
                low=float(min(r["low"] for r in rs)),
                close=float(rs[-1]["close"]),
                volume=float(sum(r["volume"] for r in rs)),
            )
        )
    if len(bars) > int(q.get("maxBars", 200000)):
        raise ValueError("Query too large: request bounded pages")
    return dict(
        bars=bars,
        datasetVersion=VERSION,
        snapshot=snapshot,
        provenance=meta,
        coverage=[[p["start"], p["end"]] for p in good],
        missingRanges=[],
        qualityReport=[json.loads(p["quality"]) for p in good],
        localReadCount=reads,
        externalRequestCount=0,
    )


def main():
    db = connect()
    command = sys.argv[1]
    if command == "worker":
        lock = open(ROOT / "state/downloader.lock", "a")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        while True:
            if not work(db):
                time.sleep(2)
    elif command in ("status", "cancel", "resume"):
        if command == "status":
            print(json.dumps(status(db)))
        else:
            state = "canceled" if command == "cancel" else "queued"
            db.execute(
                "UPDATE local_data_jobs SET status=?,lease=NULL,lease_until=0,errors='[]',updated=? WHERE id=? AND status!='complete'",
                (state, int(time.time() * 1000), sys.argv[2]),
            )
            print(json.dumps({"id": sys.argv[2], "status": state}))
    elif command == "rpc":
        q = json.load(sys.stdin)
        action = q["action"]
        if action == "status":
            result = status(db)
        elif action == "query":
            result = query(db, q)
        elif action == "enqueue":
            result = {
                "id": enqueue(
                    db,
                    q["dataset"],
                    q.get("from"),
                    q.get("to"),
                    q.get("refresh", False),
                )
            }
        elif action in ("cancel", "resume"):
            state = "canceled" if action == "cancel" else "queued"
            db.execute(
                "UPDATE local_data_jobs SET status=?,lease=NULL,lease_until=0,errors='[]',updated=? WHERE id=? AND status NOT IN ('complete')",
                (state, int(time.time() * 1000), q["id"]),
            )
            result = {"id": q["id"]}
        else:
            raise ValueError("Unknown action")
        print(json.dumps(result))
    elif command in DATASETS:
        args = sys.argv[2:]
        a = (
            ms(datetime.fromisoformat(args[0]).replace(tzinfo=timezone.utc))
            if args and not args[0].startswith("--")
            else None
        )
        b = (
            ms(datetime.fromisoformat(args[1]).replace(tzinfo=timezone.utc))
            if len(args) > 1 and not args[1].startswith("--")
            else None
        )
        id = enqueue(db, command, a, b, "--refresh" in args)
        print(json.dumps({"job": id}), flush=True)
        while db.execute(
            "SELECT status FROM local_data_jobs WHERE id=?", (id,)
        ).fetchone()[0] in ("queued", "running"):
            if not work(db):
                time.sleep(2)
        final = dict(
            db.execute("SELECT * FROM local_data_jobs WHERE id=?", (id,)).fetchone()
        )
        print(json.dumps(final))
        if final["status"] != "complete":
            sys.exit(2)
    else:
        raise ValueError("Usage: store.py worker|stock|btc|rpc")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
