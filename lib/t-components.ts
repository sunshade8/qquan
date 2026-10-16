import { ctDataAt, ctDate, ctDayEndMs, type CTBar } from "./t-engine.ts";
import { ctQueryEvents } from "./t-design-tools.ts";
import { ctRng } from "./t-trader-tools.ts";
import type { CTContract, CTSpec } from "./t-spec.ts";
import type { CTCandidate } from "./t-research.ts";
export type CTComponentMeasurement = {
  events: number;
  days: number;
  differencePct: number;
  p: number;
  months: number;
  positiveMonthPct: number;
  top5Pct: number | null;
  entries: number[];
  reasons: string[];
};
export type CTComponentRecord = {
  id: string;
  hash: string;
  candidate: CTCandidate;
  whyNotAlone: string;
  session: number;
  training?: CTComponentMeasurement;
  development?: CTComponentMeasurement;
  duplicateOf?: string;
  grade:
    | "pending"
    | "training_failed"
    | "component_passed"
    | "component_dev_failed";
};
export function ctMeasureComponent(
  spec: CTSpec,
  raw: Record<string, CTBar[]>,
  c: CTContract,
  from: number,
  to: number,
): CTComponentMeasurement {
  const view = { ...c, fromMs: from, trainingToMs: to },
    data = ctDataAt(raw, spec.minutes),
    h = spec.exit.maxHoldBars;
  const query = {
    barMinutes: spec.minutes,
    stages: spec.stages,
    horizons: [h],
    grid: null,
    cooldownBars: spec.sizing.cooldownBars,
    ...(spec.entry.entryWindows
      ? { entryWindows: spec.entry.entryWindows }
      : {}),
  };
  const { events } = ctQueryEvents(query, raw, view),
    baseline = new Map<string, number[]>();
  const contiguous = new Map<CTBar[],Int32Array>();
  const outcome = (rows: CTBar[], e: number) => {
    if(!rows[e])return null;
    let runs=contiguous.get(rows);
    if(!runs){runs=new Int32Array(rows.length);for(let i=rows.length-1;i>=0;i--)runs[i]=i+1<rows.length&&rows[i+1].startMs===rows[i].endMs?runs[i+1]:i;contiguous.set(rows,runs);}
    const end=ctDayEndMs(c.market,rows[e].startMs),cutoff=Math.min(to,(end??Infinity)-1);
    let lo=e,hi=rows.length;while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid].endMs<=cutoff)lo=mid+1;else hi=mid;}
    const j=Math.min(e+h-1,runs[e],lo-1);
    if(j<e||j!==e+h-1&&rows[j].endMs<(end??Infinity)-spec.minutes*60000)return null;
    return (rows[j].close/rows[e].open-1)*100;
  };
  const bucket = (symbol: string, t: number) =>
    `${symbol}:${Math.floor((t - (ctDayEndMs(c.market, t) ?? 0) + 86400000) / 3600000)}`;
  for (const symbol of spec.symbols) {
    const rows = data[symbol] ?? [];
    for (let e = 1; e < rows.length; e++) {
      if (rows[e].startMs < from || rows[e].endMs > to) continue;
      const r = outcome(rows, e);
      if (r === null) continue;
      const key = bucket(symbol, rows[e].startMs),
        xs = baseline.get(key) ?? [];
      xs.push(r);
      baseline.set(key, xs);
    }
  }
  const avg = (xs: number[]) =>
      xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length),
    daily = new Map<string, { n: number; diff: number; gross: number }>(),
    monthly = new Map<string, number[]>(),
    entries: number[] = [];
  const baselineMean=new Map([...baseline].map(([k,xs])=>[k,avg(xs)]));
  for (const ev of events) {
    const r = outcome(data[ev.symbol], ev.e),
      base = baseline.get(bucket(ev.symbol, ev.entryStart));
    if (r === null || !base?.length) continue;
    const diff = r - baselineMean.get(bucket(ev.symbol,ev.entryStart))!,
      date = ctDate(ev.entryStart, c.market),
      d = daily.get(date) ?? { n: 0, diff: 0, gross: 0 };
    d.n++;
    d.diff += diff;
    d.gross += r;
    daily.set(date, d);
    const month = date.slice(0, 7),
      xs = monthly.get(month) ?? [];
    xs.push(diff);
    monthly.set(month, xs);
    entries.push(ev.entryStart);
  }
  const clusters = [...daily.values()],
    total = clusters.reduce((s, d) => s + d.n, 0),
    differencePct =
      clusters.reduce((s, d) => s + d.diff, 0) / Math.max(1, total),
    rng = ctRng(20261016);
  let extreme = 0;
  for (let b = 0; b < 4000; b++) {
    let sum = 0,
      n = 0;
    for (let j = 0; j < clusters.length; j++) {
      const d = clusters[Math.floor(rng() * clusters.length)];
      sum += d.diff - d.n * differencePct;
      n += d.n;
    }
    if (sum / Math.max(1, n) >= differencePct) extreme++;
  }
  const p = (extreme + 1) / 4001,
    positive = clusters.map((d) => Math.max(0, d.gross)).sort((a, b) => b - a),
    den = positive.reduce((a, b) => a + b, 0),
    top5Pct =
      den > 0
        ? (positive.slice(0, 5).reduce((a, b) => a + b, 0) / den) * 100
        : null,
    positiveMonthPct =
      ([...monthly.values()].filter((xs) => avg(xs) > 0).length /
        Math.max(1, monthly.size)) *
      100;
  const reasons = [
    total < 60 ? "이벤트 60개 미만" : null,
    daily.size < 30 ? "일수 30일 미만" : null,
    differencePct <= 0 ? "기준선 대비 차이 미달" : null,
    p > 0.05 ? "군집 p 기준 미달" : null,
    monthly.size < 2 ? "월 표본 부족" : null,
    positiveMonthPct < 60 ? "양수 월 60% 미만" : null,
    top5Pct === null || top5Pct > 40 ? "상위 5일 집중 초과" : null,
  ].filter((x): x is string => !!x);
  return {
    events: total,
    days: daily.size,
    differencePct,
    p,
    months: monthly.size,
    positiveMonthPct,
    top5Pct,
    entries,
    reasons,
  };
}
export function ctDeduplicateComponents(rows: CTComponentRecord[]) {
  const ordered = [...rows]
      .filter((r) => r.training && !r.training.reasons.length)
      .sort(
        (a, b) =>
          a.training!.p - b.training!.p ||
          a.candidate.spec.stages.length - b.candidate.spec.stages.length ||
          a.hash.localeCompare(b.hash),
      ),
    kept: CTComponentRecord[] = [];
  for (const r of ordered) {
    const events = new Set(r.training!.entries),
      duplicate = kept.find(
        (k) =>
          k.training!.entries.filter((t) => events.has(t)).length /
            Math.max(1, Math.min(events.size, k.training!.entries.length)) >
          0.7,
      );
    if (duplicate) r.duplicateOf = duplicate.id;
    else kept.push(r);
  }
  return kept;
}
