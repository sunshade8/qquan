/** Only operational failures are retried. Validation failures remain evidence. */
export function researchFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = Number((error as { status?: number } | null)?.status) || Number(message.match(/(?:\(|\b)(429|5\d\d)\b/)?.[1]);
  const storage = /D1_|D1 DB|database.*(?:overload|timeout|locked)|SQLITE_BUSY/i.test(message);
  const transient = storage || status === 408 || status === 429 || status >= 500 || /timeout|timed out|overloaded|fetch failed|connection|연결하지 못|ECONN|중단되었습니다|실행이 중단/i.test(message);
  const actionable = [400, 401, 402, 403, 404].includes(status) || /API.*키|credit balance|잔액|크레딧|인증/i.test(message);
  return { message, status, storage, transient, recoverable: transient || actionable };
}
export function uncertainResearchCost(calls: Array<{ uncertainUsd?: number }> = []) {
  return calls.reduce((total, call) => total + (call.uncertainUsd ?? 0), 0);
}
/** D1 operations here are idempotent reads, lease updates or deterministic upserts. */
export async function retryResearchStorage<T>(operation: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!researchFailure(error).storage || attempt >= 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 300 * 2 ** attempt + Math.random() * 200));
    }
  }
}
