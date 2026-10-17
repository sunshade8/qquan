/**
 * Cost profiles for CT research, one per exchange (docs/ct.md「비용 프로필」).
 *
 * A profile is a versioned, sourced set of the numbers replayCT charges: fee, tax, spread and
 * slippage. New contracts are built from a profile and store `costProfile: {id, version}`
 * beside the resulting numbers; old contracts and registered packages keep their stored `costs`
 * untouched and never read this file.
 *
 *  - Fees come from the exchange's official fee page; the page and the day it was read are
 *    recorded. Nothing is taken from memory.
 *  - Spread and slippage are MEASURED (scripts/data/measure-orderbook.mjs: public order books,
 *    once a minute) and set to the p90 of the measurement, never below it. Per symbol and per
 *    order size: capital up to $1,000 uses the $1,000 order, up to $10,000 the $10,000 order.
 *  - The 2× cost stress in the gate is unchanged and still applies on top of a profile.
 *
 * What the order book cannot show: delay between the signal bar's close and the fill, queueing,
 * and adverse selection. replayCT fills at the next bar's open ± impact and the stress doubles
 * that; a profile is therefore a floor on live cost, not a forecast of it.
 */
import { CT_MEASURED_IMPACT, CT_MEASUREMENT_SCRIPT, type CTMeasuredImpact } from "./ct-cost-measurements.ts";
import { TOSS_US_EQUITY, feePerSidePct } from "./broker-costs.ts";
import type { CTContract, CTMarket } from "./ct-spec.ts";
import { CT_LIMIT_DEFAULTS, ctExecutionText, ctFreezeFees, type CTExecutionPolicy, type CTFeeProvenance } from "./ct-limit-execution.ts";

export type CTCostProfile = {
  id: string;
  version: number;
  label: string;
  market: CTMarket;
  /** Key prefix in ct-cost-measurements (`${venue}:${symbol}`); null when nothing is measured. */
  venue: "binance" | "binance-usdm" | "upbit" | null;
  currency: CTContract["currency"];
  /** Taker fee for profiles without `execution`; with it, the larger of the two (`feePct` = taker, kept for sizing and the stress). */
  feePct: number;
  sellTaxPct: number;
  minimumOrder: number;
  quantityDecimals: number;
  /** True while the measurement is shorter than the 72 hours the profile requires. */
  provisional: boolean;
  /** False when the fee could not be confirmed on an official page. */
  feeVerified: boolean;
  source: {
    fee: { url: string; checkedAt: string; note: string };
    measurement: { script: string; note: string } | null;
  };
  /** Limit-order-only profiles (v2 on): the official fee table the policy's maker and taker fees start from. */
  execution?: { makerFeePct: number; takerFeePct: number; official: CTFeeProvenance["official"] };
  /** Derived from the measurement: per symbol and order size, spreadPct (full) and slippagePct (per side beyond the half spread). */
  symbols: Record<string, Record<string, { spreadPct: number; slippagePct: number }>>;
};

export const CT_PROFILE_MIN_HOURS = 72;

/** spread = p90 spread; slippage = whatever p90 side impact exceeds half that spread, so spread/2 + slippage ≥ p90 impact. */
function derive(venue: "binance" | "binance-usdm" | "upbit") {
  const out: CTCostProfile["symbols"] = {};
  for (const [key, per] of Object.entries(CT_MEASURED_IMPACT)) {
    const [v, symbol] = key.split(":");
    if (v !== venue) continue;
    out[symbol] = Object.fromEntries(
      Object.entries(per).map(([usd, m]: [string, CTMeasuredImpact]) => [
        usd,
        { spreadPct: m.spreadPctP90, slippagePct: Math.max(0, m.sideImpactPctP90 - m.spreadPctP90 / 2) },
      ]),
    );
  }
  return out;
}
const hours = (venue: string) =>
  Math.min(Infinity, ...Object.entries(CT_MEASURED_IMPACT).filter(([k]) => k.startsWith(`${venue}:`)).flatMap(([, per]) => Object.values(per).map((m) => m.hours)));

const BINANCE_SPOT_V1: CTCostProfile = {
    id: "binance-spot-usdt",
    version: 1,
    label: "Binance Spot (USDT)",
    market: "crypto",
    venue: "binance",
    currency: "USDT",
    feePct: 0.1,
    sellTaxPct: 0,
    minimumOrder: 5,
    quantityDecimals: 8,
    provisional: hours("binance") < CT_PROFILE_MIN_HOURS,
    feeVerified: true,
    source: {
      fee: {
        url: "https://www.binance.com/en/fee/schedule",
        checkedAt: "2026-10-14",
        note: "Regular User 현물 maker 0.100% / taker 0.100% (BNB 25% 할인 0.075%는 가정하지 않음)",
      },
      measurement: {
        script: CT_MEASUREMENT_SCRIPT,
        note: "공개 depth 스냅샷 1분 간격 · 시장가 매수·매도 $1,000/$10,000의 mid 대비 편도 충격 · p90",
      },
    },
    symbols: derive("binance"),
};

/**
 * binance-spot-usdt v2 (2026-10-17): every order is a limit order (docs/prompts/binance-only-limit-orders.md). Same measured
 * book as v1 — it prices the taker legs (stop-limits that are marketable, time/day-end exits, the emergency market sell) —
 * and the same 0.1% fee table; what changes is the execution model frozen with the contract (lib/ct-limit-execution.ts).
 * Spot Regular is maker 0.100% = taker 0.100%, so the limit model removes the entry's spread and impact, NOT fee.
 */
const BINANCE_SPOT_V2: CTCostProfile = {
  ...BINANCE_SPOT_V1,
  version: 2,
  label: "Binance Spot (USDT) · 지정가",
  source: {
    fee: {
      url: "https://www.binance.com/en/fee/schedule",
      checkedAt: "2026-10-17",
      note: "Regular User 현물 maker 0.100% / taker 0.100% (BNB 25% 할인은 가정하지 않음). 계약에는 max(공식 표, 계정 실제 요율)을 동결. 페이지에 수정일 표기 없음",
    },
    measurement: BINANCE_SPOT_V1.source.measurement,
  },
  execution: {
    makerFeePct: 0.1,
    takerFeePct: 0.1,
    official: { makerPct: 0.1, takerPct: 0.1, url: "https://www.binance.com/en/fee/schedule", checkedAt: "2026-10-17" },
  },
};

/**
 * binance-usdm v1: USDⓈ-M perpetuals, Regular User (VIP 0) maker 0.0200% / taker 0.0500% (updated 2026-05-01, read 2026-10-17;
 * BNB discount 10% only with BNB held in the futures account — not assumed). Orders are LIMIT + timeInForce GTX (post-only).
 * Not usable for a contract yet: the futures order book has been sampled only since 2026-10-17 (measure-orderbook.mjs,
 * venue "binance-usdm") and the futures replay and live path are blocked (assertCTCapability).
 */
const BINANCE_USDM_V1: CTCostProfile = {
  id: "binance-usdm",
  version: 1,
  label: "Binance USDⓈ-M 선물 (USDT) · 지정가",
  market: "crypto",
  venue: "binance-usdm",
  currency: "USDT",
  feePct: 0.05,
  sellTaxPct: 0,
  minimumOrder: 5,
  quantityDecimals: 3,
  provisional: true,
  feeVerified: true,
  source: {
    fee: {
      url: "https://www.binance.com/en/support/faq/detail/360033544231",
      checkedAt: "2026-10-17",
      note: "Regular User(VIP 0) USDⓈ-M maker 0.0200% / taker 0.0500%, 페이지 수정일 2026-05-01 11:51. 계정 실제 값은 GET /fapi/v1/commissionRate",
    },
    measurement: { script: CT_MEASUREMENT_SCRIPT, note: "공개 선물 depth 스냅샷 1분 간격(venue binance-usdm). 2026-10-17부터 수집 — 이전의 선물 호가는 현물로 근사했음" },
  },
  execution: {
    makerFeePct: 0.02,
    takerFeePct: 0.05,
    official: { makerPct: 0.02, takerPct: 0.05, url: "https://www.binance.com/en/support/faq/detail/360033544231", checkedAt: "2026-10-17" },
  },
  symbols: derive("binance-usdm"),
};

/** Every version ever issued, so a contract's {id, version} can always be looked up. */
export const CT_COST_PROFILE_HISTORY: CTCostProfile[] = [BINANCE_SPOT_V1];

export const CT_COST_PROFILES: Record<string, CTCostProfile> = {
  "binance-spot-usdt": BINANCE_SPOT_V2,
  "binance-usdm": BINANCE_USDM_V1,
  "upbit-krw": {
    id: "upbit-krw",
    version: 2,
    label: "Upbit KRW",
    market: "crypto",
    venue: "upbit",
    currency: "KRW",
    // v2 (2026-10-14): 0.05%. v1 carried 0.139% because no official page could be read; that is the
    // 예약주문(reserved order) rate, which the Open API does not use. The Open API's order-chance
    // documentation shows bid_fee/ask_fee/maker_bid_fee/maker_ask_fee = "0.0005", and the live
    // entry guard (ct-trading.ts entryProblem) already blocks any account fee above 0.05%.
    // Not used by any new contract: CT research data is Binance, and Binance-researched
    // strategies cannot start on Upbit.
    feePct: 0.05,
    sellTaxPct: 0,
    minimumOrder: 5000,
    quantityDecimals: 8,
    provisional: true,
    feeVerified: true,
    source: {
      fee: {
        url: "https://docs.upbit.com/kr/reference/available-order-information",
        checkedAt: "2026-10-14",
        note: "Open API 주문 가능 정보 문서(수정 2026-10-07)의 bid_fee·ask_fee·maker_* 예시 0.0005 = 0.05%, 적용 수수료율은 주문 요청 시점 기준. 원화마켓 0.05%·예약주문 0.139%는 언론·정보 사이트와 일치(API 일반 주문은 0.05%). 계정별 실제 값은 실행 때 주문 가능 정보로 재확인",
      },
      measurement: { script: CT_MEASUREMENT_SCRIPT, note: "공개 orderbook 스냅샷 · KRW/USD는 KRW-USDT 시세로 환산" },
    },
    symbols: derive("upbit"),
  },
  "toss-us-equity": {
    id: "toss-us-equity",
    version: 1,
    label: "Toss 미국 주식",
    market: "stock",
    venue: null,
    currency: "USD",
    feePct: TOSS_US_EQUITY.feePerSidePct,
    sellTaxPct: TOSS_US_EQUITY.secSellFeePct,
    minimumOrder: 1,
    quantityDecimals: 0,
    provisional: false,
    feeVerified: false,
    source: {
      fee: { url: "docs/toss-api.md", checkedAt: "2026-10-14", note: "기존 lib/broker-costs.ts 값(TOSS_FEE_PER_SIDE_PCT로 덮어쓸 수 있음). 스프레드·슬리피지는 기존 가정 0.05%/0.03%이며 측정하지 않음" },
      measurement: null,
    },
    symbols: {},
  },
};

/** The profile a contract named: the current one, or an earlier version kept in the history. */
export function ctCostProfile(id: string, version?: number): CTCostProfile | undefined {
  const current = CT_COST_PROFILES[id];
  if (!current || version === undefined || current.version === version) return current;
  return CT_COST_PROFILE_HISTORY.find((p) => p.id === id && p.version === version);
}

export const CT_DEFAULT_PROFILE: Record<CTMarket, string> = { crypto: "binance-spot-usdt", stock: "toss-us-equity" };

export type CTProfileCosts = {
  costs: CTContract["costs"];
  costProfile: { id: string; version: number };
  provisional: boolean;
  notes: string[];
  /** Limit-order profiles: the execution policy to freeze into the contract. */
  execution?: CTExecutionPolicy;
};

/**
 * The contract costs for a research run: the worst measured spread and slippage over the chosen
 * symbols at the order size the capital implies.
 */
export function ctProfileCosts(
  market: CTMarket,
  symbols: string[],
  capital: number,
  profileId = CT_DEFAULT_PROFILE[market],
  /** What the exchange reports for this account, read just now (null: not readable — the official table alone is frozen). */
  account: { fees: CTFeeProvenance["account"]; note: string | null } = { fees: null, note: null },
): CTProfileCosts {
  const profile = CT_COST_PROFILES[profileId];
  if (!profile || profile.market !== market) throw new Error(`비용 프로필 ${profileId}은(는) ${market} 시장용이 아닙니다.`);
  const notes: string[] = [];
  let spreadPct: number, slippagePct: number;
  if (profile.venue) {
    // Order-size bucket: the smallest measured size that covers the capital.
    const sizes = [...new Set(Object.values(profile.symbols).flatMap((per) => Object.keys(per).map(Number)))].sort((a, b) => a - b);
    const size = sizes.find((s) => capital <= s) ?? sizes.at(-1);
    if (size === undefined) throw new Error(`비용 프로필 ${profile.id}에 호가 측정값이 없습니다. ${CT_MEASUREMENT_SCRIPT}를 실행하세요.`);
    if (capital > size) notes.push(`자본 ${capital}이 측정한 최대 주문 규모 $${size}를 넘어 같은 규모 값을 사용했다 — 충격이 과소평가됐을 수 있다`);
    const per = symbols.map((s) => profile.symbols[s]?.[String(size)]);
    if (per.some((p) => !p)) throw new Error(`비용 프로필 ${profile.id}에 ${symbols.filter((s, i) => !per[i]).join(", ")} 호가 측정값이 없습니다.`);
    spreadPct = Math.max(...per.map((p) => p!.spreadPct));
    slippagePct = Math.max(...per.map((p) => p!.slippagePct));
  } else {
    spreadPct = 0.05;
    slippagePct = TOSS_US_EQUITY.assumedSlippagePct;
  }
  if (profile.provisional) notes.push(`프로필 ${profile.id} v${profile.version}은 잠정: 호가 측정이 ${CT_PROFILE_MIN_HOURS}시간 미만`);
  if (!profile.feeVerified && profile.venue) notes.push("수수료를 공식 문서에서 확인하지 못함");
  let execution: CTExecutionPolicy | undefined;
  let feePct = profile.market === "stock" ? feePerSidePct() : profile.feePct;
  if (profile.execution) {
    const frozen = ctFreezeFees(profile.execution.official, account.fees);
    execution = {
      version: 1,
      mode: "limit",
      makerFeePct: frozen.makerFeePct,
      takerFeePct: frozen.takerFeePct,
      entryTtlBars: CT_LIMIT_DEFAULTS.entryTtlBars,
      penetrationTicks: CT_LIMIT_DEFAULTS.penetrationTicks,
      tickSize: { ...CT_LIMIT_DEFAULTS.tickSize },
      stop: { ...CT_LIMIT_DEFAULTS.stop },
      fees: { official: profile.execution.official, account: account.fees, accountNote: account.note },
    };
    // `costs.feePct` is the taker fee: position sizing, the drawdown mark and the 2× stress read it.
    feePct = frozen.takerFeePct;
    // A screen preview does not read the account (no note): only a real read attempt that failed is worth saying.
    if (account.fees === null) { if (account.note) notes.push(`계정 실제 수수료를 읽지 못해 공식 표만 동결(${account.note})`); }
    else if (account.fees.makerPct > profile.execution.official.makerPct || account.fees.takerPct > profile.execution.official.takerPct)
      notes.push("계정의 실제 수수료가 공식 표보다 높아 더 높은 값을 동결");
  }
  return {
    ...(execution ? { execution } : {}),
    costs: {
      feePct,
      sellTaxPct: profile.sellTaxPct,
      spreadPct: Number(spreadPct.toFixed(6)),
      slippagePct: Number(slippagePct.toFixed(6)),
      minimumOrder: profile.minimumOrder,
      quantityDecimals: profile.quantityDecimals,
    },
    costProfile: { id: profile.id, version: profile.version },
    provisional: profile.provisional,
    notes,
  };
}

/** One line for screens and reviewers: which profile priced this contract. */
export function ctCostProfileText(contract: Pick<CTContract, "costs" | "costProfile"> & Partial<Pick<CTContract, "execution">>, roundTripPct: number) {
  if (!contract.costProfile) return `저장된 비용(프로필 이전 계약) · 왕복 ${roundTripPct.toFixed(3)}%`;
  const profile = ctCostProfile(contract.costProfile.id, contract.costProfile.version) ?? CT_COST_PROFILES[contract.costProfile.id];
  const label = profile ? profile.label : contract.costProfile.id;
  const limit = contract.execution ? ` · 메이커 ${contract.execution.makerFeePct}% / 테이커 ${contract.execution.takerFeePct}%` : "";
  return `${label} 프로필 v${contract.costProfile.version}${profile?.provisional ? " (잠정)" : ""}${limit} · 왕복 ${roundTripPct.toFixed(3)}%`;
}
/** The limit model in a sentence, with the spot fee fact. Empty for a contract without one. */
export function ctExecutionNote(contract: Partial<Pick<CTContract, "execution">>) {
  const e = contract.execution;
  if (!e) return "";
  const text = ctExecutionText(e);
  return e.makerFeePct === e.takerFeePct ? `${text}. 현물 Regular 등급은 메이커=테이커=${e.makerFeePct}%라 지정가로 바꿔도 수수료는 줄지 않고, 진입의 스프레드·충격만 줄어든다` : text;
}

/** Round-trip cost, percent, by the replay's own fill and fee formulas (identical to ctRoundTripCostPct). Pure, safe for screens. */
export function ctCostsRoundTripPct(costs: CTContract["costs"], multiplier = 1, execution?: Pick<CTExecutionPolicy, "makerFeePct" | "takerFeePct">) {
  const impact = ((costs.spreadPct / 2 + costs.slippagePct) * multiplier) / 100;
  if (execution) {
    // Same as ctNetTradePct for a limit contract: maker entry without impact, taker exit.
    const buyFee = (execution.makerFeePct * multiplier) / 100,
      sellFee = ((execution.takerFeePct + costs.sellTaxPct) * multiplier) / 100;
    return -(((1 - impact) * (1 - sellFee)) / (1 + buyFee) - 1) * 100;
  }
  const buyFee = (costs.feePct * multiplier) / 100,
    sellFee = ((costs.feePct + costs.sellTaxPct) * multiplier) / 100;
  return -(((1 - impact) * (1 - sellFee)) / ((1 + impact) * (1 + buyFee)) - 1) * 100;
}
/** What a research start would be priced with, for the screen before the run exists. */
export function ctCostPreview(market: CTMarket, capital = 1000) {
  const symbols = market === "crypto" ? Object.keys(CT_COST_PROFILES[CT_DEFAULT_PROFILE.crypto].symbols) : [];
  let execution: CTExecutionPolicy | undefined;
  const per = (market === "crypto" ? symbols : [""]).map((symbol) => {
    const priced = ctProfileCosts(market, symbol ? [symbol] : [], capital);
    execution = priced.execution;
    return { symbol, roundTripPct: Number(ctCostsRoundTripPct(priced.costs, 1, priced.execution).toFixed(4)), provisional: priced.provisional, profile: priced.costProfile, notes: priced.notes };
  });
  const profile = CT_COST_PROFILES[per[0].profile.id];
  return {
    label: profile.label,
    version: profile.version,
    provisional: profile.provisional,
    feeVerified: profile.feeVerified,
    // Fee table with its source and the day it was read (screens show these; nothing here is from memory).
    fee: execution
      ? { makerPct: execution.makerFeePct, takerPct: execution.takerFeePct, url: profile.source.fee.url, checkedAt: profile.source.fee.checkedAt, note: profile.source.fee.note }
      : { makerPct: profile.feePct, takerPct: profile.feePct, url: profile.source.fee.url, checkedAt: profile.source.fee.checkedAt, note: profile.source.fee.note },
    executionNote: execution ? ctExecutionNote({ execution }) : null,
    perSymbol: per,
  };
}
