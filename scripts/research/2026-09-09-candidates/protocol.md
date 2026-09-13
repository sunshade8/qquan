# Intraday candidate study, 2026-09-09

Written before evaluating the new rules. Research only; no strategy registration or orders.

- Starting cash USD 1,000. Returns compound on the changing equity balance.
- Fee 0.2% on BOTH notional sides; baseline execution slippage/spread 0.015% each side, stress 0.05% each side. No FX conversions, margin, short selling, fixed operating costs or annual tax modeled.
- Universe fixed: NVDA, AMD, TSLA, PLTR, COIN; QQQ used only as a market state filter. Cached 5-minute bars 2024-09-09 through 2026-09-04.
- Training before 2026-03-04; chronological evaluation after that date, with fixed rules and no OOS tuning. This history was already used in earlier studies and is NOT a pristine holdout. These are exploratory candidate results, not confirmed edges.
- Reject incomplete 78-bar sessions for signals. Count every SPY session, including five shortened sessions, in daily equity and target hit rates.
- Signals use completed bars only; enter next contiguous 5-minute bar at open, with adverse execution cost. No limit-order fill assumption. Stop/target fixed from information at signal. Stop gap fills at worse open; if both touched within a bar, stop first. Exit cash unavailable until bar end. Targets fill only at their price. All trades flatten by final regular bar close.
- No same-symbol simultaneous positions. Account tests: (a) one position, 100% available cash; (b) up to three positions, each up to one third of marked equity. Whole shares, cash reserved including entry costs, no borrowing. Deterministic chronological then strategy ID then symbol ordering, no hindsight selection.
- Report trade mean gross/net, chronological IS/OOS, per-date block-bootstrap mean CI, gross positive probability separately from profitable after fees. Report account compound return, geometric daily return, loss/no-trade days, >=1% and >=2% days, worst day and 5-minute marked drawdown. No additive per-strategy capital duplication.

## Fixed top-down hypotheses

P1: Prior-day low liquidity sweep. Between 09:45 and 11:30, price traded >=0.2% below yesterday's low, then closes >=0.1% above it, candle close above previous bar high, and QQQ's last 15-minute return is positive. Stop at low so far minus 0.1%; signal stop distance 0.6%-2.5%; target 2R; max holding 90 minutes. At most one signal per symbol/day. Mechanism: failed downside auction / forced selling exhaustion; reject if net continuation is absent.

P2: Opening impulse, controlled pullback, resumption. First 30 minutes rise >=1% with first-30-minute volume >=1.5 times prior 20-session median and opening close location >=0.7. QQQ first 30 minutes >=0%. Between 10:00 and 12:00, price pulls back 25%-60% of opening range, remains above opening-range midpoint, then closes above previous bar high and VWAP. Stop pullback low minus 0.1%; stop distance 0.6%-2.5%; target 2.5R; max holding 120 minutes. At most one signal/day. Mechanism: persistent large-buyer demand survives first profit-taking, distinct from prior quiet-volume ORB rejection.

P3: Afternoon compression release. At 13:30, gain from open >=1%, QQQ gain >=0%, 12:00-13:30 range <=45% of 09:30-12:00 range, and stock above VWAP. Between 13:30 and 14:45, completed close exceeds lunch high with bar volume >=1.5 times previous 12-bar median. Stop lunch low minus 0.1%; distance 0.6%-2.5%; target 2R; flatten final session close. At most one signal/day. Mechanism: supply contraction during a persistent accumulation day.

Main parameters above are fixed. Robustness replays use target multiple *0.8 and *1.2, one full-bar entry delay, and higher execution cost, without selecting among these based on test outcomes. All failures remain in report.
