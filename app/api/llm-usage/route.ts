import { asc, count, desc, eq, max, min, sum } from "drizzle-orm";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { llmUsage } from "@/db/schema";
import { modelAllocation } from "@/lib/claude";
import { CLAUDE_PRICING_EFFECTIVE, CLAUDE_PRICING_SOURCE, modelPrice } from "@/lib/llm-usage";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";

export async function GET(request: Request) {
  const ownerId = researchOwnerFrom(request);
  try {
    await ensureSchema();
    const db = getDb();
    const [totals] = await db.select({
      calls: count(), inputTokens: sum(llmUsage.inputTokens), outputTokens: sum(llmUsage.outputTokens),
      cacheCreationInputTokens: sum(llmUsage.cacheCreationInputTokens), cacheReadInputTokens: sum(llmUsage.cacheReadInputTokens),
      costUsd: sum(llmUsage.costUsd), trackingSince: min(llmUsage.createdAt),
    }).from(llmUsage).where(eq(llmUsage.ownerId, ownerId));
    const [models, features, roles, recent, first] = await Promise.all([
      db.select({ model: llmUsage.model, calls: count(), inputTokens: sum(llmUsage.inputTokens), outputTokens: sum(llmUsage.outputTokens), costUsd: sum(llmUsage.costUsd) })
        .from(llmUsage).where(eq(llmUsage.ownerId, ownerId)).groupBy(llmUsage.model).orderBy(desc(sum(llmUsage.costUsd))),
      db.select({ feature: llmUsage.feature, calls: count(), costUsd: sum(llmUsage.costUsd) })
        .from(llmUsage).where(eq(llmUsage.ownerId, ownerId)).groupBy(llmUsage.feature).orderBy(desc(sum(llmUsage.costUsd))),
      db.select({ role: llmUsage.role, calls: count(), inputTokens: sum(llmUsage.inputTokens), outputTokens: sum(llmUsage.outputTokens), costUsd: sum(llmUsage.costUsd), lastUsedAt: max(llmUsage.createdAt) })
        .from(llmUsage).where(eq(llmUsage.ownerId, ownerId)).groupBy(llmUsage.role),
      db.select().from(llmUsage).where(eq(llmUsage.ownerId, ownerId)).orderBy(desc(llmUsage.createdAt)).limit(12),
      db.select({ createdAt: llmUsage.createdAt }).from(llmUsage).where(eq(llmUsage.ownerId, ownerId)).orderBy(asc(llmUsage.createdAt)).limit(1),
    ]);
    return Response.json({
      totals: {
        calls: Number(totals?.calls) || 0, inputTokens: Number(totals?.inputTokens) || 0, outputTokens: Number(totals?.outputTokens) || 0,
        cacheCreationInputTokens: Number(totals?.cacheCreationInputTokens) || 0, cacheReadInputTokens: Number(totals?.cacheReadInputTokens) || 0,
        costUsd: Number(totals?.costUsd) || 0, trackingSince: first[0]?.createdAt ?? totals?.trackingSince ?? null,
      },
      models: models.map((row) => ({ ...row, calls: Number(row.calls) || 0, inputTokens: Number(row.inputTokens) || 0, outputTokens: Number(row.outputTokens) || 0, costUsd: Number(row.costUsd) || 0, price: modelPrice(row.model) })),
      features: features.map((row) => ({ ...row, calls: Number(row.calls) || 0, costUsd: Number(row.costUsd) || 0 })),
      recent,
      pricing: { currency: "USD", unit: "1M tokens", effectiveDate: CLAUDE_PRICING_EFFECTIVE, sourceUrl: CLAUDE_PRICING_SOURCE },
      // The allocation table is what each role *would* use; joining real usage is
      // what stops it reading as a promise. A role with 0 calls is a role no code
      // path reaches, and the screen should say so rather than imply it is active.
      allocation: modelAllocation().map((item) => {
        const actual = roles.find((row) => row.role === item.role);
        return {
          ...item, price: modelPrice(item.model),
          calls: Number(actual?.calls) || 0,
          costUsd: Number(actual?.costUsd) || 0,
          inputTokens: Number(actual?.inputTokens) || 0,
          outputTokens: Number(actual?.outputTokens) || 0,
          lastUsedAt: actual?.lastUsedAt ?? null,
        };
      }),
      unattributed: {
        calls: Number(roles.find((row) => !row.role)?.calls) || 0,
        costUsd: Number(roles.find((row) => !row.role)?.costUsd) || 0,
      },
      note: "이 앱 버전에서 기록된 실제 API usage부터 누적됩니다. 공급자 콘솔의 과거 청구액은 소급 추정하지 않습니다. 역할별 호출 수는 role 기록이 추가된 이후부터 집계됩니다.",
    }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch {
    return Response.json({ error: "LLM 사용량 기록을 불러오지 못했습니다.", allocation: modelAllocation().map((item) => ({ ...item, price: modelPrice(item.model), calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: null })) }, { status: 503, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}
