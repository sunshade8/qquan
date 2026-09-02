import { asc, count, desc, eq, min, sum } from "drizzle-orm";
import { getDb } from "@/db";
import { llmUsage } from "@/db/schema";
import { CLAUDE_PRICING_EFFECTIVE, CLAUDE_PRICING_SOURCE, modelPrice } from "@/lib/llm-usage";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";

export async function GET(request: Request) {
  const ownerId = researchOwnerFrom(request);
  try {
    const db = getDb();
    const [totals] = await db.select({
      calls: count(), inputTokens: sum(llmUsage.inputTokens), outputTokens: sum(llmUsage.outputTokens),
      cacheCreationInputTokens: sum(llmUsage.cacheCreationInputTokens), cacheReadInputTokens: sum(llmUsage.cacheReadInputTokens),
      costUsd: sum(llmUsage.costUsd), trackingSince: min(llmUsage.createdAt),
    }).from(llmUsage).where(eq(llmUsage.ownerId, ownerId));
    const [models, features, recent, first] = await Promise.all([
      db.select({ model: llmUsage.model, calls: count(), inputTokens: sum(llmUsage.inputTokens), outputTokens: sum(llmUsage.outputTokens), costUsd: sum(llmUsage.costUsd) })
        .from(llmUsage).where(eq(llmUsage.ownerId, ownerId)).groupBy(llmUsage.model).orderBy(desc(sum(llmUsage.costUsd))),
      db.select({ feature: llmUsage.feature, calls: count(), costUsd: sum(llmUsage.costUsd) })
        .from(llmUsage).where(eq(llmUsage.ownerId, ownerId)).groupBy(llmUsage.feature).orderBy(desc(sum(llmUsage.costUsd))),
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
      note: "이 앱 버전에서 기록된 실제 API usage부터 누적됩니다. 공급자 콘솔의 과거 청구액은 소급 추정하지 않습니다.",
    }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch {
    return Response.json({ error: "LLM 사용량 기록을 불러오지 못했습니다." }, { status: 503, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}
