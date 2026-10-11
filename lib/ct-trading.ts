import { feePerSidePct } from "./broker-costs.ts";
import type {
  DashboardMode,
  DashboardState,
  TradingDashboardView,
} from "./dashboard-types.ts";
import {
  BrokerRejection,
  dashboardSummary,
  heldQuantity,
  isActiveOrder,
  type DashboardBroker,
} from "./trading-engine.ts";
import { ctRecentBars } from "./ct-data.ts";
import { type CTPackage } from "./ct-research-store.ts";
import { ctDb } from "./ct-data.ts";
import { ctHash, executableCT, ctRuleText, type CTMarket } from "./ct-spec.ts";
import { tickCTDashboard } from "./ct-trading-engine.ts";
import { accountHasUncertainOrders } from "./trading-account-lock.ts";
import {
  decimalFloor,
  upbitAccounts,
  upbitCancel,
  upbitChance,
  upbitConfigured,
  upbitOpenOrders,
  upbitOrder,
  upbitQuote,
  upbitSetting,
  upbitSubmit,
  UpbitError,
} from "./upbit.ts";
import Decimal from "decimal.js";
import { tossListOrders, tossPrimaryAccount } from "./toss-orders.ts";
import { fetchTossQuote, fetchTossTradingDay } from "./market-data.ts";
import { easternParts } from "./market-clock.ts";
export type CTBook = "ct-stock" | "ct-crypto";
export const ctMarketOf = (book: CTBook): CTMarket =>
  book === "ct-stock" ? "stock" : "crypto";
const cryptoBroker = (): DashboardBroker & {
  recover: (
    order: Parameters<DashboardBroker["poll"]>[0],
  ) => Promise<string | null>;
} => ({
  mode: "live",
  quote: upbitQuote,
  async submit(r) {
    try {
      const order = await upbitSubmit({
        symbol: r.symbol,
        side: r.side,
        quantity: decimalFloor(r.quantity, 8),
        price: String(r.limitPrice ?? r.referencePrice),
        identifier: r.clientOrderId,
      });
      return { brokerOrderId: order.uuid };
    } catch (e) {
      if (
        e instanceof UpbitError &&
        e.status >= 400 &&
        e.status < 500 &&
        ![408, 418, 429].includes(e.status)
      )
        throw new BrokerRejection(e.message, String(e.status));
      throw e;
    }
  },
  async recover(order) {
    try {
      return (await upbitOrder(order.clientOrderId)).uuid;
    } catch (error) {
      if (error instanceof UpbitError && error.status === 404) return null;
      throw error;
    }
  },
  async poll(order) {
    const r = await upbitOrder(order.clientOrderId);
    const filled = new Decimal(r.executed_volume),
      notional = (r.trades ?? []).reduce(
        (s, t) => s.plus(new Decimal(t.price).mul(t.volume)),
        new Decimal(0),
      );
    return {
      status:
        r.state === "done"
          ? "filled"
          : r.state === "cancel"
            ? "canceled"
            : "working",
      filledQuantity: filled.toNumber(),
      averageFillPrice: filled.gt(0) ? notional.div(filled).toNumber() : null,
      commissionUsd: new Decimal(r.paid_fee).toNumber(),
    };
  },
  async cancel(order) {
    if (order.brokerOrderId) await upbitCancel(order.brokerOrderId);
  },
  async buyingPowerUsd() {
    return Number(
      (await upbitAccounts()).find((a) => a.currency === "KRW")?.balance ?? 0,
    );
  },
  async sellableQuantity(symbol) {
    return Number(
      (await upbitAccounts()).find((a) => a.currency === symbol.slice(4))
        ?.balance ?? 0,
    );
  },
  async entryProblem(symbol) {
    const [orders, chance] = await Promise.all([
      upbitOpenOrders(),
      upbitChance(symbol),
    ]);
    if (orders.length) return "Upbit 계좌 미체결 주문 있음";
    if (chance.market.state !== "active") return "Upbit 거래 중지";
    if (
      new Decimal(chance.bid_fee).mul(100).gt(0.05) ||
      new Decimal(chance.ask_fee).mul(100).gt(0.05)
    )
      return "연구 계약보다 높은 실제 Upbit 수수료 · 재검증 필요";
    if (new Decimal(chance.ask_account.balance).gt(0))
      return "기존 수동/타 장부 보유와 겹침";
    return null;
  },
});
export async function ctBroker(
  book: CTBook,
  mode: DashboardMode,
  toss: () => Promise<DashboardBroker>,
) {
  if (mode === "paper") {
    const quote =
      book === "ct-crypto"
        ? upbitQuote
        : (s: string) => fetchTossQuote(s, { withBook: true });
    return {
      mode: "paper" as const,
      quote,
      async submit(r: Parameters<DashboardBroker["submit"]>[0]) {
        return { brokerOrderId: `paper-${r.clientOrderId}` };
      },
      async poll(order: Parameters<DashboardBroker["poll"]>[0]) {
        const fee = book === "ct-crypto" ? 0.05 : feePerSidePct();
        return {
          status: "filled" as const,
          filledQuantity: order.quantity,
          averageFillPrice: order.referencePrice,
          commissionUsd: new Decimal(order.quantity)
            .mul(order.referencePrice)
            .mul(fee)
            .div(100)
            .toNumber(),
        };
      },
      async cancel() {},
    };
  }
  if (book === "ct-crypto") return cryptoBroker();
  const broker = await toss();
  return {
    ...broker,
    async recover(order: Parameters<DashboardBroker["poll"]>[0]) {
      const account = await tossPrimaryAccount();
      if (!account) throw new Error("Toss 계좌 없음");
      const all = [
        ...(await tossListOrders(account.accountSeq, "OPEN")),
        ...(await tossListOrders(account.accountSeq, "CLOSED")),
      ];
      return (
        all.find(
          (o) =>
            (o as typeof o & { clientOrderId?: string }).clientOrderId ===
            order.clientOrderId,
        )?.orderId ?? null
      );
    },
  };
}
export async function ctTick(
  book: CTBook,
  state: DashboardState,
  broker: DashboardBroker,
  checkpoint: (s: DashboardState) => Promise<void>,
) {
  const dataCache = new Map<
    string,
    Promise<Awaited<ReturnType<typeof ctRecentBars>>>
  >();
  const contract = state.ctRules?.[0]?.contract;
  if (!contract) throw new Error("CT 실행 스냅샷 누락");
  return tickCTDashboard(state, {
    now: () => Date.now(),
    id: () => crypto.randomUUID(),
    broker,
    checkpoint,
    bars: (symbol) => {
      if (!dataCache.has(symbol))
        dataCache.set(symbol, ctRecentBars(contract, symbol, Date.now()));
      return dataCache.get(symbol)!;
    },
    async entryAllowed() {
      if (
        state.mode === "live" &&
        (await accountHasUncertainOrders(`${book}-live`))
      )
        return false;
      if (book === "ct-stock") {
        const now = Date.now(),
          date = easternParts(now).date,
          day = await fetchTossTradingDay(date);
        if (!day?.regularMarket) return false;
        return (
          now >= Date.parse(day.regularMarket.startTime) &&
          now < Date.parse(day.regularMarket.endTime) - contract.minutes * 60000
        );
      }
      return true;
    },
  });
}
export async function ctStartState(
  book: CTBook,
  state: DashboardState,
  packages: CTPackage[],
) {
  if (!packages.length) throw new Error("등록된 CT 전략 없음");
  for (const p of packages)
    if ((await ctHash(executableCT(p.spec))) !== p.hash)
      throw new Error("CT 등록 해시 불일치");
  const chosen = packages.at(-1)!; // One global position; a start pins the most recently explicitly registered version.
  state.ctRules = [
    {
      id: chosen.id,
      spec: chosen.spec,
      hash: chosen.hash,
      contract: chosen.contract,
    },
  ];
  state.ctProgress = {};
  state.strategyIds = [chosen.id];
  state.initialCapitalUsd = chosen.contract.capital;
  state.cashUsd = chosen.contract.capital;
  state.peakEquityUsd = chosen.contract.capital;
  state.strategies = {
    [chosen.id]: {
      id: chosen.id,
      name: chosen.spec.name,
      slot: "open",
      signals: 0,
      entries: 0,
      missed: 0,
      closed: 0,
      compliant: 0,
      deviations: 0,
      wins: 0,
      pnlUsd: 0,
      commissionUsd: 0,
    },
  };
  void book;
  return state;
}
export async function ctReadiness(
  book: CTBook,
  live: DashboardState,
  paper: DashboardState,
  packages: CTPackage[],
  online: boolean,
) {
  const paperReasons: string[] = [],
    liveReasons: string[] = [];
  const latest = packages.at(-1);
  if (!latest) {
    paperReasons.push("검증을 통과한 CT 전략을 먼저 등록하세요.");
    liveReasons.push(...paperReasons);
  }
  let balance: number | null = null,
    error: string | null = null;
  if (book === "ct-crypto") {
    if (!upbitConfigured()) liveReasons.push("Upbit 계좌 키 미설정");
    else
      try {
        balance = Number(
          (await upbitAccounts()).find((a) => a.currency === "KRW")?.balance ??
            0,
        );
      } catch (e) {
        error = e instanceof Error ? e.message : "Upbit 연결 실패";
        liveReasons.push(error);
      }
    if (upbitSetting("UPBIT_TRADING_DISABLED") !== "false")
      liveReasons.push("UPBIT_TRADING_DISABLED · 실주문 잠금");
  }
  const forward = paper.trades.filter(
    (t) =>
      t.ctHash === latest?.hash &&
      t.status === "closed" &&
      Date.parse(t.entryAt ?? "") > Date.parse(latest?.createdAt ?? ""),
  );
  if (
    forward.length < 20 ||
    forward.reduce((s, t) => s + (t.pnlUsd ?? 0), 0) <= 0
  )
    liveReasons.push(
      "등록된 버전의 전향 모의 20거래·비용 후 양의 수익 확인 필요",
    );
  if (!online) liveReasons.push("실전 운용에는 백그라운드 러너 온라인 필요");
  if (balance !== null && latest && balance < latest.contract.capital)
    liveReasons.push("실제 주문 가능 잔고가 운용 예산보다 적습니다.");
  void live;
  return { paperReasons, liveReasons, balance, error };
}
export function ctDecorateView(
  view: TradingDashboardView,
  state: DashboardState,
  packages: CTPackage[],
) {
  const rules = state.ctRules?.length
    ? state.ctRules
    : packages.slice(-1).map((p) => ({
        id: p.id,
        spec: p.spec,
        hash: p.hash,
        contract: p.contract,
      }));
  view.strategies = rules.map((r) => {
    const s = state.strategies[r.id] ?? {
      id: r.id,
      name: r.spec.name,
      slot: "open" as const,
      signals: 0,
      entries: 0,
      missed: 0,
      closed: 0,
      compliant: 0,
      deviations: 0,
      wins: 0,
      pnlUsd: 0,
      commissionUsd: 0,
    };
    return {
      ...s,
      summary: ctRuleText(r.spec),
      universe: r.spec.symbols,
      slotLabel: `${r.spec.minutes}분 · ${r.spec.market === "crypto" ? "24시간 KST" : "미국 정규장 ET"}`,
      registered: true,
      adherencePct: s.closed ? (s.compliant / s.closed) * 100 : null,
      contributionPct: (s.pnlUsd / state.initialCapitalUsd) * 100,
    };
  });
  const summary = dashboardSummary(state);
  Object.assign(view, summary);
  view.positions = state.trades.filter((t) => heldQuantity(t) > 1e-8);
  view.orders = state.orders.filter(isActiveOrder);
  return view;
}
export async function ctRunnerOnline() {
  const row = await ctDb()
    .prepare("SELECT MAX(heartbeat_at) AS beat FROM ct_runtime")
    .first<{ beat: number | null }>();
  return Boolean(row?.beat && Date.now() - row.beat < 45000);
}
