/**
 * Intraday rules assigned to relay slots.
 *
 * Empty until something clears an account-level backtest. A rule earns a place
 * here by showing what the *account* did day by day — including the days it did
 * not trade and the days it lost — not by averaging well across its own trades.
 */

import type { SlotStrategy } from "./relay-engine.ts";
import { assertTradable } from "./trade-slots.ts";

export const RELAY_STRATEGIES: SlotStrategy[] = [];

for (const strategy of RELAY_STRATEGIES) assertTradable(strategy.universe, strategy.name);
