"use client";

import { useMemo } from "react";
import { SentimentMarketPanel, type SentimentMarketRow } from "./news-sentiment-market";

type BenchmarkLike = { returnPct?: number } | { unavailable?: string } | null;
type TestLike = {
  id: string; periodStart: string; periodEnd: string; overallScore: number; techScore: number; valueScore: number;
  nasdaq: BenchmarkLike; nyse: BenchmarkLike; forecastEvents?: Array<{ indicator: string }>;
};

function returnOf(value: BenchmarkLike) {
  return value && "returnPct" in value && typeof value.returnPct === "number" ? value.returnPct : null;
}

export function NewsSentimentPanelBridge({ tests, onAsk }: { tests: TestLike[]; onAsk?: (prompt: string) => void }) {
  const rows = useMemo<SentimentMarketRow[]>(() => {
    const seen = new Set<string>();
    return [...tests].reverse().filter((test) => {
      const key = `${test.periodStart}:${test.periodEnd}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((test) => ({
      id: test.id, periodStart: test.periodStart, periodEnd: test.periodEnd, label: test.forecastEvents?.[0]?.indicator ?? null,
      sentiment: test.overallScore, techScore: test.techScore, valueScore: test.valueScore, nasdaqReturnPct: returnOf(test.nasdaq), nyseReturnPct: returnOf(test.nyse),
    }));
  }, [tests]);
  return <SentimentMarketPanel rows={rows} onAsk={onAsk} />;
}
