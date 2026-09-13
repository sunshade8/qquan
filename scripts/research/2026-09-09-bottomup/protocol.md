# Intraday bottom-up protocol (predeclared before returns inspection)

This experiment uses ONLY existing local cached 5-minute OHLCV; no external data, API, network or LLM at execution. Universe: NVDA, AMD, TSLA, PLTR, COIN; market context QQQ. US regular session only. Data inventory is allowed; returns have not been inspected for this experiment.

Development: 2024-09-09 <= date < 2025-09-01. Inner validation: 2025-09-01 <= date < 2026-03-04. Full training is their union. Holdout: date >= 2026-03-04, inspected once after freezing cells. Holdout has been reused by prior project research and is NOT pristine. This experiment supplies hypotheses, not significance or production readiness.

Predeclared finite grid: 2 families x 2 windows x 2 return thresholds x 2 opening relative-volume thresholds = 16 cells total. Window A: signal bars starting 10:00 through 11:25; B: 13:00 through 14:55. Strength/dip threshold 0.3% or 0.8%; opening relative-volume threshold 0.8 or 1.3. RV is first 30-minute volume divided by median first30 volume in previous20 complete sessions (never current day's total). First qualifying signal per stock per day per cell only.

1. Momentum continuation: stock day return >= strength threshold; stock day return minus QQQ day return >=0.3%; QQQ day return >=0%; stock last15-minute return >=0.3%; most recent5-minute return >0%; close above cumulative session typical-price VWAP.
2. Market-resilient dip rebound: stock last30-minute return <= negative strength threshold; QQQ last30-minute return >=0%; stock most recent5-minute return >=0.1%; stock previous15 minutes (excluding current5) return <=-0.3%. This tests local rebounds while the benchmark holds up.

All signals use completed bars, enter at next5-minute bar open; require exact contiguous prior/next bars. Long-only. Stop 0.8%, target 2.4%, time exit after 60 minutes or 15:55 bar close, whichever first. Stop fills at minimum(stop, current bar open) if gapped down; target fills conservatively at target; both touched means stop first. Exit timestamps are bar end, making same-bar reinvestment impossible. No same-symbol overlap (one trade/day).

Fee net = exit/entry * (1-.002-.00015)/(1+.002+.00015)-1. This charges .2% commission each side plus .03% roundtrip extra spread/slippage. Stress .10% roundtrip extra instead. Rows retain raw prices/gross returns. Whole-share affordability and shared cash are for parent portfolio engine.

Selection: each family independently; require >=80 full-training trades, >=40 development, >=30 inner-validation trades. Rank by INNER VALIDATION equal-date mean net trade return (each date is one cluster); ties prefer lower RV threshold then lower strength then morning. Freeze one eligible cell per family, regardless of profitability, and only then run holdout once. If none eligible, report no candidate. Report full grid training, rejected cells and negative selected results without changing rules.

Report count/days/no-signal days, gross and net win rates, gross/net means, date-cluster bootstrap confidence intervals for mean net trade return, full training and holdout and stress costs. Bootstrap resamples trading DATE clusters, not individual trades. Missing/incomplete sessions are excluded from calendar, and early close sessions can be included if contiguous required bars exist; eligible session calendar requires all 78 regular 5-minute bars, deliberately excluding half-days. Universe/data availability bias remains.
