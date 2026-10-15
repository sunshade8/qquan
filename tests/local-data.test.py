import io, unittest, tempfile, sys, zipfile, json
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/data"))
import store


class LocalData(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = store.ROOT
        store.ROOT = Path(self.tmp.name)
        self.db = store.connect()
        self.start = store.ms(store.datetime(2025, 1, 2, tzinfo=store.timezone.utc))
        self.end = self.start + 86400000

    def tearDown(self):
        self.db.close()
        store.ROOT = self.old
        self.tmp.cleanup()

    def rows(self, n=60):
        return [
            [
                self.start + i * 60000,
                self.start + (i + 1) * 60000,
                "100",
                "102",
                "99",
                "101",
                "2",
                "202",
            ]
            for i in range(n)
        ]

    def publish(self, dataset="btc", rows=None):
        return store.publish(
            self.db,
            dataset,
            self.start,
            self.end,
            rows or self.rows(),
            "fixture verified",
        )

    def query(self, **kw):
        return store.query(
            self.db,
            {"dataset": "btc", "from": self.start, "to": self.end, "minutes": 15, **kw},
        )

    def test_local_only_rollup_pin_and_correction(self):
        self.publish()
        with patch.object(
            store, "request", side_effect=AssertionError("No market network")
        ):
            r = self.query()
            self.assertEqual(len(r["bars"]), 4)
            self.assertEqual(r["bars"][0]["volume"], 30)
            self.assertEqual(r["externalRequestCount"], 0)
            for minutes, n in [(1, 60), (5, 12), (15, 4), (60, 1)]:
                self.assertEqual(len(self.query(minutes=minutes)["bars"]), n)
            changed = self.rows()
            changed[0][5] = "100.5"
            self.publish(rows=changed)
            self.assertEqual(
                self.query(snapshot=r["snapshot"], minutes=1)["bars"][0]["close"], 101
            )
            self.assertEqual(self.query(minutes=1)["bars"][0]["close"], 100.5)

    def test_corruption_and_missing_coverage(self):
        with self.assertRaisesRegex(ValueError, "데이터 준비"):
            self.query()
        self.publish()
        p = store.parts(self.db, "btc", self.start, self.end)[0]
        (store.ROOT / p["path"]).write_bytes(b"corrupt")
        self.assertFalse(store.valid_part(p))
        with self.assertRaisesRegex(ValueError, "데이터 준비"):
            self.query()

    def test_range_symbol_venue_currency_and_future(self):
        self.publish()
        for key, value in [
            ("instrument", "ETHUSDT"),
            ("venue", "Upbit"),
            ("quoteCurrency", "KRW"),
        ]:
            with self.assertRaisesRegex(ValueError, "identity"):
                self.query(**{key: value})
        with self.assertRaises(ValueError):
            self.query(to=int(store.time.time() * 1000) + 60000)
        with self.assertRaisesRegex(ValueError, "데이터 준비"):
            self.query(to=self.end + 86400000)

    def test_milliseconds_microseconds_duplicates_and_checksum(self):
        def csvzip(stamp):
            b = io.BytesIO()
            with zipfile.ZipFile(b, "w") as z:
                z.writestr(
                    "x.csv", f"{stamp},100,102,99,101,2,{stamp+59999},202,10,1,101,0\n"
                )
            return b.getvalue()

        a = store.parse_binance(csvzip(self.start), self.start, self.end)
        b = store.parse_binance(csvzip(self.start * 1000), self.start, self.end)
        self.assertEqual(a, b)
        self.assertEqual(store.validate(a + b, self.start, self.end)[1], 1)
        with patch.object(
            store, "request", side_effect=[b"0" * 64, csvzip(self.start)]
        ):
            with self.assertRaisesRegex(ValueError, "CHECKSUM"):
                store.binance(self.start, self.end)
        with patch.object(store, "request", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "not published"):
                store.binance(self.start, self.end)

    def test_queue_idempotence_resume_persistence_no_redundant_network(self):
        self.publish()
        id = store.enqueue(self.db, "btc", self.start, self.end)
        self.assertEqual(id, store.enqueue(self.db, "btc", self.start, self.end))
        self.db.close()
        self.db = store.connect()
        with patch.object(store, "request", side_effect=AssertionError("cached")):
            store.work(self.db)
        self.assertEqual(
            self.db.execute(
                "SELECT status FROM local_data_jobs WHERE id=?", (id,)
            ).fetchone()[0],
            "complete",
        )

    def test_incomplete_buckets_and_no_future_leak(self):
        self.publish(rows=self.rows(59))
        self.assertEqual(len(self.query(minutes=60)["bars"]), 0)
        self.assertEqual(
            len(self.query(minutes=5, to=self.start + 4 * 60000)["bars"]), 0
        )

    def test_canceled_owner_cannot_publish_and_resume_reuses_queue(self):
        id = store.enqueue(self.db, "btc", self.start, self.end)

        def canceled(*args):
            self.db.execute(
                "UPDATE local_data_jobs SET status='canceled',lease=NULL,lease_until=0 WHERE id=?",
                (id,),
            )
            return self.rows(), "fixture"

        with patch.object(store, "binance", side_effect=canceled):
            store.work(self.db)
        self.assertEqual(
            self.db.execute(
                "SELECT status FROM local_data_jobs WHERE id=?", (id,)
            ).fetchone()[0],
            "canceled",
        )
        self.assertEqual(len(store.parts(self.db, "btc", self.start, self.end)), 0)
        self.db.execute("UPDATE local_data_jobs SET status='queued' WHERE id=?", (id,))
        with patch.object(store, "binance", return_value=(self.rows(), "fixture")):
            store.work(self.db)
        self.assertEqual(
            self.db.execute(
                "SELECT status FROM local_data_jobs WHERE id=?", (id,)
            ).fetchone()[0],
            "complete",
        )

    def test_raw_split_boundary_is_rejected_before_daily_metadata(self):
        a = store.ms(store.datetime(2024, 6, 9, tzinfo=store.timezone.utc))
        b = a + 3 * 86400000
        rows = [[a, a + 60000, "100", "101", "99", "100", "1", None]]
        store.publish(self.db, "stock", a, b, rows, "fixture raw")
        with self.assertRaisesRegex(ValueError, "split"):
            store.query(
                self.db,
                {
                    "dataset": "stock",
                    "from": a,
                    "to": b,
                    "minutes": 1440,
                    "metadataOnly": True,
                },
            )

    def test_calendar_dst_holiday_early_close_and_split(self):
        import exchange_calendars as xc

        c = xc.get_calendar("XNYS", start="2021-01-01", end="2028-12-31")
        self.assertFalse(c.is_session("2021-12-24"))
        self.assertFalse(c.is_session("2025-01-09"))
        self.assertEqual(
            c.session_close("2021-11-26")
            .tz_convert("America/New_York")
            .strftime("%H:%M"),
            "13:00",
        )
        self.assertEqual(c.session_open("2024-03-08").hour, 14)
        self.assertEqual(c.session_open("2024-03-11").hour, 13)
        self.assertEqual(c.session_open("2021-10-13").hour, 13)

    def test_auto_topup_queues_only_the_missing_days_and_backs_off_after_errors(self):
        _, end = store.target()
        # Everything up to 10 days ago is present for btc; the last 10 days are the hole to fill.
        have_to = end - 10 * 86400000
        floor = end - store.AUTO_WINDOW_DAYS * 86400000
        for name in store.DATASETS:
            self.db.execute(
                "INSERT INTO local_data_parts(id,dataset,start,end,path,sha256,rows,bytes,first,last,source,verified,quality,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (name, name, floor, have_to, "x", "x", 1, 1, floor, have_to, "t", 1, "ok", "v"),
            )
        with patch.object(store, "valid_part", lambda p: True):
            queued = store.auto_topup(self.db)
            self.assertEqual(sorted(queued), sorted(store.DATASETS))
            job = self.db.execute("SELECT start,end FROM local_data_jobs WHERE dataset='btc'").fetchone()
            self.assertEqual((job["start"], job["end"]), (have_to, end))
            # Already queued: a second pass adds nothing new and does not raise.
            store.auto_topup(self.db)
            self.assertEqual(self.db.execute("SELECT count(*) FROM local_data_jobs WHERE dataset='btc'").fetchone()[0], 1)
            # A fresh failure is left alone instead of being retried every pass.
            self.db.execute("UPDATE local_data_jobs SET status='error',updated=?", (int(store.time.time() * 1000),))
            self.assertEqual(store.auto_topup(self.db), [])


if __name__ == "__main__":
    unittest.main()
