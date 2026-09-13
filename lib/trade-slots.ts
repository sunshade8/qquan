/**
 * The intraday relay: a day divided into slots, each owning the whole account
 * for its window.
 *
 * This replaces the parallel-portfolio shape the board had before, and the
 * reason is arithmetic rather than taste. Splitting $1,000 across twelve
 * concurrent positions divides every edge by twelve — a rule worth +0.85% per
 * trade moves the account +0.07%. Running the same $1,000 through three or four
 * *sequential* windows instead lets each rule trade the full balance, so a
 * measured edge arrives at the account undiluted. Slots never overlap, so they
 * cannot compete for capital.
 *
 * Windows are defined in New York time because that is where the sessions are.
 * The Korean clock shifts with US daylight saving, so it is derived rather than
 * written down.
 */

export type SessionId = "premarket" | "regular" | "aftermarket";

export type SlotId =
  | "premarket_early" | "premarket_late"
  | "open" | "trend" | "midday" | "afternoon" | "close"
  | "after_early" | "after_late";

export type Slot = {
  id: SlotId;
  label: string;
  session: SessionId;
  /** Inclusive ET start and exclusive ET end, "HH:MM". */
  from: string;
  to: string;
  /** What this window is structurally, and why a rule would live here. */
  rationale: string;
  /**
   * Depth relative to the regular session. Extended-hours books are thinner, so
   * a rule that works at 10:00 does not automatically work at 05:00 — the same
   * signal pays a wider spread and moves the price more.
   */
  liquidity: "high" | "medium" | "low";
};

/**
 * Toss trades US stocks in four sessions (data market 20:00-04:00 ET, pre
 * 04:00-09:30, regular 09:30-16:00, after 16:00-19:50 ET), which is very nearly
 * a 24-hour day. Only the last three are represented here: Massive's minute bars
 * run 04:00-19:55 ET, so the overnight session can be traded but cannot be
 * backtested, and a slot that cannot be measured has no business holding the
 * account's money. See `UNBACKTESTABLE_SESSION`.
 */
export const SLOTS: Slot[] = [
  { id: "premarket_early", label: "프리 전반", session: "premarket", from: "04:00", to: "07:00", liquidity: "low", rationale: "유럽 시간대. 유럽發 뉴스와 밤사이 갭이 처음 가격에 반영되지만 호가가 가장 얇다." },
  { id: "premarket_late", label: "프리 후반", session: "premarket", from: "07:00", to: "09:30", liquidity: "medium", rationale: "미국 참여자가 들어오며 갭이 확정된다. 실적·경제지표가 여기서 소화된다." },
  { id: "open", label: "개장", session: "regular", from: "09:30", to: "10:00", liquidity: "high", rationale: "밤사이 주문이 한꺼번에 쏟아지는 구간. 갭 해소와 시가 레인지 형성이 여기서 끝난다." },
  { id: "trend", label: "추세", session: "regular", from: "10:00", to: "11:30", liquidity: "high", rationale: "개장 물량이 소화되고 그날의 방향이 정해지는 구간. 선행-추종이 관측된다면 여기다." },
  { id: "midday", label: "점심 압축", session: "regular", from: "11:30", to: "13:30", liquidity: "medium", rationale: "유동성 최저. 대개 쉬는 구간이고, 압축 자체가 오후 확장의 신호가 된다." },
  { id: "afternoon", label: "오후", session: "regular", from: "13:30", to: "15:30", liquidity: "high", rationale: "기관 물량이 다시 들어오며 오전 방향이 확장되거나 뒤집힌다." },
  { id: "close", label: "마감", session: "regular", from: "15:30", to: "16:00", liquidity: "high", rationale: "종가에 맞춰야 하는 강제 플로우가 몰리는 구간. 방향이 미리 계산되는 경우가 있다." },
  { id: "after_early", label: "애프터 전반", session: "aftermarket", from: "16:00", to: "17:30", liquidity: "medium", rationale: "장후 실적 발표가 터지는 구간. 반응의 첫 30분이 여기 들어온다." },
  { id: "after_late", label: "애프터 후반", session: "aftermarket", from: "17:30", to: "19:55", liquidity: "low", rationale: "반응이 소화되고 호가가 다시 얇아진다. 되돌림이 관측되는 구간." },
];

/** Tradable at Toss, deliberately not a slot: no minute bars exist to test it on. */
export const UNBACKTESTABLE_SESSION = {
  label: "데이마켓 (한국 주간)",
  kst: "09:00–17:00",
  et: "20:00–04:00",
  reason: "토스는 이 시간대에도 미국주식을 체결하지만 Massive 분봉이 04:00–19:55 ET만 제공해 검증할 방법이 없습니다.",
};

/**
 * Order-type acceptance windows, measured against the live API on 2026-09-09.
 *
 * A plain limit order is accepted outside regular hours — an after-market buy
 * came back `insufficient-buying-power`, meaning the hours check had already
 * passed. `LIMIT + CLS` (limit-on-close) is not: it returns `order-hours-closed`
 * with a `retryAfterAt` of 09:00 KST. So a rule that wants to fill at the close
 * has to be submitted inside that window, and a rule running in extended hours
 * must use a plain limit.
 */
export const ORDER_TYPE_NOTES = {
  limitDay: "정규장 밖에서도 접수됨 (2026-09-09 애프터마켓 실측)",
  limitOnClose: "접수 창 별도. 09:00 KST부터 열림 (order-hours-closed 의 retryAfterAt)",
  amountOrder: "정규장 시작 ~ 종료 1시간 전만",
} as const;

export function slotById(id: string) {
  return SLOTS.find((slot) => slot.id === id) ?? null;
}

/** The slot's window in Seoul time for the given date, DST included. */
export function slotWindowKst(slot: Slot, date: string) {
  const toKst = (etTime: string) => {
    const [hour, minute] = etTime.split(":").map(Number);
    // Interpret the wall-clock time in New York on that date, then read it in Seoul.
    const guess = new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
    const offsetMinutes = (() => {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" }).formatToParts(guess);
      const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT-5";
      const match = name.match(/GMT([+-])(\d{2}):(\d{2})/);
      if (!match) return -300;
      const sign = match[1] === "-" ? -1 : 1;
      return sign * (Number(match[2]) * 60 + Number(match[3]));
    })();
    const utc = new Date(guess.getTime() - offsetMinutes * 60_000);
    return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(utc);
  };
  return { from: toKst(slot.from), to: toKst(slot.to) };
}

// ------------------------------------------------------- tradable instruments

/**
 * Leveraged and inverse funds, which this account does not trade.
 *
 * Kept as an explicit list rather than a naming heuristic because the cost of a
 * false negative is placing a real order in a product the owner has ruled out.
 * `assertTradable` is called when a strategy is registered, so a banned ticker
 * fails at startup rather than at 4am in front of the broker.
 */
export const EXCLUDED_INSTRUMENTS = new Set([
  "TQQQ", "SQQQ", "QLD", "QID", "PSQ",
  "UPRO", "SPXL", "SPXU", "SPXS", "SSO", "SDS", "SH",
  "SOXL", "SOXS", "USD", "SSG",
  "TNA", "TZA", "URTY", "SRTY",
  "FAS", "FAZ", "LABU", "LABD", "NUGT", "DUST", "JNUG", "JDST",
  "YINN", "YANG", "TMF", "TMV", "UDOW", "SDOW", "DOG",
  "UVXY", "SVXY", "VIXY", "UVIX", "SVIX", "TQQY",
  "BOIL", "KOLD", "UCO", "SCO", "AGQ", "ZSL", "UGL", "GLL",
  "NVDL", "TSLL", "TSLQ", "CONL", "MSTU", "MSTZ", "AMDL", "FNGU", "FNGD",
]);

export function isExcludedInstrument(symbol: string) {
  return EXCLUDED_INSTRUMENTS.has(symbol.toUpperCase());
}

export function assertTradable(symbols: string[], context: string) {
  const banned = symbols.filter(isExcludedInstrument);
  if (banned.length) {
    throw new Error(`${context}: 레버리지·인버스 상품은 거래하지 않습니다 — ${banned.join(", ")}`);
  }
}
