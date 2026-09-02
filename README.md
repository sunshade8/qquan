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
| balanced | `ANTHROPIC_MODEL_BALANCED` | `claude-sonnet-5` | headline sentiment analyst, pattern analyst, similarity auditor, request planner |
| fast | `ANTHROPIC_MODEL_FAST` | `claude-haiku-4-5` | routing, summarisation |

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
  grid to a balanced-tier analyst that judges whether the effect survives its neighbours or is one
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
`audit_result` run on the balanced tier (`analyst` / `auditor`), and oversized tool payloads are
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
order intents from the same rule, and `/api/strategies/signals` exposes them behind a gateway
(dry run today; `tossGateway` is the hook for the Toss order API).

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
