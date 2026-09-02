export type LabPriceRow = { date: string; close: number };

export type ResolvedAsset = {
  input: string;
  name: string;
  symbol: string | null;
  public: boolean;
  note: string | null;
};

const aliases: Array<{ pattern: RegExp; name: string; symbol: string | null; note?: string }> = [
  { pattern: /^(?:rocket\s*lab|rklb)$/i, name: "Rocket Lab", symbol: "RKLB" },
  { pattern: /^(?:ast\s*spacemobile|asts)$/i, name: "AST SpaceMobile", symbol: "ASTS" },
  { pattern: /^(?:space\s*x)$/i, name: "SpaceX", symbol: null, note: "SpaceX는 비상장사라 검증 가능한 공개 주가 시계열이 없습니다." },
  { pattern: /^(?:tesla|tsla)$/i, name: "Tesla", symbol: "TSLA" },
  { pattern: /^(?:nvidia|nvda)$/i, name: "NVIDIA", symbol: "NVDA" },
  { pattern: /^(?:apple|aapl)$/i, name: "Apple", symbol: "AAPL" },
  { pattern: /^(?:microsoft|msft)$/i, name: "Microsoft", symbol: "MSFT" },
  { pattern: /^(?:amazon|amzn)$/i, name: "Amazon", symbol: "AMZN" },
  { pattern: /^(?:meta|meta platforms)$/i, name: "Meta Platforms", symbol: "META" },
];

export function resolveAsset(input: string): ResolvedAsset {
  const clean = input.trim();
  const known = aliases.find((item) => item.pattern.test(clean));
  if (known) return { input: clean, name: known.name, symbol: known.symbol, public: Boolean(known.symbol), note: known.note ?? null };
  const symbol = clean.toUpperCase().replace(/[^A-Z0-9.^-]/g, "").slice(0, 12);
  return {
    input: clean,
    name: symbol || clean,
    symbol: symbol || null,
    public: Boolean(symbol),
    note: symbol ? null : "종목명 또는 티커를 확인할 수 없습니다.",
  };
}

function correlation(left: number[], right: number[]) {
  if (left.length !== right.length || left.length < 3) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator ? covariance / denominator : null;
}

export function compareAlignedSeries(leftRows: LabPriceRow[], rightRows: LabPriceRow[]) {
  const rightByDate = new Map(rightRows.map((row) => [row.date, row.close]));
  const aligned = leftRows.flatMap((left) => {
    const right = rightByDate.get(left.date);
    return right === undefined ? [] : [{ date: left.date, left: left.close, right }];
  });
  if (aligned.length < 3) return { points: [], sessions: aligned.length, returnCorrelation: null, pathCorrelation: null, leftReturnPct: null, rightReturnPct: null };
  const leftBase = aligned[0].left;
  const rightBase = aligned[0].right;
  const points = aligned.map((row) => ({
    date: row.date,
    left: Number(((row.left / leftBase) * 100).toFixed(3)),
    right: Number(((row.right / rightBase) * 100).toFixed(3)),
  }));
  const leftReturns = aligned.slice(1).map((row, index) => (row.left / aligned[index].left) - 1);
  const rightReturns = aligned.slice(1).map((row, index) => (row.right / aligned[index].right) - 1);
  return {
    points,
    sessions: aligned.length,
    returnCorrelation: correlation(leftReturns, rightReturns),
    pathCorrelation: correlation(points.map((point) => point.left), points.map((point) => point.right)),
    leftReturnPct: ((aligned.at(-1)!.left / leftBase) - 1) * 100,
    rightReturnPct: ((aligned.at(-1)!.right / rightBase) - 1) * 100,
  };
}

export function findLargestDrawdowns(rows: LabPriceRow[], count = 3) {
  return rows.slice(1).map((row, index) => ({
    date: row.date,
    close: row.close,
    priorClose: rows[index].close,
    returnPct: ((row.close / rows[index].close) - 1) * 100,
  })).filter((row) => row.returnPct < 0).sort((left, right) => left.returnPct - right.returnPct).slice(0, Math.max(1, count));
}
