export type IntradayClosePoint = { timestamp: number; date: string; time: string; close: number };

export type IntradayReaction = {
  baseTime: string;
  basePrice: number;
  preTime: string | null;
  preReturnPct: number | null;
  postTime: string | null;
  postReturnPct: number | null;
  toRegularClosePct: number | null;
  normalizedPath: Array<{ offsetMinutes: number; time: string; value: number }>;
};

export type IntradayStudyRow = {
  symbol: string;
  surprise: string;
  reaction: IntradayReaction | null;
};

function timeMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function percent(from: number, to: number) {
  return Number((((to / from) - 1) * 100).toFixed(4));
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value: number | null) {
  return value === null ? null : Number(value.toFixed(4));
}

function atOrBefore(points: IntradayClosePoint[], targetMinute: number, intervalMinutes: number) {
  let match: IntradayClosePoint | null = null;
  for (const point of points) {
    const closeMinute = timeMinutes(point.time) + intervalMinutes;
    if (closeMinute <= targetMinute) match = point;
  }
  return match;
}

/**
 * Calculates returns on closed bar boundaries, so an event at 10:00 ET uses
 * the 09:55–10:00 close as its unpolluted base when intervalMinutes is 5.
 */
export function calculateIntradayReaction(
  points: IntradayClosePoint[],
  eventDate: string,
  eventTime: string,
  intervalMinutes: number,
  preMinutes = 30,
  postMinutes = 30,
): IntradayReaction | null {
  const session = points.filter((point) => point.date === eventDate).sort((left, right) => left.timestamp - right.timestamp);
  const anchorMinute = timeMinutes(eventTime);
  const base = atOrBefore(session, anchorMinute, intervalMinutes);
  if (!base) return null;
  const baseCloseMinute = timeMinutes(base.time) + intervalMinutes;
  if (anchorMinute - baseCloseMinute > intervalMinutes) return null;
  const pre = atOrBefore(session, anchorMinute - preMinutes, intervalMinutes);
  const post = atOrBefore(session, anchorMinute + postMinutes, intervalMinutes);
  const regularClose = atOrBefore(session, 16 * 60, intervalMinutes);
  return {
    baseTime: eventTime,
    basePrice: base.close,
    preTime: pre ? `${pre.time}+${intervalMinutes}m` : null,
    preReturnPct: pre ? percent(pre.close, base.close) : null,
    postTime: post && post.timestamp > base.timestamp ? `${post.time}+${intervalMinutes}m` : null,
    postReturnPct: post && post.timestamp > base.timestamp ? percent(base.close, post.close) : null,
    toRegularClosePct: regularClose && regularClose.timestamp > base.timestamp ? percent(base.close, regularClose.close) : null,
    normalizedPath: session.flatMap((point) => {
      const offsetMinutes = timeMinutes(point.time) + intervalMinutes - anchorMinute;
      if (offsetMinutes < -120 || offsetMinutes > 450) return [];
      return [{ offsetMinutes, time: point.time, value: Number(((point.close / base.close) * 100).toFixed(4)) }];
    }),
  };
}

export function summarizeIntradayStudy(rows: IntradayStudyRow[]) {
  const keys = [...new Set(rows.flatMap((row) => row.reaction ? [`${row.symbol}\u0000all`, `${row.symbol}\u0000${row.surprise || "unknown"}`] : []))];
  return keys.map((key) => {
    const [symbol, surprise] = key.split("\u0000");
    const selected = rows.filter((row) => row.reaction && row.symbol === symbol && (surprise === "all" || (row.surprise || "unknown") === surprise));
    const pre = selected.flatMap((row) => row.reaction?.preReturnPct === null || row.reaction?.preReturnPct === undefined ? [] : [row.reaction.preReturnPct]);
    const post = selected.flatMap((row) => row.reaction?.postReturnPct === null || row.reaction?.postReturnPct === undefined ? [] : [row.reaction.postReturnPct]);
    const close = selected.flatMap((row) => row.reaction?.toRegularClosePct === null || row.reaction?.toRegularClosePct === undefined ? [] : [row.reaction.toRegularClosePct]);
    return {
      symbol,
      surprise,
      samples: selected.length,
      preAveragePct: round(average(pre)),
      preMedianPct: round(median(pre)),
      postAveragePct: round(average(post)),
      postMedianPct: round(median(post)),
      postPositiveRatePct: post.length ? round((post.filter((value) => value > 0).length / post.length) * 100) : null,
      toCloseAveragePct: round(average(close)),
    };
  });
}
