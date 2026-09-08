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
run GPT-5.5 and the `challenger` runs `claude-opus-4-7`; flip the provider and the pairing flips
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

Set `LLM_FRONTIER_PROVIDER=openai` (plus `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-5.5`,
`OPENAI_REASONING_EFFORT=xhigh`) to run the frontier tier on OpenAI GPT-5.5 Thinking through the
Responses API — the Lab orchestrator tool loop uses the built-in `web_search` tool instead of
Anthropic's server tool. Balanced and fast tiers always stay on Anthropic, so `ANTHROPIC_API_KEY`
is still required (grounding, auditors, routing).

Prompt caching is on for every stable Anthropic system prompt and the Lab tool list, adaptive
thinking is enabled on 4.6+ models (`reasoning.effort` on GPT-5.5), and structured outputs (Zod)
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

Costs still come from `lib/broker-costs.ts`, but the tab reads the account's live
`commissionRate` and flags it when the rate's `endDate` has arrived — a promotional rate expiring
raises the breakeven win rate of every adopted rule.

`h2-3day-reversal` is the first rule in the registry: the three-session −6% plunge from
`docs/research/results-2026-09.md`, ranked by depth, capped at three names a day, held five
sessions with a −6% stop.

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

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
