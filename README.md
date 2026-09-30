# vinext-starter

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Email and name are intended for display or contact purposes.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## QQuant agents

Two agents share one LLM layer (`lib/claude.ts` for Anthropic, `lib/openai.ts` for the frontier
tier). Every call is assigned a *role*, and each role maps to a model tier so the frontier model
is only used where it matters:

| Tier | Env override | Default | Roles |
| --- | --- | --- | --- |
| frontier | `ANTHROPIC_MODEL` (or OpenAI, below) | `claude-opus-4-7` | Lab JARVIS orchestrator, News synthesizer, strategy builder |
| counter | — (derived) | opposite provider's frontier | challenger — reviews frontier output |
| balanced | `ANTHROPIC_MODEL_BALANCED` | `claude-sonnet-5` | headline sentiment analyst, request planner, and the auditor roles — pattern analyst, similarity auditor, Lab sweep judge, Lab result auditor |
| fast | `ANTHROPIC_MODEL_FAST` | `claude-haiku-4-5` | routing, summarisation |

Tiers follow the cost of being wrong rather than call volume, with one deliberate exception. The
`auditor` role decides whether an effect is real and tries to break the orchestrator's
conclusions — the most consequential judgement in the app — yet it stays on `balanced`. That is
not a cost decision. The frontier tier can be served by the same provider as the orchestrator, and
an auditor running the same model as the author it reviews shares that author's blind spots.
Pinning it to `balanced` guarantees a different model and a fresh context; promoting it to
`frontier` while `LLM_FRONTIER_PROVIDER=openai` would make the reviewer and the reviewed the same
model and quietly defeat the review.

The `counter` tier exists for the same reason one level up. `orchestrator`, `synthesizer` and
`strategist` all sit on `frontier`, which resolves to a single model id — so any review one of
them performs on another's work is self-review under a different prompt. `counter` is defined as
*whichever vendor does not serve frontier*: with `LLM_FRONTIER_PROVIDER=openai` the frontier roles
run GPT-6 Astra and the `challenger` runs `claude-opus-4-7`; flip the provider and the pairing flips
with it. When Anthropic holds frontier and no OpenAI key exists, `counter` falls back to the
balanced model — still a different model id, which is the property the tier guarantees.
`challengerIsIndependent()` asserts that invariant at call time rather than assuming it, and every
review artifact prints which model reviewed which.

Two things are reviewed there, because nothing else covered them:

- **A strategy spec**, via `challengeStrategy` — whether `entry`/`exit` actually implement the
  stated `mechanism`, whether `successCriteria` were set to be easy, and whether `falsification`
  is a real observable or a vacuous sentence.
- **A final synthesised answer**, via `challengeSynthesis` in the News research pipeline —
  overclaims, numbers absent from the evidence, and caveats the evidence carried but the answer
  dropped. A non-`accurate` verdict is appended to the answer rather than hidden.

### The event spine (`market_events`)

`eventRoot` was already the de-facto domain key — the static calendar builds ids as `${root}-${date}`
and the News planner re-derives it with `startsWith("cpi-")` — but it lived inside a string, so
nothing could join on it. It is now a column, and News measurements, Lab findings
(`research_findings.event_roots`) and strategy rules all refer to the same roots.

**Actuals come from FRED/ALFRED, and only as first released.** `POST /api/events {"action":"seed"}`
writes the static calendar (schedule only); `{"action":"backfill","root":"cpi"}` pulls values with
`output_type=4` (initial release only) and stores `actual_initial` separately from `actual_revised`.
This is not a nicety. Backfilling payrolls over 2026 shows a print of **-899K that was later revised
to +160K** — a backtest reading the revised series would treat a release the market received as a
catastrophe as good news, with the sign of the surprise inverted.

**Series are transformed to the headline the market actually trades** before any surprise is
computed (`applyTransform`). CPIAUCSL is an index *level*, so comparing a print to its own trailing
mean measures the trend — the "surprise" then rises monotonically forever and carries no
information. CPI/PPI/PCE use the month-over-month percent, payrolls the month-over-month change,
and already-rate series (unemployment, fed funds) their level.

**Consensus has no free source.** Toss's OpenAPI spec serves session hours only, Yahoo exposes no
economic calendar endpoint, and TradingView is a widget; Trading Economics is paid. `consensus` is
therefore nullable for manual entry, and the default surprise is a deviation from a naive forecast
(trailing mean, else the previous print) computed from point-in-time history only. Every row records
its `surprise_basis`, and the API says plainly that a naive basis is a weaker signal than a true
economist surprise. Set `FRED_API_KEY` (free) to enable backfill at all.

### Calendar operands — the joint that makes News findings backtestable

Every other indicator is derived from price, so an event-driven rule could not be expressed at all.
`sessions_to_event`, `sessions_since_event`, `event_surprise` and `event_surprise_z` take an `event`
root and are evaluated in trading sessions, so a release on a holiday anchors to the next session
that traded. A release before 16:00 ET is readable at that day's close and a later one only at the
next — getting that wrong is exactly one bar of look-ahead, which is enough to manufacture an edge
from nothing. A calendar operand without an `event` root is rejected rather than defaulted, because
a rule that can never fire backtests as a flat line that passes some checks by vacuity.

`event_reaction` answers the question the News side was built for — "what did SPY do around the last
year of CPI prints, split by surprise" — in one call, on daily bars, with the unconditional return
over the same window as a baseline. `intraday_event_study` still covers the minute-level window but
only as far back as Yahoo's ~60-day supply.

### Paper ledger — closing the loop

`POST /api/strategies/signals {"id":"…","record":true}` writes each intent to `paper_fills`, moves
`paper_positions`, and marks the book in `paper_daily_pnl` on every call so an equity curve
accumulates even on days the rule did not trade. Fills are modelled pessimistically — a buy lifts
the ask, a sell hits the bid, and a missing quote still charges half the strategy's cost assumption
as spread — because the number worth having is where live execution *diverges* from the backtest.
Open positions feed back as held symbols and a fill is not recorded twice for the same signal date,
so polling the endpoint cannot inflate the record it exists to measure.

### Success criteria are floored, not author-supplied

`successCriteria` arrives from the same model that wrote the rule, so the author used to set its
own passing grade. Worse, the verdict counts failures against the number of checks that ran, and
`maxDrawdownPct` / `minWinRatePct` were only checked when supplied — so *omitting* a criterion
both removed a check and made the remaining failures less likely to reach `fail`. `applyCriteriaFloors`
(`lib/strategy.ts`) now clamps `minSharpe`, `minExcessCagrPct`, `minTrades` and `maxDrawdownPct` to
a system minimum that an author may tighten but never loosen, records every clamp in the spec
notes so the adjustment is visible, and keeps the check count stable regardless of what was
proposed. `minWinRatePct` stays optional on purpose: trend-following rules are expected to win
less than half their trades.

Set `LLM_FRONTIER_PROVIDER=openai` (plus `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-6-astra`,
`OPENAI_REASONING_EFFORT=xhigh`) to run the frontier tier on OpenAI GPT-6 Astra through the
Responses API — the Lab orchestrator tool loop uses the built-in `web_search` tool instead of
Anthropic's server tool. Balanced and fast tiers always stay on Anthropic, so `ANTHROPIC_API_KEY`
is still required (grounding, auditors, routing).

Prompt caching is on for every stable Anthropic system prompt and the Lab tool list, adaptive
thinking is enabled on 4.6+ models (`reasoning.effort` on GPT-6 Astra), and structured outputs (Zod)
replace hand-parsed JSON.

Every usage row records the *role* that made the call, so Settings → LLM API cost / Model
allocation shows each role's configured model next to its real call count and cost. A role
sitting at 0 calls means no code path reaches it — the balanced (Sonnet) roles are only wired
into the News routes, so a session that used the Lab alone will show `analyst`, `auditor` and
`planner` at zero, and `summarizer` has no call site at all.

### Massive intraday bars

Set `MASSIVE_API_KEY` to make Massive Custom Bars the preferred source for the Lab's 1-, 5-,
and 15-minute studies. Requests use split-adjusted full-US-market aggregates. The current Basic
plan exposes the latest two years only after end-of-day and allows five API calls per minute;
`MASSIVE_PLAN`, `MASSIVE_HISTORY_YEARS`, `MASSIVE_DATA_RECENCY`, and
`MASSIVE_CALLS_PER_MINUTE` make those entitlements explicit if the account is upgraded later.

Without Massive credentials, or when a bounded recent Massive request fails, the existing Yahoo
path remains available (about 59 days for 5-/15-minute bars and 7 days for 1-minute bars).
Event studies fetch only the small windows around supplied events. FVG and intraday-direction
runs cap their period according to symbol count so Basic pagination stays within its call budget.
Settings makes a live aggregate request instead of treating "a key exists" as proof that the
account can read the data.

### Lab JARVIS (`/api/lab/agent`)

A streaming (SSE) tool-use loop with 25 tools in `lib/lab-tools.ts`: symbol
resolution (Yahoo search + Korean aliases), price history with overlays, N-asset comparison with
correlation matrix, technical indicators (SMA/EMA/RSI/MACD/Bollinger), event studies, rule
backtests (SMA cross, momentum, RSI reversal, breakout, buy-and-hold), risk profiles (beta,
Sharpe, Sortino, VaR/CVaR), seasonality, largest moves with linked headlines, news search,
quotes, the economic calendar, saved News sentiment Tests, and TradingView charts. Every tool
result is a typed artifact (`lib/lab-types.ts`) rendered on the Research Canvas by
`app/lab-charts.tsx`. All math lives in `lib/quant.ts` and is unit tested.

Three of those tools exist because the rest cannot start research on their own — every other tool
needs a symbol the user already named:

- **`screen_universe`** is the only tool that *discovers* symbols. It ranks a named universe
  (`lib/universe.ts` — fixed, curated liquid samples, so a screen run today stays comparable to
  the same screen next month) by one metric with optional filters. Metrics and ranking live in
  `lib/screener.ts`; bars come from the D1 cache first, so only the first screen of a universe
  pays the upstream cost. A symbol whose history is too short is excluded *with a reason* rather
  than ranked on a fabricated value.
- **`conditional_stats`** pools the forward returns following a condition across a whole universe
  and compares them to the unconditional baseline of the same bars. Pooling is what makes a rare
  per-symbol pattern testable — 3 occurrences on one ticker prove nothing, 700 across 30 do. The
  reported t-statistic uses overlapping windows, so it is a screening signal, not a p-value.
- **`sweep_conditions`** runs the same condition across a threshold x horizon grid and hands the
  grid to the balanced-tier auditor that judges whether the effect survives its neighbours or is one
  lucky cell. `conditional_stats` gives a point; this gives the surface.
- **`audit_result`** sends a claim plus its evidence to a balanced-tier auditor in a *separate*
  context, whose only job is to break it — effective sample size under overlapping windows,
  confounders, counter-hypotheses, survivorship direction, data-snooping risk, and the one test
  that would settle it. A model reviewing its own conclusion in its own context agrees with
  itself, so the reviewer is deliberately a different model with a fresh context.
- **`save_finding` / `list_findings`** persist conclusions to the `research_findings` table
  (`lib/findings.ts` for the pure claim shape, `lib/findings-store.ts` for D1). A finding is
  shaped like a claim — what was concluded, on what evidence, and what would overturn it — and
  the notes relevant to a new question are injected into every Lab turn automatically, so
  research accumulates across conversations instead of dying with the thread.

The orchestrator delegates rather than doing everything itself. `sweep_conditions` and
`audit_result` both run on the balanced tier under the `auditor` role, and oversized tool payloads are
compressed by the fast tier (`summarizer`) instead of being cut mid-JSON — hard truncation used to
hand the orchestrator malformed JSON with a silently missing tail. Because all three are ordinary
Lab tools, the Anthropic and OpenAI orchestrator loops pick them up identically.

Before the orchestrator reasons, a fast-tier grounding pass extracts every asset the question
mentions and resolves it against live Yahoo Finance metadata (`lib/symbols.ts`), so listing
status, tickers and IPO dates come from the market, not from the model's training data. The
loop also carries Anthropic's server-side `web_search` tool for anything newer than the model.

Conversations are first-class (`conversations` table, `/api/conversations`): every page load
starts a fresh thread, earlier threads appear in History, and clicking one restores it in the
Lab or News view.

### Backtest (`/api/strategies/*`, `lib/strategy.ts`)

Strategies are top-down objects: `hypothesis { thesis, mechanism, prediction, falsification }`
→ universe → mechanical `entry`/`exit` conditions over indicators → `successCriteria`. JARVIS
proposes them in Lab (`propose_strategy`), asks before saving (`save_strategy`), and the
engine runs them on real daily bars with next-close execution, costs, equal-weight universes,
a 70/30 in/out-of-sample split, parameter perturbation, and a deterministic pass/fail verdict.
Passing strategies become "signal candidates"; `lib/trading.ts` computes live signals and sized
order intents from the same rule, and `/api/strategies/signals` exposes them behind a gateway.

### 투자 탭

The rail's 투자 item (dollar sign) is a container, not a feature. It holds two boards that both put
money to work, and it exists so that adding a third does not add a third rail icon:

- **전략** — the slot relay board, unchanged, described below.
- **급등주** — the same-day surge/crash board, described further down.

`app/invest-workspace.tsx` is the whole of it: a sub-tab row, the remembered selection, and the two
workspaces. Nothing about 전략 changed when it moved here.

### 전략 (`/api/trade-strategies/*`, `lib/trade-strategies.ts`)

The Backtest tab above is for rules JARVIS *proposes*; this tab is for rules that have already
been validated and are meant to place orders. The difference that matters is architectural:
a strategy here is **code**, not a database row, and its `plan()` function is the only place it
decides anything. The 60-session backtest replays that exact function over historical bars
(`lib/trade-strategy-engine.ts`), and the 매매 button feeds it today's bars and the ledger's real
positions. A rule cannot backtest as one thing and trade as another, because there is only one
implementation.

The engine adds what a broker does rather than what a rule decides: a plan made on one close
fills at the *next* close, and the protective stop each entry carries fills intrabar as a resting
order would. Every run writes a markdown record — stored in D1, downloadable as `.md` — so a
month-old run can still be compared against.

Order submission goes through `lib/toss-orders.ts`, which is a real client for the Toss account,
asset and order APIs — `/api/v1/accounts`, `/holdings`, `/buying-power`, `/sellable-quantity`,
`/commissions`, `/orders` — using the same client-credentials token as the price calls plus the
`X-Tossinvest-Account` header. The default order is `LIMIT` + `timeInForce: "CLS"`, a limit-on-close
order, because that is the fill the backtest models; `TOSS_ORDER_MODE=market` switches to a day
market order. `clientOrderId` carries the intent's UUID as Toss's idempotency key, so a re-submitted
plan returns the original order instead of doubling the position.

Two safety properties are worth stating explicitly. **The rule can only sell what it bought**: when
the gateway is Toss, positions are the intersection of the account's holdings, the strategy's
universe, and this strategy's own ledger entries — anything else in the account is listed as
untouched and never ordered. And submitting requires an explicit confirmation separate from the
button, so a stray or replayed request cannot become an order. `TOSS_TRADING_DISABLED=true` is a
kill switch that refuses every live order without unlinking the keys.

**Deployment caveat, and it is a real one.** Toss enforces an allowed-IP list per app (WTS >
설정 > Open API > 허용 IP 관리); a call from an unregistered address is refused with 403. A
developer machine is one stable address and is easy to register. A Cloudflare Worker is not — its
egress address comes from Cloudflare's shared ranges and can differ between requests — so the same
keys that work under `npm run dev` can fail on the deployed site. The 전략 tab diagnoses this
explicitly: when the account probe is refused it names the cause and prints the egress address it
was refused from. The durable fixes are to route Toss calls through a host with a static IP, or to
run order execution locally where the registered address lives, leaving the deployment read-only.

Note also that `.dev.vars` is gitignored, so `TOSS_CLIENT_ID` / `TOSS_CLIENT_SECRET` have to be set
as secrets in the deployment environment separately — the tab reports that case as its own cause
rather than as a generic failure.

Costs still come from `lib/broker-costs.ts`, but the tab reads the account's live
`commissionRate` and flags it when the rate's `endDate` has arrived — a promotional rate expiring
raises the breakeven win rate of every adopted rule.

`h2-3day-reversal` is the first rule in the registry: the three-session −6% plunge from
`docs/research/results-2026-09.md`, ranked by depth, capped at three names a day, held five
sessions with a −6% stop.

### 트레이딩 대시보드 (`/api/trading`, `/api/relay/backtest`, `lib/trading-engine.ts`)

The 전략 tab opens with two dashboards, **실전 투자** (Toss account, real orders) and **모의투자**
(Toss live quotes, simulated fills). Both start from a fixed $1,000 and run whatever slot rules are
registered in `lib/relay-strategies.ts` — none yet, so a started dashboard idles until one is
registered and picks it up on the next tick.

- **Same decision as the backtest, on the rule's own bar.** `decideSlot` (from `lib/relay-engine.ts`)
  asks the rule once per *completed* bar at the rule's `barMinutes` (1, 3 or 5; default 5) — built live
  from Toss 1-minute candles on the same hour-aligned grid the backtest rolls up — and the order goes
  out for the next bar. A signal whose fill bar has already passed (the runner was asleep) is recorded
  as missed, not chased; "late" is one bar of the rule's own size. A rule may also own a `window`
  instead of its slot's, allow `maxEntriesPerDay` sequential entries and a `maxHoldMinutes` time exit —
  the 급등주 rules use all three. Live orders are marketable `LIMIT`/`DAY` (quote ± `TRADING_LIMIT_BAND_PCT`, default 1%),
  accepted in pre-, regular and after-market; paper fills take the last price and pay the same
  per-symbol commission + spread the backtest charges.
- **정지** runs three steps and only finishes on confirmed fills: cancel unfilled buys → sell only
  the shares this dashboard bought → wait for those sells to fill. A refused sell (market closed) is
  retried once a minute and the dashboard stays `정지 중`.
- **Adherence** (`lib/trade-adherence.ts`) is shared by backtest and dashboards: entry price vs the
  modelled price, entry within one bar, no loss past the stop, flat within 2 minutes of slot end.
- **Ticks.** A Worker has no timer, so the open tab ticks every 15s and `npm run trader`
  (`scripts/trading-runner.mjs`) ticks with the tab closed. A D1 lease serialises ticks and every
  order carries a deterministic idempotency key, so both can run at once without doubling an order.
  Run the runner where the IP is registered with Toss (see the deployment caveat above).
- **백테스트** takes a date range, streams progress while `lib/relay-data.ts` fetches Massive bars at
  each rule's resolution (5-minute aggregates, or 1-minute aggregates rolled up for 1m/3m rules) a month
  per call (cached per session in D1), and shows per-strategy P&L, adherence, daily
  returns, intraday-inclusive MDD, and a PDF export (`generateRelayPdf`, NanumGothic under OFL).

### 급등주 (`/api/invest/surge/*`, `lib/surge-*.ts`)

The second board under 투자. It tests the owner's hypothesis — *stocks surging or crashing TODAY
move alike for the rest of TODAY* — and turns what holds up into a rule with a frozen reward:risk.
There is no previous-day ranking and no next-day holding anywhere in it: the previous close is only
the reference a move is measured from. The agent shape is the 전략 generator's: GPT-6 Astra plans and
designs, Claude Opus 5 reviews, and no model ever computes a metric.

**Nothing is asked after the button.** The window is fixed in `SURGE_WINDOW` (6 months), the split
is fixed in `SURGE_POLICY` (60/20/20), and the backtest is a stage rather than a separate screen, so
one click runs design → freeze → validation → holdout → 2× cost → one-bar entry delay →
independent review end to end.

**No model runs at trading time.** Every paid call lives inside the generation stages. What ships is
a frozen spec the deterministic engine executes against the day's events, so a rule that trades every
session costs exactly what it cost to create.

#### What an event is (`lib/surge-observation.ts`)

An event is the **first completed regular-session one-minute bar** whose close is ≥ +10% (gainers)
or ≤ −10% (losers) from the previous regular close, priced $1–$500, with ≥ $1M of regular-session
dollar volume through that minute. `observedAt` is that minute's close; nothing about the event exists
before it, and it stays an event after a pullback. The backtest replays Massive's minutes through
`observeSurgeDay`; the live observer replays Toss's minutes through the same function — on
2026-09-28's KOD, KNRX and SNDQ both paths found the identical minute, move and price (Toss's tape is
lower than Massive's consolidated volume, so the $1M bar is never met earlier live than in research).

#### What the two data sources can and cannot do

This shaped the entire design, so it is worth stating plainly.

**Toss `GET /api/v1/rankings`** (verified against a live token, 2026-09-22) offers
`MARKET_TRADING_AMOUNT`, `MARKET_TRADING_VOLUME`, `TOP_GAINERS`, `TOP_LOSERS`,
`TOSS_SECURITIES_TRADING_AMOUNT`, `TOSS_SECURITIES_TRADING_VOLUME`, for `US` or `KR`, over
`realtime`/`1d`/`1w`/`1mo`/`3mo`/`6mo`/`1y`, up to 100 rows. `TOP_GAINERS`/`TOP_LOSERS` reject
`realtime` with 400 `unsupported-ranking-duration`, so `1d` is the fastest surge list available.
The live board reads **all six**, one at a time — the RANKING rate-limit group refuses six at once —
because a gainer list alone cannot say whether a move had participation behind it.

Every row is filtered to US listings **in code** (`isUsListing`) before it renders, on top of
`marketCountry=US`: a KRX code is six digits or five digits and a letter (`005930`, `0200G0`), and a
row not quoted in USD is not ours. The board is what a rule's universe is read from, so this is not
left to the parameter alone.

The limitation that matters: **there is no as-of parameter.** The response carries a `rankedAt`
timestamp and nothing else; the endpoint cannot be asked what the top gainers were last March. It is
a live screen, not a history — which is exactly what the live observer needs: during the regular
session `TOP_GAINERS`/`TOP_LOSERS` at `1d` are today's move from the previous close, and
`lib/surge-intraday-live.ts` treats each listed name as a candidate whose Toss minutes must meet the
event definition. Two quirks: `tradingAmount` on US names is converted to KRW, and before the open
`duration=1d` is decided by a few hundred premarket shares, so nothing is observed outside 09:30–16:00
ET. Massive's all-market snapshot would be the natural feed, but the configured end-of-day plan answers
`NOT_AUTHORIZED` (measured 2026-09-29). Issuing a Toss token revokes the previous one, so every Toss
caller re-issues once on a 401.

**Massive** supplies the history, through three endpoints and nothing else:

| call | how often | why |
| --- | --- | --- |
| `/v3/reference/splits` | 2–3 per research window | Prices are raw, so a 1:10 reverse split would read as +900%. Names whose split executed that day are dropped for that day. |
| `/v2/aggs/grouped/locale/us/market/stocks/{date}` | **once per trading day** | One call returns every US ticker's OHLCV (~12,600 rows). A name can only have an event if its day high (or low) reached the move, its high reached $1 and high × volume reached $1M — `observationUniverse` keeps exactly those. This is a download envelope, never a signal. |
| `/v2/aggs/ticker/{symbol}/range/1/minute/…` | **once per symbol-month** | Only envelope names, only months they could have an event in. Typically ~100 gainer and ~80–160 loser candidates a day. |

Entitlement is exactly two years, rolling (2024-09-23 answers today; 2024-09-18 is a 403) and the
limit is five calls a minute, which is the entire reason the first run takes many hours (thousands of
symbol-months) — the progress
line's "대기" is the loader waiting its turn on the shared pacer. Both caches are account-wide.

**Prices are unadjusted, and that was a bug worth naming.** Split-adjusted history is computed
backwards from today: SPRC closed at $4.47 on 2025-09-17 and Massive's adjusted series reports
$40.23, because of a 9:1 reverse split executed on 2026-03-04. Two things broke at once — the number
on screen was not a price anyone could trade, and the tradability filters ($1 floor, $500 ceiling,
whole-share affordability on $1,000) were being applied to a price that did not exist yet, which is
future information deciding the past. Everything now reads `adjusted=false`, `surge_market_days` and
`surge_rank_days` carry a `basis` column, and rows written before the fix are ignored on read and
re-downloaded rather than silently mixed in.

**One download, three resolutions.** Massive charges a request, not a bar, and serves one-minute
aggregates over the same two years at the same cost as five-minute. So the loader fetches minutes
once and rolls them up (`lib/bar-rollup.ts`) into 1m/3m/5m, cached under their own `-raw` interval
keys so they can never be confused with the relay board's adjusted bars. A rule picks the resolution
its thesis needs — a surge that resolves in eight minutes is invisible on a five-minute chart — and
finer resolution costs no extra calls.

#### The rule is timed from its event

A rule decides on completed bars of its own `barInterval` (1m/3m/5m) whose close falls inside
`entryFrom`–`entryTo` ET **and** between `minMinutesSinceEvent` and `maxMinutesSinceEvent` after the
event — "fifteen minutes after it first crossed +10%" is the same moment in the thesis whether the
cross came at 09:41 or 13:12. It fills at the next bar's open, exits at the stop, the target
(`stopPct × rewardRisk`), after `maxHoldMinutes`, or at 15:55 ET, and may take up to
`maxTradesPerDay` sequential trades, one position at a time, never the same name twice; the search
resumes after each exit. Session features (`sessionVwapDistancePct`, `sessionHighDistancePct`,
`fromEventPricePct`, `minutesSinceEvent`, …) read the regular session so far.

The live engine runs the rule unchanged: `lib/surge-slot-strategies.ts` hands it the whole regular
session as its `window`, its own bar size, `maxEntriesPerDay` and `maxHoldMinutes`, and a universe of
today's events it could still enter, rebuilt every tick. Only one rule per side trades (the newest).

Memory is the constraint in research: a busy day has dozens of events. Each event keeps only the bars
a rule can reach (`surgeReach`: 25 bars before the event through its last possible exit), and the
trimmed head is carried as running totals (`SessionPrefix`), which is all the session features need —
a test checks trimmed + prefix equals the whole session. The designer's survey loads the training
block only.

#### Why the ranking-based design was replaced

The first version ranked the previous session's closes and traded the next session, because a
market-wide intraday *ranking* cannot be rebuilt without every ticker's minutes. But the hypothesis
never needed a ranking — only a threshold event — and a threshold event can be rebuilt exactly from
the envelope names' minutes. Older prior-day or slot-bound runs stay readable in their reports and are
never resumed or traded.

#### The gates (`lib/surge-validation.ts`)

Every trade is reported as a multiple of the money its stop put at risk, and expectancy in R — not
percentage return — is what the gates read. A rule with a 63% win rate and a 0.9:1 payoff is a
losing rule and only the R column says so. `surgeEvidenceProblems` refuses anything whose mean R is
not at least `minExpectancyR` on training, validation, holdout *and* the holdout replayed at twice
the modelled cost; anything whose one-bar-delayed replay is not positive; and anything whose
autocorrelation-corrected 95% lower bound on holdout mean R is ≤ 0 — "profitable on the sample" and
"edge established" are different claims.

Cost is the other half. `lib/surge-costs.ts` prices these names from the two facts a daily bar
gives: one cent of tick is 0.5% of a dollar stock, and depth scales with the square root of dollar
volume. It is a **modelled assumption, not a quote** — OHLCV contains no bid, no ask, no queue — so
it is deliberately pessimistic and everything is replayed at 2× before it can register.

#### Cost of a run

The first generation downloads ~130 grouped-daily sessions plus one-minute bars for every envelope
name's symbol-month — thousands of calls at five a minute, so many hours; the stage reports the exact
count when it starts. It is chunked one call per request, resumable, and survives a page reload or a
runner restart (`npm run trader -- --generation-only` advances it headless). Both caches are
account-wide, so a second strategy over the same months starts at the design stage.

#### Two books, four dashboards

`투자 › 급등주` has its own 실전 투자 / 모의투자, and they are the same component and the same tested
engine as the 전략 board's — with a `book` dimension threaded through `lib/trading-runner.ts`.
`relay` runs the slot rules from 전략; `surge` runs surge rules against today's observed events. Separate D1
state rows (`surge-live`, `surge-paper`), separate capital, separate strategy lists: a click on one
board cannot place an order the other board's evidence describes.

The surge book deliberately does **not** get every control the 전략 board has. There is no backtest
button on it — its evidence is produced once, inside generation, over a window the user never picks —
because offering a second ad-hoc backtest there would invite exactly the question the split exists to
prevent: whose strategy produced that number.

### News JARVIS (`/api/news/*`)

`plan` turns a request into a validated execution plan, `analyze` scores a headline corpus with a
structured schema and attaches deterministic SPY/QQQ/NASDAQ/NYSE outcomes, and `agent` runs the
specialist chain (pattern analyst + auditor in parallel → strategist → synthesizer) over saved
Test rows, streaming specialist status to the UI. The **Sentiment vs Market** panel in the News
view shows, per Test, the sentiment score against the realized index return with correlation,
direction hit-rate, and post-bullish/bearish averages.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes
- `npm run trader`: keep the 전략 dashboards ticking with no browser open (`--url`, `--interval`)

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)

### 전략 탭에서 새 전략 생성

전략 탭에서 슬롯을 고르고 **새 전략 생성**을 누르면 GPT‑6 Astra 총괄/설계, Claude Opus 5 독립 검증, 1분봉으로부터 전략이 선택한 1·3·5분봉을 집계한 리플레이를 거쳐 승인된 규칙이 슬롯에 저장됩니다. 데이터 정리는 GPT‑5.6 Luna, 결과 요약은 Claude Haiku 4.5가 맡습니다. 두 회사의 지정 모델 접근이 필요하며 같은 회사 검증으로 대체하지 않습니다. 생성 단계에서는 주문하지 않습니다.

진행·비용·검증 결과는 DB에 보존되고, 모의/실전/백테스트가 같은 승인 레지스트리를 사용합니다. 시작한 대시보드의 전략 목록은 실행 종료까지 고정됩니다. 탭을 닫고도 진행하려면 `npm run trader`를 켜 두세요. 생성 호출은 매매 감시와 별도 루프에서 실행됩니다.

운용 예산 $1,000과 토스 실제 USD 주문 가능 금액은 별개입니다. 잔고를 읽지 못한 경우 대체 금액으로 주문하지 않습니다. 모델 배치 근거, 검증 조건, 지원 범위와 운영 방법은 [전략 생성 문서](docs/strategy-generation/README.md)를 참고하세요.


전략의 `barInterval`은 설계 후 동결되며 학습·미사용 검증·실전·모의 실행에서 동일하게 적용됩니다. 진입 지연 스트레스도 해당 전략의 한 봉입니다. 기존에 5분봉으로 검증된 규칙은 그대로 5분봉을 쓰며, 다른 주기로 쓰려면 새 연구에서 검증합니다. 새 일반 전략 연구는 1분봉을 저장하고 3·5분봉은 누락 없는 분봉 묶음만 집계합니다.

급등락 연구의 가설은 **당일 급등락 종목들이 관측 이후 같은 날 유사한 경로를 보이는가**입니다. 전일 종가는 당일 등락률의 기준값입니다. 사건 최초 관측 시각을 0분, 관측가를 100으로 맞춰 분석하며, 첫 15분 움직임으로 분류한 집단의 이후 당일 수익률·분포·표본 수도 비교합니다. 해당 시각의 완성 봉이 없으면 결측이고 다음 거래일 가격으로 채우지 않습니다. 첫 15분 분류를 쓰는 전략은 그 15분이 지난 뒤에만 판단할 수 있습니다. 모델에 주는 경로 통계는 학습 구간의 1분봉으로 산출하고, 실제 거래는 각 후보가 선택한 봉과 비용으로 별도 검증합니다.
