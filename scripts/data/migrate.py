"""Discover/back up Miniflare DBs. Import only into app-initialized matching schemas."""

import argparse, sqlite3, time
from pathlib import Path
from store import ROOT, connect

p = argparse.ArgumentParser()
p.add_argument("--import-file", type=Path)
p.add_argument("--backup", action="store_true")
args = p.parse_args()
backup = ROOT / "backups"
backup.mkdir(parents=True, exist_ok=True, mode=0o700)


def save(db, label):
    dest = backup / (label + "-" + str(time.time_ns()) + ".sqlite")
    out = sqlite3.connect(dest)
    db.backup(out)
    out.close()
    return str(dest)


if args.backup:
    db = connect()
    print("backup:", save(db, "research"))
    db.close()
elif args.import_file:
    source = sqlite3.connect(f"file:{args.import_file.resolve()}?mode=ro", uri=True)
    dest = connect()
    print("original preserved; snapshot:", save(source, "miniflare"))
    print("destination snapshot:", save(dest, "before-import"))
    tables = {
        r[0]
        for r in source.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    }
    if not {"strategy_generation_runs", "llm_usage", "trading_dashboards"} <= tables:
        raise SystemExit("Unrecognized/incomplete application schema: refusing import")
    known = {
        r[0] for r in dest.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    plans = []
    for name in sorted(tables & known):
        if not name.replace("_", "").isalnum() or name.startswith("local_data_"):
            continue
        a = source.execute(f'PRAGMA table_info("{name}")').fetchall()
        b = dest.execute(f'PRAGMA table_info("{name}")').fetchall()
        if sorted((r[1], r[2].upper(), r[5]) for r in a) != sorted(
            (r[1], r[2].upper(), r[5]) for r in b
        ):
            raise SystemExit(
                "Schema mismatch; migrate original with app migrations first: " + name
            )
        plans.append((name, a))
    dest.execute("BEGIN IMMEDIATE")
    try:
        count = 0
        for name, cols in plans:
            for row in source.execute(f'SELECT * FROM "{name}"'):
                # Conflicts fail and roll back instead of replacing any user's records.
                columns = ",".join('"' + r[1] + '"' for r in cols)
                dest.execute(
                    f'INSERT INTO "{name}" ({columns}) VALUES ({",".join("?" for _ in cols)})',
                    row,
                )
                count += 1
        dest.commit()
        print("Imported rows:", count)
    except Exception:
        dest.rollback()
        raise
else:
    for f in Path(".wrangler").glob("**/*.sqlite"):
        db = sqlite3.connect(f"file:{f.resolve()}?mode=ro", uri=True)
        tables = [
            r[0]
            for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
        ]
        print(str(f), "tables:", ",".join(tables))
        db.close()
