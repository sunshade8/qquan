import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import {
  CT_POLICY,
  CT_POLICY_V6,
  ctPolicyForNewContract,
  ctSessionPolicy,
  ctHash,
} from "../lib/ct-spec.ts";
import {
  CT_DESIGNER_SYSTEM,
  CT_DESIGNER_SYSTEM_BOOK,
  ctDesignerSystem,
} from "../lib/ct-research.ts";
import {
  ctBookStep,
  assertCTBookRegistration,
} from "../lib/ct-book.ts";
import {
  ctPairedVerdict,
  ctDailyMetrics,
  ctHolm,
} from "../lib/ct-experiment-stats.ts";
import { ctAllowedMemory } from "../lib/ct-scoped-memory.ts";
import {
  ctNativePnl,
  ctFunding,
  ctRequiredMargin,
  ctBorrowStep,
  ctRiskQuantity,
  ctOptionSettlement,
} from "../lib/ct-accounting.ts";
import { ctInstrumentSchema } from "../lib/ct-capabilities.ts";
import { fitAdditive } from "../lib/ct-additive.ts";
import {
  ctBaselinePolicy,
  CT_BASELINE_VERSIONS,
  ctEmptySetup,
  ctPlaybookStep,
} from "../lib/ct-decision-playbooks.ts";
import {
  plantedMarket,
  plantedContract,
} from "./helpers/ct-trader-fixture.mjs";
import { ctState, bars } from "./helpers/ct-fixture.mjs";
register("./helpers/slot-test-loader.mjs", import.meta.url);
const sqlite = new DatabaseSync(":memory:");
class Statement {
  constructor(sql, values = []) {
    this.sql = sql;
    this.values = values;
  }
  bind(...values) {
    return new Statement(this.sql, values);
  }
  async run() {
    return {
      meta: {
        changes: Number(sqlite.prepare(this.sql).run(...this.values).changes),
      },
    };
  }
  async first() {
    return sqlite.prepare(this.sql).get(...this.values) ?? null;
  }
  async all() {
    return { results: sqlite.prepare(this.sql).all(...this.values) };
  }
  async raw() {
    return (await this.all()).results.map(Object.values);
  }
}
globalThis.__strategyTestEnv = {
  OPENAI_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  DB: {
    prepare: (s) => new Statement(s),
    batch: async (ss) => Promise.all(ss.map((s) => s.run())),
  },
};
globalThis.__strategyTestHooks = {
  call: () => {
    throw new Error("unexpected model call");
  },
};
const research = await import("../lib/ct-research-store.ts"),
  store = await import("../lib/strategy-generation-store.ts"),
  flow = await import("../lib/strategy-generation.ts");
const {
  binanceHmac,
  BinanceAPI,
  binanceQuantize,
  binanceDepthStep,
  binanceKline,
  binancePositionParams,
} = await import("../lib/binance-api.ts");
await research.ensureCTSchema();
test("policy 6 bytes remain frozen; default and explicit override 7 use separate book policy", () => {
  assert.equal(
    createHash("sha256").update(CT_DESIGNER_SYSTEM).digest("hex"),
    "cd6e93389a63b4b55e78356df329ec8ab50a002eada34445db93d745e142280d",
  );
  assert.equal(ctDesignerSystem({ policy: CT_POLICY_V6 }), CT_DESIGNER_SYSTEM);
  assert.equal(
    ctDesignerSystem({ policy: CT_POLICY }),
    CT_DESIGNER_SYSTEM_BOOK,
  );
  assert.equal(
    research.ctSessionTools({ policy: CT_POLICY_V6 }),
    research.CT_SESSION_TOOLS,
  );
  assert.equal(
    research.ctSessionTools({ policy: CT_POLICY }),
    research.CT_SESSION_TOOLS_BOOK,
  );
  const old = process.env.QQUAN_CT_POLICY_VERSION;
  try {
    process.env.QQUAN_CT_POLICY_VERSION = "6";
    assert.equal(ctPolicyForNewContract(), CT_POLICY_V6);
    assert.equal(
      ctSessionPolicy({ policy: ctPolicyForNewContract() }).book,
      false,
    );
    delete process.env.QQUAN_CT_POLICY_VERSION;
    assert.equal(ctPolicyForNewContract(), CT_POLICY);
  } finally {
    if (old === undefined) delete process.env.QQUAN_CT_POLICY_VERSION;
    else process.env.QQUAN_CT_POLICY_VERSION = old;
  }
});
test("book activations expire on common clock, repeats do not extend, day boundary resets, confluence release exits", () => {
  const zero = { active: {}, day: "", target: false };
  let s = ctBookStep(
    zero,
    {
      at: 100,
      day: "d",
      signals: [
        { id: "a", expiresAt: 200 },
        { id: "b", expiresAt: 300 },
      ],
    },
    { kind: "vote", k: 2 },
  );
  assert.equal(s.intent, "enter");
  assert.equal(s.score, 2);
  s = ctBookStep(
    s.state,
    { at: 150, day: "d", signals: [{ id: "a", expiresAt: 400 }] },
    { kind: "vote", k: 2 },
  );
  assert.equal(s.state.active.a, 200);
  assert.equal(s.intent, "hold");
  s = ctBookStep(
    s.state,
    { at: 200, day: "d", signals: [] },
    { kind: "confluence", pair: ["a", "b"] },
  );
  assert.equal(s.intent, "exit");
  s = ctBookStep(
    s.state,
    { at: 201, day: "e", signals: [] },
    { kind: "vote", k: 1 },
  );
  assert.equal(s.score, 0);
  assert.throws(() =>
    assertCTBookRegistration({
      componentIds: ["a"],
      reasons: [],
      development: {},
    }),
  );
});
const instrument = (product = "usdm") => ({
  venue: "binance",
  network: "mainnet",
  product,
  instrumentId: product === "coinm" ? "BTCUSD_PERP" : "BTCUSDT",
  base: "BTC",
  quote: product === "coinm" ? "USD" : "USDT",
  settlement: product === "coinm" ? "BTC" : "USDT",
  collateral: product === "coinm" ? "BTC" : "USDT",
  direction: "long",
  leverage: 10,
  marginMode: "isolated",
  positionMode: "one-way",
  contractSize: product === "coinm" ? 100 : 1,
  expiry: null,
  collateralMode: "single",
});
test("linear/inverse PnL are native, leverage changes collateral but not stop-risk quantity when collateral ample", () => {
  const i = instrument();
  assert.equal(ctNativePnl(i, 2, 100, 110), 20);
  assert.equal(ctNativePnl({ ...i, direction: "short" }, 2, 100, 90), 20);
  assert.equal(ctRequiredMargin(i, 2, 100), 20);
  const input = {
    capital: 10000,
    riskPct: 1,
    entry: 100,
    stop: 99,
    freeCollateral: 10000,
    maxNotional: 100000,
    step: ".01",
  };
  assert.equal(ctRiskQuantity(i, input), 100);
  assert.equal(ctRiskQuantity({ ...i, leverage: 2 }, input), 100);
  assert.ok(
    Math.abs(
      ctNativePnl(instrument("coinm"), 10, 50000, 55000) -
        0.0018181818181818182,
    ) < 1e-14,
  );
  assert.equal(ctFunding(i, 2, 100, 0.001), -0.2);
  assert.equal(ctFunding({ ...i, direction: "short" }, 2, 100, 0.001), 0.2);
  assert.deepEqual(
    ctBorrowStep({ principal: 100, interest: 3 }, { kind: "repay", amount: 2 }),
    { principal: 100, interest: 1 },
  );
});
test("options premium, multiplier and CALL/PUT exercise stay distinct from underlying direction", () => {
  const o = {
    venue: "binance",
    network: "mainnet",
    product: "options",
    instrumentId: "BTC-TEST",
    base: "BTC",
    quote: "USDT",
    settlement: "USDT",
    collateral: "USDT",
    right: "PUT",
    strike: 100,
    expiry: 1000,
    multiplier: 2,
    contractSide: "buy",
    underlyingView: "down",
    marginMode: "premium",
    positionMode: "one-way",
  };
  assert.equal(ctOptionSettlement(o, 3, 4, 90, 1000), 36);
  assert.throws(() => ctOptionSettlement(o, 3, 4, 90, 999));
  assert.throws(() =>
    ctInstrumentSchema.parse({
      ...instrument(),
      product: "spot",
      direction: "short",
    }),
  );
});
test("paired daily null is exactly zero, known improvement/worsening, small sample and calendar mismatch are distinguished", () => {
  const a = Array.from({ length: 60 }, (_, i) => ({
      date: String(i),
      returnPct: i % 3 ? 0.01 : -0.01,
    })),
    b = a.map((d, i) => ({
      ...d,
      returnPct: d.returnPct + 0.2 + (i % 5) * 0.001,
    }));
  const opts = { safe: true, trades: 60, completed: true };
  assert.deepEqual(ctPairedVerdict(a, a, opts).ci, [0, 0]);
  assert.equal(ctPairedVerdict(a, b, opts).verdict, "개선 확인");
  assert.equal(ctPairedVerdict(b, a, opts).verdict, "악화 확인");
  assert.equal(
    ctPairedVerdict(a.slice(0, 1), b.slice(0, 1), opts).verdict,
    "판단 보류",
  );
  assert.equal(ctPairedVerdict(a, b.slice(1), opts).verdict, "비교 불가");
  assert.deepEqual(ctHolm([0.01, 0.03, 0.2]), [0.03, 0.06, 0.2]);
  assert.equal(
    ctDailyMetrics([{ date: "a", equity: 100, returnPct: 0 }]).sharpe,
    null,
  );
  assert.ok(
    Math.abs(
      ctDailyMetrics([{ date: "a", equity: 99, returnPct: -1 }])
        .maxDrawdownPct - 1,
    ) < 1e-10,
  );
});
test("wrong memory scope, unknown dimensions, future availability and evaluation conclusions are excluded entirely", () => {
  const scope = {
      venue: "binance",
      product: "spot",
      instrument: "BTCUSDT",
      direction: "long",
      decisionMinutes: 5,
      executionMinutes: 1,
      regime: "range-v1",
      setupVersion: "v1",
      riskProfile: "r1",
      costProfile: "c1",
    },
    m = {
      id: "m",
      owner: "o",
      scope,
      observedAt: 5,
      recordedAt: 6,
      availableAt: 7,
      from: 0,
      to: 4,
      split: "training",
      grade: "reproduced",
      conclusion: "99.9 future conclusion",
    };
  const query = { owner: "o", scope, at: 10, trainingTo: 9 };
  assert.equal(ctAllowedMemory([m], query).length, 1);
  for (const bad of [
    { ...m, split: "final" },
    { ...m, availableAt: 11 },
    { ...m, scope: { ...scope, instrument: "ETHUSDT" } },
    { ...m, scope: { ...scope, regime: "unknown" } },
  ])
    assert.equal(
      JSON.stringify(ctAllowedMemory([bad], query)).includes("99.9"),
      false,
    );
});
test("baseline decision history is identical when every future bar is contaminated", () => {
  const { bars } = plantedMarket({ days: 1 });
  const run = (bs) => {
    const p = ctBaselinePolicy("BTCUSDT", CT_BASELINE_VERSIONS[0], "r", "a");
    bs.forEach(p.observe);
    return p.decisions.filter((d) => d.observedThrough <= bars[600].endMs);
  };
  const bad = bars.map((b, i) =>
    i > 600 ? { ...b, close: 1e8, high: 1e8 } : b,
  );
  assert.ok(run(bars).length > 50);
  assert.deepEqual(run(bars), run(bad));
});
test("additive fit sees training rows only, future labels and features cannot change prior scores", () => {
  const cols = [Float32Array.from({ length: 100 }, (_, i) => i)],
    labels = Int8Array.from({ length: 100 }, (_, i) => (i > 25 ? 1 : 0)),
    rows = Array.from({ length: 50 }, (_, i) => i);
  for (const model of ["sign", "logistic"]) {
    const a = fitAdditive(cols, rows, labels, model);
    const bad = [Float32Array.from(cols[0], (x, i) => (i >= 50 ? 1e9 : x))],
      other = Int8Array.from(labels, (x, i) => (i >= 50 ? 1 - x : x)),
      b = fitAdditive(bad, rows, other, model);
    assert.equal(a(40), b(40));
  }
});
test("Binance HMAC against independent crypto implementation, decimal filters, microseconds and depth gaps", async () => {
  assert.equal(
    await binanceHmac("test-secret", "symbol=BTCUSDT"),
    createHash("sha256") &&
      (await (async () => {
        const { createHmac } = await import("node:crypto");
        return createHmac("sha256", "test-secret")
          .update("symbol=BTCUSDT")
          .digest("hex");
      })()),
  );
  assert.deepEqual(
    binanceQuantize(
      "1.239",
      "100.129",
      [
        { filterType: "LOT_SIZE", stepSize: ".01", minQty: ".01", maxQty: "2" },
        {
          filterType: "PRICE_FILTER",
          tickSize: ".1",
          minPrice: "1",
          maxPrice: "1000",
        },
      ],
      124,
    ),
    { quantity: "1.23", price: "100.1" },
  );
  assert.equal(
    binanceKline([1735689600000000, "1", "2", "1", "2", "3"], "us").endMs,
    1735689660000,
  );
  assert.equal(binanceDepthStep(10, { first: 12, last: 13 }).resync, true);
  assert.equal(binanceDepthStep(10, { first: 9, last: 10 }).accepted, false);
  assert.deepEqual(binancePositionParams("hedge", "SHORT", true, "MARKET"), {
    positionSide: "SHORT",
  });
});
test("all Binance mutations are blocked by default before any network call, reads preserve 429 backoff", async () => {
  delete process.env.BINANCE_TRADING_DISABLED;
  let count = 0;
  const api = new BinanceAPI("spot", "mainnet", async () => {
    count++;
    return Response.json(
      { code: -1003 },
      { status: 429, headers: { "retry-after": "2" } },
    );
  });
  for (const op of [
    "order",
    "cancel",
    "leverage",
    "marginType",
    "positionMode",
    "multiAsset",
    "borrowRepay",
    "algoOrder",
  ])
    await assert.rejects(api.mutate(op, {}), /잠금/);
  assert.equal(count, 0);
  await assert.rejects(api.read("time"));
  await assert.rejects(api.read("time"));
  assert.equal(count, 1);
});
test("policy 7 first empty session reflects; second requires two NEW signatures, final notice permits honest termination", async () => {
  sqlite.exec("UPDATE strategy_generation_runs SET status='cancelled'");
  const ct = ctState();
  ct.contract.policy = CT_POLICY;
  ct.contract.policy = { ...CT_POLICY, lessonReserveUsd: 0 };
  ct.dataHash = await ctHash({ "KRW-BTC": bars(864) });
  const j = {
    id: "book-empty-fixture",
    ownerId: "owner",
    slot: "open",
    status: "running",
    stageIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    from: "2025-01-01",
    to: "2025-01-04",
    capitalUsd: 1000,
    budgetUsd: 8,
    costUsd: 0,
    brief: "",
    events: [],
    calls: [],
    universe: ["KRW-BTC"],
    ct,
  };
  await store.createGenerationJob(j);
  sqlite
    .prepare("INSERT INTO ct_data_pages VALUES (?,?,?,?)")
    .run(j.id, "KRW-BTC", ct.contract.toMs, JSON.stringify(bars(864)));
  globalThis.__strategyTestHooks.turn = () => ({
    content: [
      {
        type: "tool_use",
        id: "empty",
        name: "submit_candidates",
        input: {
          candidates: [],
          components: [],
          noEdgeReason: "부품 게이트에도 표본과 기준선 우위가 부족합니다",
          rejectedHypotheses: [],
        },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 100 },
  });
  for (let i = 0; i < 3; i++) await flow.advanceGeneration(j.id);
  let saved = await store.getGenerationJob(j.id);
  assert.equal(saved.ct.phase, "reflect");
  assert.equal(saved.ct.emptySessions, 1);
  assert.equal(saved.ct.finalConsumed, undefined);
  await flow.advanceGeneration(j.id);
  await flow.advanceGeneration(j.id);
  await flow.advanceGeneration(j.id);
  saved = await store.getGenerationJob(j.id);
  assert.equal(saved.ct.phase, "reflect");
  assert.equal(saved.ct.sessions.at(-1).status, "open");
  assert.match(
    JSON.stringify(
      sqlite
        .prepare(
          "SELECT payload FROM ct_session_messages WHERE run_id=? ORDER BY session,seq",
        )
        .all(j.id),
    ),
    /새 가설 서명 2개/,
  );
});

test("expired setups emit cancellation once then rearm; historical warmup cannot leave the day stuck", () => {
  const b = {
      startMs: 0,
      endMs: 300000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
    },
    old = {
      ...ctEmptySetup(),
      phase: "impulse",
      started: 1,
      expires: 10,
      boundary: 90,
    };
  const first = ctPlaybookStep(old, [b, b], CT_BASELINE_VERSIONS[0]);
  assert.equal(first.state.phase, "expired");
  const next = ctPlaybookStep(first.state, [b, b], CT_BASELINE_VERSIONS[0]);
  assert.equal(next.state.phase, "idle");
  assert.equal(next.action, "NO_TRADE");
});

test("product reducer waits for the next open, protects the entry bar and never double-counts a funding event", async () => {
  const { ctDecisionStep, ctProductInitial } = await import(
    "../lib/ct-product-engine.ts"
  );
  const i = instrument();
  const bar = (id, start, low = 99) => ({
    id,
    at: start + 60000,
    kind: "bar",
    instrument: i,
    bar: {
      startMs: start,
      endMs: start + 60000,
      open: 100,
      high: 101,
      low,
      close: 100,
      volume: 100,
    },
    mark: {
      startMs: start,
      endMs: start + 60000,
      open: 100,
      high: 101,
      low,
      close: 100,
      volume: 100,
    },
    reportFx: 1,
    maintenanceRate: 0.005,
  });
  let s = ctProductInitial("o", 10000);
  s.maxGross = 10000;
  const intent = {
    id: "p",
    owner: "o",
    instrument: i,
    kind: "enter",
    stop: 95,
    target: 110,
    expiresAt: 600000,
    riskPct: 1,
    maxNotional: 2000,
    step: ".01",
  };
  let step = ctDecisionStep(s, bar("b0", 0), intent);
  assert.equal(step.state.positions.length, 0);
  assert.equal(step.effects.length, 0);
  step = ctDecisionStep(step.state, bar("b1", 60000));
  assert.equal(step.state.positions.length, 1);
  assert.equal(step.state.positions[0].openedAt, 60000);
  const f = {
    id: "funding",
    at: 180000,
    kind: "funding",
    instrument: i,
    rate: 0.001,
    mark: 100,
    reportFx: 1,
  };
  const funded = ctDecisionStep(step.state, f);
  assert.equal(funded.state.positions[0].funding, -2);
  assert.equal(ctDecisionStep(funded.state, f).state.cash, funded.state.cash);
  const stopped = ctDecisionStep(funded.state, bar("b3", 180000, 94));
  assert.equal(stopped.state.positions.length, 0);
  assert.equal(stopped.effects[0].reason, "stop");
});
test("product shadow cannot emit broker effects; missing mark risk blocks derivatives and stock spot cannot short", async () => {
  const { ctDecisionStep, ctProductInitial } = await import(
    "../lib/ct-product-engine.ts"
  );
  const i = instrument(),
    s = ctProductInitial("o", 10000, "shadow");
  const event = {
    id: "missing",
    kind: "bar",
    at: 60000,
    instrument: i,
    bar: {
      startMs: 0,
      endMs: 60000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 10,
    },
    reportFx: 1,
    maintenanceRate: null,
  };
  const r = ctDecisionStep(s, event);
  assert.equal(
    r.effects.some((e) => e.kind === "order_intent"),
    false,
  );
  assert.match(r.effects[0].reason, /mark/);
});

test('isolated synthetic DB follows component training -> frozen book -> development -> risk review without development ranking',async()=>{
 const {ctMeasureComponent}=await import('../lib/ct-components.ts');
 const DAY=86400000,start=Date.UTC(2025,0,15),raw=[];
 for(let day=0;day<100;day++)for(let m=0;m<1440;m++){
  const price=(x)=>x<61?100:x===61?101:x===62?102:102-2*Math.min(1,(x-62)/1300);
  const open=price(m-1),close=price(m);raw.push({startMs:start+day*DAY+m*60000,endMs:start+day*DAY+(m+1)*60000,open,close,high:Math.max(open,close)+.001,low:Math.min(open,close)-.001,volume:m===60?1e6:1e5});
 }
 const c={...plantedContract({days:100,trainingDays:60,start}),developmentToMs:start+80*DAY,policy:CT_POLICY};
 const base=(feature,value)=>({version:1,engine:c.engine,name:feature,market:'crypto',symbols:['BTCUSDT'],minutes:1,stages:[{label:'synthetic signal',maxGapBars:1,conditions:[{feature,lookback:2,offset:0,timeframe:1,op:'gte',value}]}],entry:{order:'marketable_limit',validBars:1,maxSpreadPct:1,maxDeviationPct:2},exit:{stopPct:.6,targetPct:1.2,maxHoldBars:6,invalidation:'stop'},sizing:{riskPct:.5,allocationPct:25,maxPositions:1,cooldownBars:8,participationPct:1},sourceIds:['verified'],assumptions:['Synthetic fixture, not evidence of market edge.']});
 const components=[base('volume_ratio',3),base('return_pct',.5)].map((spec,i)=>({id:'synthetic-'+i,hash:'synthetic-'+i,session:0,grade:'pending',whyNotAlone:'Synthetic component, not real research.',candidate:{spec,hypothesis:{phenomenon:'Synthetic planted effect for integration testing only',mechanism:'Synthetic event fixture has no market evidence',falsification:'Does not imply any real market edge',failureRegimes:['real data']},mapping:[],parentId:null,observedProblem:'',changes:[],expectedEffect:'',memoryIds:[]}}));
 for(const r of components){const m=ctMeasureComponent(r.candidate.spec,{BTCUSDT:raw},c,c.fromMs,c.trainingToMs);assert.deepEqual(m.reasons,[],JSON.stringify(m));}
 sqlite.exec("UPDATE strategy_generation_runs SET status='cancelled'");const ct={...ctState(),phase:'book',contract:c,dataHash:await ctHash({BTCUSDT:raw}),components};const job={id:'book-synthetic-path',ownerId:'fixture-only',slot:'open',status:'running',stageIndex:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),from:'2025-01-01',to:'2025-04-11',capitalUsd:1000,budgetUsd:8,costUsd:0,brief:'SYNTHETIC FIXTURE — never real performance',events:[],calls:[],universe:['BTCUSDT'],ct};
 await store.createGenerationJob(job);sqlite.prepare('INSERT INTO ct_data_pages VALUES (?,?,?,?)').run(job.id,'BTCUSDT',c.toMs,JSON.stringify(raw));await flow.advanceGeneration(job.id);const saved=await store.getGenerationJob(job.id);
 assert.equal(saved.ct.phase,'risk_review',saved.error??JSON.stringify(saved.ct.books.map(b=>b.reasons)));assert.equal(saved.ct.components.every(r=>r.grade==='component_passed'),true);assert.equal(saved.ct.books.length,3);assert.equal(saved.ct.trials.length,3);assert.ok(saved.ct.trainingPriority.includes(saved.ct.selectedId));assert.equal(saved.ct.finalConsumed,undefined);
 const hash=saved.ct.frozenHash,rank=saved.ct.trainingPriority.slice();saved.ct.trials.reverse().forEach((t,i)=>t.development.meanDailyReturnPct=9999-i);assert.deepEqual(saved.ct.trainingPriority,rank);assert.equal(saved.ct.frozenHash,hash);
});

// Regression: a component whose hold window reaches the day boundary used to measure zero events
// (paid runs fb71c559 and c58b159a stored undercounted training events before the fix).
test("component hold windows that reach the day boundary still count, exiting on the last full bar", async () => {
  const { ctMeasureComponent } = await import("../lib/ct-components.ts");
  const DAY = 86400000, start = Date.UTC(2025, 0, 15), raw = [];
  for (let day = 0; day < 40; day++)
    for (let m = 0; m < 1440; m++) {
      const open = 100 + (m % 7) * 0.01, close = 100 + ((m + 1) % 7) * 0.01;
      raw.push({ startMs: start + day * DAY + m * 60000, endMs: start + day * DAY + (m + 1) * 60000, open, close, high: Math.max(open, close) + 0.001, low: Math.min(open, close) - 0.001, volume: m === 600 ? 1e8 : 1e5 });
    }
  const c = { ...plantedContract({ days: 40, trainingDays: 30, start }), policy: CT_POLICY };
  const spec = { version: 1, engine: c.engine, name: "day-end hold", market: "crypto", symbols: ["BTCUSDT"], minutes: 15, stages: [{ label: "volume spike", maxGapBars: 1, conditions: [{ feature: "volume_ratio", lookback: 2, offset: 0, timeframe: 1, op: "gte", value: 3 }] }], entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2 }, exit: { stopPct: 5, targetPct: 10, maxHoldBars: 200, invalidation: "stop" }, sizing: { riskPct: 0.5, allocationPct: 25, maxPositions: 1, cooldownBars: 8, participationPct: 1 }, sourceIds: ["verified"], assumptions: ["Synthetic fixture, not evidence of market edge."] };
  const m = ctMeasureComponent(spec, { BTCUSDT: raw }, c, c.fromMs, c.trainingToMs);
  // One spike per training day; a 200-bar hold always runs into the UTC boundary.
  assert.ok(m.events >= 25, JSON.stringify({ events: m.events, days: m.days }));
});
