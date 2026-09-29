/** Previously acquired historical dates are reusable, including partial months. */
export function missingIntradayRange(
  from: string,
  to: string,
  cached?: { fromDate: string; toDate: string },
): { from: string; to: string } | null {
  if (!cached) return { from, to };
  if (cached.fromDate <= from && cached.toDate >= to) return null;
  const shift = (date: string, days: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  if (cached.fromDate <= from && cached.toDate >= shift(from, -1))
    return { from: shift(cached.toDate, 1), to };
  if (cached.toDate >= to && cached.fromDate <= shift(to, 1))
    return { from, to: shift(cached.fromDate, -1) };
  // Fill any gap before merging coverage into a single contiguous interval.
  return { from: from < cached.fromDate ? from : cached.fromDate,
    to: to > cached.toDate ? to : cached.toDate };
}
