# Fixed SpaceX lead-lag screening specification (2026-09-09)

Written before inspecting the acquired intraday bars or running return calculations.
Data request: Massive adjusted 5-minute aggregates, 2026-06-12 through 2026-09-04, for SPCX, RKLB, ASTS. QQQ existing cache. Explicitly exclude pre-IPO SPCX history (former ETF ticker reuse). Verify issuer via dated reference metadata before use.

All signals use completed regular-session 5-minute bars. Signal time is end of current bar. Entry is open of the second subsequent bar (5 minutes after signal), not a simultaneous signal-close fill. Require contiguous synchronized leader/follower/QQQ bars; entry and exit must exist. Market control is simple 15-minute return minus QQQ 15-minute return, not a fitted beta and not causal proof.

Four fixed rules: SPCX-up -> RKLB catch-up; SPCX-up -> ASTS catch-up; SPCX-down -> RKLB competitive rotation; SPCX-down -> ASTS competitive rotation. Catch-up signal: SPCX 15-minute market-adjusted return >= 0.8%; follower adjusted return in [-0.5%, +0.25%]; gap >=0.75%; follower current bar positive. Rotation signal: SPCX 15-minute market-adjusted return <= -0.8%; follower adjusted return in [+0.2%, +0.8%]; follower current bar positive. These deliberately test opposite mechanisms rather than assuming a common positive sign.

Signal window: completed bars ending 09:50 through 14:50 New York. Trade horizon 30 minutes primary; 60 minutes diagnostic. Long-only all rules. One signal per follower/day/rule, earliest qualifying signal. No threshold optimization. Date split: first 35 synchronized usable regular sessions training/descriptive; later sessions validation. Validation remains exploratory because sample is newly listed and small. Include every synchronized session as denominator for daily account outcomes. Fees .2% buy and .2% sell, execution friction total .03% baseline or .10% stress, split evenly into entry/exit prices. Fractional all-in capacity assumed solely for illustrative account series; whole-share result separately if useful.

Primary outputs: gross and net forward return, win rate, daily account geometric return with no-trade days zero, daily >=1%/2% share, worst trade/day, max drawdown, individual and combined first-signal one-trade-per-day basket (deterministic RKLB tie-break), train/validation separately. Paired QQQ same-window returns and unconditioned same-clock follower returns provide context; no claim that a relationship is causal.

No claim of day-trading feasibility, tax settlement/rebuy permissions or live fills. No application strategy registration.
