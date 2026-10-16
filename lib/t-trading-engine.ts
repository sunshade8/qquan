import { ctBookRuntime } from "./t-book.ts";
import Decimal from "decimal.js";
import type {
  DashboardState,
  DashboardTrade,
  DashboardOrder,
} from "./dashboard-types.ts";
import type { DashboardBroker } from "./trading-engine.ts";
import {
  BrokerRejection,
  event,
  isActiveOrder,
  dashboardSummary,
} from "./trading-engine.ts";
import {
  detectCT,
  ctExitStep,
  ctForcedExit,
  ctOpenPosition,
  ctQuantity,
  ctDate,
  ctDayClosing,
  ctEntryBlocked,
  ctExitPlan,
  ctRiskPct,
  ctBarsAt,
  type CTBar,
} from "./t-engine.ts";
import { CT_ENGINE_V1, ctHash, executableCT } from "./t-spec.ts";
export type CTTradingDeps = {
  now: () => number;
  id: () => string;
  broker: DashboardBroker & {
    recover?: (order: DashboardOrder) => Promise<string | null>;
  };
  bars: (symbol: string) => Promise<CTBar[]>;
  checkpoint: (state: DashboardState) => Promise<void>;
  entryAllowed: (symbol?: string) => Promise<boolean>;
  evidence?: (trade: DashboardTrade, bars: CTBar[]) => Promise<void>;
};
const number = (value: Decimal.Value) => new Decimal(value).toNumber();
const remaining = (t: DashboardTrade) =>
  Math.max(0, number(new Decimal(t.boughtQuantity).minus(t.soldQuantity)));
const terminal = (o: DashboardOrder) => !isActiveOrder(o);
export async function tickCTDashboard(
  input: DashboardState,
  deps: CTTradingDeps,
) {
  const state = structuredClone(input),
    now = deps.now(),
    at = new Date(now).toISOString();
  state.lastTickAt = at;
  state.ctProgress ??= {};
  const rules = state.ctRules ?? [];
  for (const rule of rules)
    if ((await ctHash(executableCT(rule.spec))) !== rule.hash)
      throw new Error("승인·실행 CT 해시 불일치");
  const evidence = async (trade: DashboardTrade, bars: CTBar[] = []) => {
    try {
      await deps.evidence?.(trade, bars);
    } catch (error) {
      event(
        state,
        at,
        "error",
        `거래 차트 저장 실패: ${error instanceof Error ? error.message : "저장 오류"}`,
      );
    }
  };
  const submit = async (
    trade: DashboardTrade,
    side: "buy" | "sell",
    quantity: number,
    price: number,
    purpose: DashboardOrder["purpose"],
  ) => {
    const rule = rules.find((r) => r.id === trade.strategyId);
    if (!rule) throw new Error("시작 당시 CT 규칙 없음");
    if (
      state.orders.some(
        (o) => o.tradeId === trade.id && o.side === side && isActiveOrder(o),
      )
    )
      return;
    if (side === "sell")
      quantity = Math.min(
        quantity,
        remaining(trade),
        (await deps.broker.sellableQuantity?.(trade.symbol)) ?? quantity,
      );
    if (
      !Number.isFinite(quantity) ||
      !Number.isFinite(price) ||
      quantity <= 0 ||
      price <= 0
    )
      throw new Error("소유/매도 가능 수량 없음");
    const order: DashboardOrder = {
      id: deps.id(),
      tradeId: trade.id,
      clientOrderId: deps.id(),
      brokerOrderId: null,
      symbol: trade.symbol,
      side,
      purpose,
      quantity,
      limitPrice: price,
      referencePrice: price,
      filledQuantity: 0,
      averageFillPrice: null,
      commissionUsd: 0,
      status: "submitting",
      attempt: 1,
      submittedAt: at,
      updatedAt: at,
      message: null,
    };
    state.orders.push(order);
    await deps.checkpoint(state);
    if (
      side === "buy" &&
      (!trade.ctSignal ||
        deps.now() >= trade.ctSignal.validUntil ||
        !(await deps.entryAllowed(trade.symbol)) ||
        deps.now() >= trade.ctSignal.validUntil)
    ) {
      order.status = "rejected";
      order.message = "주문 의도 저장 이후 신호 만료/진입 차단";
      trade.status = "missed";
      trade.violations = [order.message];
      state.strategies[trade.strategyId].missed++;
      await deps.checkpoint(state);
      await evidence(trade);
      return;
    }
    try {
      const result = await deps.broker.submit({
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        side,
        quantity,
        limitPrice: price,
        referencePrice: price,
      });
      order.brokerOrderId = result.brokerOrderId;
      order.status = "working";
      event(
        state,
        at,
        "order",
        `${side} ${trade.symbol} ${quantity} · ${rule.hash.slice(0, 10)}`,
      );
    } catch (error) {
      if (error instanceof BrokerRejection) {
        order.status = "rejected";
        if (side === "buy" && trade.boughtQuantity === 0) {
          trade.status = "missed";
          state.strategies[trade.strategyId].missed++;
        }
      }
      order.message = error instanceof Error ? error.message : "주문 응답 유실";
      event(
        state,
        at,
        "error",
        `주문 결과: ${order.message} · 자동 재전송하지 않음`,
      );
    }
    await deps.checkpoint(state);
  };
  // Cumulative broker fills are reconciled by deltas. Restarts/partial fills cannot double cash.
  for (const order of state.orders.filter(isActiveOrder)) {
    if (!order.brokerOrderId) {
      order.brokerOrderId = (await deps.broker.recover?.(order)) ?? null;
      if (!order.brokerOrderId) {
        state.lastError =
          "응답 미확정 주문 대사 대기 · 신규 진입/정지 완료 차단";
        continue;
      }
    }
    const update = await deps.broker.poll(order),
      trade = state.trades.find((t) => t.id === order.tradeId);
    if (!trade) throw new Error("주문 소유 거래 없음");
    if (
      update.filledQuantity < order.filledQuantity ||
      update.filledQuantity > order.quantity + 1e-8 ||
      update.commissionUsd < order.commissionUsd
    )
      throw new Error("브로커 누적 체결 역행/초과");
    const delta = number(
      new Decimal(update.filledQuantity).minus(order.filledQuantity),
    );
    const notional = number(
      new Decimal(update.filledQuantity)
        .mul(update.averageFillPrice ?? 0)
        .minus(
          new Decimal(order.filledQuantity).mul(order.averageFillPrice ?? 0),
        ),
    );
    const fee = number(
      new Decimal(update.commissionUsd).minus(order.commissionUsd),
    );
    if (delta > 0) {
      if (!update.averageFillPrice) throw new Error("체결가 미확인");
      if (order.side === "buy") {
        trade.boughtQuantity = number(
          new Decimal(trade.boughtQuantity).plus(delta),
        );
        trade.buyNotionalUsd = number(
          new Decimal(trade.buyNotionalUsd).plus(notional),
        );
        state.cashUsd = number(
          new Decimal(state.cashUsd).minus(notional).minus(fee),
        );
        trade.entryPrice = trade.buyNotionalUsd / trade.boughtQuantity;
        trade.entryAt ??= at;
        trade.status = "open";
        trade.entrySlippagePct =
          (trade.entryPrice / trade.referencePrice - 1) * 100;
      } else {
        if (delta > remaining(trade) + 1e-8)
          throw new Error("CT 소유 수량 초과 매도 체결");
        trade.soldQuantity = number(
          new Decimal(trade.soldQuantity).plus(delta),
        );
        trade.sellNotionalUsd = number(
          new Decimal(trade.sellNotionalUsd).plus(notional),
        );
        state.cashUsd = number(
          new Decimal(state.cashUsd).plus(notional).minus(fee),
        );
        trade.exitPrice = trade.sellNotionalUsd / trade.soldQuantity;
        trade.exitAt = at;
      }
    } else if (fee)
      state.cashUsd = number(new Decimal(state.cashUsd).minus(fee));
    trade.commissionUsd = number(new Decimal(trade.commissionUsd).plus(fee));
    Object.assign(order, update, { updatedAt: at });
    if (order.side === "buy" && terminal(order) && trade.boughtQuantity === 0) {
      trade.status = "missed";
      trade.violations = ["신호 미체결"];
    }
    if (order.side === "sell" && terminal(order) && remaining(trade) <= 1e-8) {
      trade.status = "closed";
      trade.exit = trade.pendingExit;
      trade.pnlUsd = number(
        new Decimal(trade.sellNotionalUsd)
          .minus(trade.buyNotionalUsd)
          .minus(trade.commissionUsd),
      );
      trade.returnPct = (trade.pnlUsd / trade.equityAtEntryUsd) * 100;
      const rule = rules.find((r) => r.id === trade.strategyId)!;
      trade.violations = [
        Math.abs(trade.entrySlippagePct ?? Infinity) >
          rule.spec.entry.maxDeviationPct && "진입 괴리 초과",
        trade.ctHash !== rule.hash && "승인 해시 불일치",
        (!trade.ctSignal ||
          Date.parse(trade.entryAt!) < trade.ctSignal.decidedAt) &&
          "신호 확정 전 체결",
        trade.ctSignal &&
          Date.parse(trade.entryAt!) > trade.ctSignal.validUntil &&
          "신호 유효시간 이후 체결",
        trade.boughtQuantity >
          state.orders
            .filter((o) => o.tradeId === trade.id && o.side === "buy")
            .reduce((sum, o) => sum + o.quantity, 0) +
            1e-8 && "요청 수량 초과",
        trade.soldQuantity > trade.boughtQuantity + 1e-8 && "소유 수량 초과",
        !trade.pendingExit && "청산 판단 근거 없음",
      ].filter(Boolean) as string[];
      trade.compliant = trade.violations.length === 0;
      const stats = state.strategies[trade.strategyId];
      stats.closed++;
      stats.pnlUsd += trade.pnlUsd;
      stats.commissionUsd += trade.commissionUsd;
      stats.wins += trade.pnlUsd > 0 ? 1 : 0;
      stats.compliant += trade.compliant ? 1 : 0;
      stats.deviations += trade.compliant ? 0 : 1;
    }
    await deps.checkpoint(state);
    if (isActiveOrder(order) && now - Date.parse(order.submittedAt) > 30000) {
      await deps.broker.cancel(order);
      order.status = "cancel_requested";
      await deps.checkpoint(state);
    }
    await evidence(trade);
  }
  if (state.status === "stopping") {
    state.stopPhase = "cancel_buys";
    for (const order of state.orders.filter(
      (o) => o.side === "buy" && isActiveOrder(o),
    )) {
      if (order.brokerOrderId) {
        await deps.broker.cancel(order);
        order.status = "cancel_requested";
      }
    }
    await deps.checkpoint(state);
    if (state.orders.some((o) => o.side === "buy" && isActiveOrder(o)))
      return state;
    state.stopPhase = "liquidate";
    for (const trade of state.trades.filter((t) => remaining(t) > 1e-8)) {
      const q = await deps.broker.quote(trade.symbol);
      trade.pendingExit = "shutdown";
      await submit(
        trade,
        "sell",
        remaining(trade),
        q.bid ?? q.price,
        "shutdown",
      );
    }
    state.stopPhase = "confirm";
    if (
      !state.orders.some(isActiveOrder) &&
      !state.trades.some((t) => remaining(t) > 1e-8)
    ) {
      state.status = "stopped";
      state.stoppedAt = at;
      state.stopPhase = null;
      event(state, at, "info", "CT 소유 포지션 청산 확인 · 정지 완료");
    }
    return state;
  }
  if (state.status !== "running") return state;
  for (const trade of state.trades.filter((t) => remaining(t) > 1e-8)) {
    const rule = rules.find((r) => r.id === trade.strategyId)!;
    if (trade.ctHash !== rule.hash || !trade.ctSignal)
      throw new Error("거래 시작 규칙 추적 누락");
    const quote = await deps.broker.quote(trade.symbol);
    trade.markPrice = quote.price;
    // Free bars: the rule's own bar built from the one-minute feed, exactly as replayCT builds it.
    const bars = ctBarsAt(await deps.bars(trade.symbol), rule.spec.minutes);
    // The entry bar opens when the signal bar closes — the backtest's entryAt. The bar loop below judges that
    // bar and every later one, exactly as replayCT does, whatever second the fill was noticed in.
    const entryAt = trade.ctSignal.decidedAt;
    // The position (stop/target levels and how they moved) is the one ctExitStep keeps for the backtest too.
    // A stored one continues; a missing one (older trade) is opened from the actual fill.
    const opened = trade.ctPosition ?? ctOpenPosition(rule.spec, trade.ctSignal, trade.entryPrice!, entryAt);
    let exit = trade.pendingExit;
    let detail = trade.ctExitReason;
    const toExit = (reason: string) => (reason === "stop" || reason === "breakeven" || reason === "trail" ? "stop" : reason === "target" ? "target" : "slot_end");
    if (!opened) {
      // The rule has no valid stop for the actual fill: do not hold a position that cannot be stopped.
      exit = "stop";
      detail = "invalid_stop";
    } else {
      trade.ctPosition = opened;
      for (const bar of bars.filter(
        (b) => b.startMs >= entryAt && b.endMs > (trade.checkedThroughMs ?? 0),
      )) {
        const step = ctExitStep(rule.spec, trade.ctSignal, trade.ctPosition!, bar);
        if(!step.exit && rule.book && !ctBookRuntime(rule.book,rule.components??[],{[trade.symbol]:bars},rule.contract,bar.endMs).target)step.exit={price:bar.close,reason:"book_signal_expired"};
        trade.ctPosition = step.position;
        trade.checkedThroughMs = bar.endMs;
        if (step.exit) {
          exit = toExit(step.exit.reason);
          detail = step.exit.reason;
          break;
        }
      }
      // Live price against the level that stood after the last closed bar.
      const position = trade.ctPosition!;
      if (quote.price <= position.stopLevel) {
        exit = "stop";
        detail = position.stopSource === "initial" ? "stop" : position.stopSource;
      } else if (position.targetLevel !== null && quote.price >= position.targetLevel) {
        exit = "target";
        detail = "target";
      }
    }
    if (
      now >= Date.parse(trade.slotEndsAt) ||
      // The same day-end rule the backtest uses: stock session close, ct-pattern-2 crypto UTC 00:00.
      ctDayClosing(rule.spec, rule.contract.market, now)
    ) {
      exit = "slot_end";
      detail = ctForcedExit(rule.spec, rule.contract.market, { endMs: now } as CTBar)?.reason ?? (ctExitPlan(rule.spec).managed ? "max_hold" : "time");
    }
    if (exit && detail) trade.ctExitReason = detail;
    if (exit) {
      trade.pendingExit = exit;
      const buys = state.orders.filter(
        (o) => o.tradeId === trade.id && o.side === "buy" && isActiveOrder(o),
      );
      if (buys.length) {
        for (const buy of buys)
          if (buy.brokerOrderId) {
            await deps.broker.cancel(buy);
            buy.status = "cancel_requested";
          }
        await deps.checkpoint(state);
        continue;
      }
      await submit(
        trade,
        "sell",
        remaining(trade),
        quote.bid ?? quote.price,
        exit,
      );
    }
    await evidence(trade, bars);
  }
  const equity = dashboardSummary(state).equityUsd;
  const date = ctDate(now, rules[0]?.contract.market ?? "stock");
  let daily = state.daily.find((d) => d.date === date);
  if (!daily) {
    daily = {
      date,
      startEquityUsd: equity,
      equityUsd: equity,
      pnlUsd: 0,
      returnPct: 0,
      trades: 0,
    };
    state.daily.push(daily);
  }
  daily.equityUsd = equity;
  daily.pnlUsd = equity - daily.startEquityUsd;
  daily.returnPct = (equity / daily.startEquityUsd - 1) * 100;
  state.peakEquityUsd = Math.max(state.peakEquityUsd, equity);
  state.maxDrawdownPct = Math.max(
    state.maxDrawdownPct,
    (1 - equity / state.peakEquityUsd) * 100,
  );
  if (
    daily.returnPct <= -3 ||
    state.maxDrawdownPct >= 15 ||
    state.trades.some((t) => remaining(t) > 1e-8) ||
    state.orders.some(isActiveOrder)
  )
    return state;
  if (!(await deps.entryAllowed())) return state;
  for (const rule of rules) {
    for (const symbol of rule.spec.symbols) {
      if (!(await deps.entryAllowed(symbol))) continue;
      const bars = ctBarsAt(await deps.bars(symbol), rule.spec.minutes),
        last = bars.at(-1);
      if (!last || last.endMs < now - rule.spec.minutes * 60000 - 60000)
        continue;
      const key = `${rule.id}:${symbol}`;
      if ((state.ctProgress[key] ?? 0) >= last.endMs) continue;
      state.ctProgress[key] = last.endMs;
      const previous = state.trades
        .filter((t) => t.strategyId === rule.id)
        .at(-1);
      if (
        previous &&
        now - Date.parse(previous.exitAt ?? previous.decidedAt) <
          rule.spec.sizing.cooldownBars * rule.spec.minutes * 60000
      )
        continue;
      if (
        (rule.spec.engine !== CT_ENGINE_V1 || rule.spec.entry.noEntryBeforeDayEndMinutes) &&
        ctEntryBlocked(rule.spec, rule.contract.market, now, true)
      )
        continue;
      const signal = rule.book ? ctBookRuntime(rule.book,rule.components??[],{[symbol]:bars},rule.contract,last.endMs).signal : detectCT(rule.spec, symbol, bars, now);
      if (!signal || now >= signal.validUntil) continue;
      // Entry windows are judged at the signal bar's close — the same instant the backtest uses.
      if (rule.spec.entry.entryWindows?.length && ctEntryBlocked(rule.spec, rule.contract.market, signal.decidedAt)) continue;
      const quote = await deps.broker.quote(symbol),
        quoteTime = Date.parse(quote.timestamp ?? ""),
        bookTime = Date.parse(quote.bookTimestamp ?? "");
      if (
        !quote.bid ||
        !quote.ask ||
        quote.bid > quote.ask ||
        !Number.isFinite(quoteTime) ||
        !Number.isFinite(bookTime) ||
        now - quoteTime > 60000 ||
        now - bookTime > 60000 ||
        quoteTime > now + 5000 ||
        bookTime > now + 5000 ||
        (quote.ask / quote.bid - 1) * 100 > rule.spec.entry.maxSpreadPct ||
        Math.abs(quote.ask / signal.reference - 1) * 100 >
          rule.spec.entry.maxDeviationPct
      )
        continue;
      const buyingPower =
        (await deps.broker.buyingPowerUsd?.()) ??
        (state.mode === "paper" ? state.cashUsd : NaN);
      if (!Number.isFinite(buyingPower) || buyingPower <= 0) continue;
      const plan = ctExitPlan(rule.spec);
      if (plan.invalidationLow && quote.ask <= signal.patternLow) continue;
      // A managed exit sizes from the stop distance at the price we would pay; no valid stop, no entry.
      const probe = plan.managed ? ctOpenPosition(rule.spec, signal, quote.ask, now) : null;
      if (plan.managed && !probe) continue;
      const quantity = ctQuantity(
        rule.spec,
        rule.contract,
        Math.min(state.cashUsd, buyingPower),
        equity,
        quote.ask,
        last.volume,
        probe ? ctRiskPct(probe) : undefined,
      );
      if (!quantity) continue;
      if (
        await deps.broker.entryProblem?.(symbol, "open", date, {
          from: "09:30",
          to: "16:00",
        })
      )
        continue;
      if (
        deps.now() >= signal.validUntil ||
        deps.now() - quoteTime > 60000 ||
        !(await deps.entryAllowed(symbol))
      )
        continue;
      const trade: DashboardTrade = {
        id: deps.id(),
        strategyId: rule.id,
        strategyName: rule.spec.name,
        slot: "open",
        symbol,
        date,
        status: "entering",
        reason: "CT 확정 패턴",
        signalTime: new Date(signal.decidedAt).toISOString(),
        decidedAt: new Date(signal.decidedAt).toISOString(),
        referencePrice: signal.reference,
        stopPct: probe ? ctRiskPct(probe) : "stopPct" in rule.spec.exit ? rule.spec.exit.stopPct : 0,
        targetPct: plan.target ? (plan.target.type === "pct" ? plan.target.value : null) : null,
        slotEndsAt: new Date(
          signal.decidedAt +
            rule.spec.exit.maxHoldBars * rule.spec.minutes * 60000,
        ).toISOString(),
        equityAtEntryUsd: equity,
        boughtQuantity: 0,
        soldQuantity: 0,
        buyNotionalUsd: 0,
        sellNotionalUsd: 0,
        entryPrice: null,
        entryAt: null,
        exitPrice: null,
        exitAt: null,
        exit: null,
        pendingExit: null,
        exitAttempts: 0,
        markPrice: quote.price,
        checkedThroughMs: null,
        commissionUsd: 0,
        pnlUsd: null,
        returnPct: null,
        compliant: null,
        violations: [],
        entrySlippagePct: null,
        ctSignal: signal,
        ctHash: rule.hash,
      };
      state.trades.push(trade);
      await evidence(trade, bars);
      state.strategies[rule.id].signals++;
      state.strategies[rule.id].entries++;
      daily.trades++;
      event(
        state,
        at,
        "signal",
        `${symbol} · ${rule.spec.name} · ${rule.hash.slice(0, 10)}`,
      );
      await submit(trade, "buy", quantity, quote.ask, "entry");
      return state;
    }
  }
  state.lastError = null;
  return state;
}
