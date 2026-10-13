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

export type CTCostProfile = {
  id: string;
  version: number;
  label: string;
  market: CTMarket;
  /** Key prefix in ct-cost-measurements (`${venue}:${symbol}`); null when nothing is measured. */
  venue: "binance" | "upbit" | null;
  currency: CTContract["currency"];
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
  /** Derived from the measurement: per symbol and order size, spreadPct (full) and slippagePct (per side beyond the half spread). */
  symbols: Record<string, Record<string, { spreadPct: number; slippagePct: number }>>;
};

export const CT_PROFILE_MIN_HOURS = 72;

/** spread = p90 spread; slippage = whatever p90 side impact exceeds half that spread, so spread/2 + slippage ≥ p90 impact. */
function derive(venue: "binance" | "upbit") {
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

export const CT_COST_PROFILES: Record<string, CTCostProfile> = {
  "binance-spot-usdt": {
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
  },
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

export const CT_DEFAULT_PROFILE: Record<CTMarket, string> = { crypto: "binance-spot-usdt", stock: "toss-us-equity" };

export type CTProfileCosts = {
  costs: CTContract["costs"];
  costProfile: { id: string; version: number };
  provisional: boolean;
  notes: string[];
};

/**
 * The contract costs for a research run: the worst measured spread and slippage over the chosen
 * symbols at the order size the capital implies.
 */
export function ctProfileCosts(market: CTMarket, symbols: string[], capital: number, profileId = CT_DEFAULT_PROFILE[market]): CTProfileCosts {
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
  return {
    costs: {
      feePct: profile.market === "stock" ? feePerSidePct() : profile.feePct,
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
export function ctCostProfileText(contract: Pick<CTContract, "costs" | "costProfile">, roundTripPct: number) {
  if (!contract.costProfile) return `저장된 비용(프로필 이전 계약) · 왕복 ${roundTripPct.toFixed(3)}%`;
  const profile = CT_COST_PROFILES[contract.costProfile.id];
  const label = profile ? profile.label : contract.costProfile.id;
  return `${label} 프로필 v${contract.costProfile.version}${profile?.provisional ? " (잠정)" : ""} · 왕복 ${roundTripPct.toFixed(3)}%`;
}

/** Round-trip cost, percent, by the replay's own fill and fee formulas (identical to ctRoundTripCostPct). Pure, safe for screens. */
export function ctCostsRoundTripPct(costs: CTContract["costs"], multiplier = 1) {
  const impact = ((costs.spreadPct / 2 + costs.slippagePct) * multiplier) / 100,
    buyFee = (costs.feePct * multiplier) / 100,
    sellFee = ((costs.feePct + costs.sellTaxPct) * multiplier) / 100;
  return -(((1 - impact) * (1 - sellFee)) / ((1 + impact) * (1 + buyFee)) - 1) * 100;
}
/** What a research start would be priced with, for the screen before the run exists. */
export function ctCostPreview(market: CTMarket, capital = 1000) {
  const symbols = market === "crypto" ? Object.keys(CT_COST_PROFILES[CT_DEFAULT_PROFILE.crypto].symbols) : [];
  const per = (market === "crypto" ? symbols : [""]).map((symbol) => {
    const priced = ctProfileCosts(market, symbol ? [symbol] : [], capital);
    return { symbol, roundTripPct: Number(ctCostsRoundTripPct(priced.costs).toFixed(4)), provisional: priced.provisional, profile: priced.costProfile, notes: priced.notes };
  });
  const profile = CT_COST_PROFILES[per[0].profile.id];
  return { label: profile.label, version: profile.version, provisional: profile.provisional, feeVerified: profile.feeVerified, perSymbol: per };
}
