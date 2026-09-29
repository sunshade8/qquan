/**
 * One clock for every Massive call in the isolate.
 *
 * The plan allows five requests a minute across *all* endpoints, so two callers
 * each pacing themselves correctly still produce ten calls a minute together.
 * The relay bar loader and the surge market-history loader therefore share this
 * module-level gate rather than keeping a timestamp each.
 */

import { massiveRateLimitPerMinute } from "./massive.ts";

let lastCallAt = 0;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function massiveSpacingMs() {
  // A little slack on top of the exact share; the limiter counts arrival, not intent.
  return Math.ceil(60_000 / Math.max(1, massiveRateLimitPerMinute())) + 500;
}

/** Waits until the next call is allowed, reporting the wait so a UI can say why it is idle. */
export async function paceMassive(label: string, onProgress: (message: string) => void = () => undefined) {
  const wait = lastCallAt + massiveSpacingMs() - Date.now();
  if (wait > 0) {
    onProgress(`Massive 호출 한도(분당 ${massiveRateLimitPerMinute()}회) 대기 ${Math.ceil(wait / 1000)}초 — ${label}`);
    await sleep(wait);
  }
  lastCallAt = Date.now();
}

export function noteMassiveCall() {
  lastCallAt = Date.now();
}
