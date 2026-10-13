/**
 * Measured order-book impact, p90 of the 1-minute snapshots in `ct_orderbook_samples`.
 * Produced by `node --experimental-strip-types scripts/data/measure-orderbook.mjs --profile`
 * (public Binance `depth` / Upbit `orderbook` endpoints, no keys, no orders) and pasted here.
 * `--check` fails when the live measurement has drifted above these numbers, so the profile
 * can never sit below what was measured.
 *
 * spreadPctP90      full bid-ask spread, percent of mid
 * sideImpactPctP90  price paid versus mid by a market order of the stated size, percent, one side
 */
export type CTMeasuredImpact = {
  samples: number;
  from: string;
  to: string;
  hours: number;
  spreadPctP90: number;
  sideImpactPctP90: number;
  thinBookShare: number;
};
export const CT_MEASUREMENT_SCRIPT = "scripts/data/measure-orderbook.mjs";
export const CT_MEASURED_IMPACT: Record<string, Record<string, CTMeasuredImpact>> = {
  "binance:BTCUSDT": {
    "1000": {
      "samples": 33,
      "from": "2026-10-13T17:41:00.000Z",
      "to": "2026-10-13T18:13:00.000Z",
      "hours": 0.5,
      "spreadPctP90": 0.000012,
      "sideImpactPctP90": 0.000006,
      "thinBookShare": 0
    },
    "10000": {
      "samples": 33,
      "from": "2026-10-13T17:41:00.000Z",
      "to": "2026-10-13T18:13:00.000Z",
      "hours": 0.5,
      "spreadPctP90": 0.000012,
      "sideImpactPctP90": 0.000006,
      "thinBookShare": 0
    }
  },
  "binance:ETHUSDT": {
    "1000": {
      "samples": 33,
      "from": "2026-10-13T17:41:00.000Z",
      "to": "2026-10-13T18:13:00.000Z",
      "hours": 0.5,
      "spreadPctP90": 0.0004,
      "sideImpactPctP90": 0.0002,
      "thinBookShare": 0
    },
    "10000": {
      "samples": 33,
      "from": "2026-10-13T17:41:00.000Z",
      "to": "2026-10-13T18:13:00.000Z",
      "hours": 0.5,
      "spreadPctP90": 0.0004,
      "sideImpactPctP90": 0.000558,
      "thinBookShare": 0
    }
  },
  "binance:SOLUSDT": {
    "1000": {
      "samples": 33,
      "from": "2026-10-13T17:41:00.000Z",
      "to": "2026-10-13T18:13:00.000Z",
      "hours": 0.5,
      "spreadPctP90": 0.00934,
      "sideImpactPctP90": 0.00467,
      "thinBookShare": 0
    },
    "10000": {
      "samples": 33,
      "from": "2026-10-13T17:41:00.000Z",
      "to": "2026-10-13T18:13:00.000Z",
      "hours": 0.5,
      "spreadPctP90": 0.00934,
      "sideImpactPctP90": 0.004671,
      "thinBookShare": 0
    }
  },
  "upbit:KRW-BTC": {
    "1000": {
      "samples": 33,
      "from": "2026-10-13T17:41:00.000Z",
      "to": "2026-10-13T18:13:00.000Z",
      "hours": 0.5,
      "spreadPctP90": 0.07726,
      "sideImpactPctP90": 0.060186,
      "thinBookShare": 0
    },
    "10000": {
      "samples": 33,
      "from": "2026-10-13T17:41:00.000Z",
      "to": "2026-10-13T18:13:00.000Z",
      "hours": 0.5,
      "spreadPctP90": 0.07726,
      "sideImpactPctP90": 0.065764,
      "thinBookShare": 0
    }
  },
  "upbit:KRW-ETH": {
    "1000": {
      "samples": 33,
      "from": "2026-10-13T17:41:00.000Z",
      "to": "2026-10-13T18:13:00.000Z",
      "hours": 0.5,
      "spreadPctP90": 0.088535,
      "sideImpactPctP90": 0.058945,
      "thinBookShare": 0
    },
    "10000": {
      "samples": 33,
      "from": "2026-10-13T17:41:00.000Z",
      "to": "2026-10-13T18:13:00.000Z",
      "hours": 0.5,
      "spreadPctP90": 0.088535,
      "sideImpactPctP90": 0.079498,
      "thinBookShare": 0
    }
  },
  "upbit:KRW-SOL": {
    "1000": {
      "samples": 33,
      "from": "2026-10-13T17:41:00.000Z",
      "to": "2026-10-13T18:13:00.000Z",
      "hours": 0.5,
      "spreadPctP90": 0.206399,
      "sideImpactPctP90": 0.103341,
      "thinBookShare": 0
    },
    "10000": {
      "samples": 33,
      "from": "2026-10-13T17:41:00.000Z",
      "to": "2026-10-13T18:13:00.000Z",
      "hours": 0.5,
      "spreadPctP90": 0.206399,
      "sideImpactPctP90": 0.119475,
      "thinBookShare": 0
    }
  }
};
