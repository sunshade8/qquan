/**
 * Upbit is switched off (docs/prompts/binance-only-limit-orders.md, owner decision 2026-10-17): every coin
 * run, data job, measurement, paper run and live order is Binance. Nothing was deleted; this one flag keeps the
 * old paths reachable. `QQUAN_ENABLE_UPBIT=true` restores the previous behaviour.
 *
 * What stays readable with the flag OFF: past Upbit research records, trade records, registered packages, the
 * `upbit-krw` cost profile and the costs stored in old contracts, and the close-out / lookup paths of an Upbit
 * position that is still open. What the flag stops: starting a new Upbit paper or live run, showing Upbit packages
 * in the 전략 tab, Upbit in the order-book sampler and the ceiling measurement defaults.
 *
 * Pure (no `cloudflare:workers`): reads `process.env`, so it works in Node scripts, tests and the local runtime.
 * The hosted worker holds no Upbit keys and so reads "off".
 */
export function upbitEnabled(read: (key: string) => string | undefined = (key) => process.env[key]): boolean {
  return read("QQUAN_ENABLE_UPBIT") === "true";
}

export const UPBIT_OFF_MESSAGE = "Upbit은 비활성입니다(Binance 기준). 다시 켜려면 QQUAN_ENABLE_UPBIT=true";

/** A contract/package priced in KRW is an Upbit one; every new coin contract is USDT (Binance). */
export const isUpbitContract = (contract: { currency: string }) => contract.currency === "KRW";

/** Throws for a NEW Upbit start while the flag is off. Reading, closing and replaying old records never calls this. */
export function assertUpbitStartAllowed(contract: { currency: string }, enabled = upbitEnabled()) {
  if (isUpbitContract(contract) && !enabled) throw new Error(UPBIT_OFF_MESSAGE);
}
