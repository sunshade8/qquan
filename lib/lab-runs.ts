import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { labAgentRuns } from "@/db/schema";
import type { LabAgentPhase } from "@/lib/lab-types";

export type LabRunStatus = "running" | "complete" | "failed";
export type LabRunProgress = {
  id: string;
  conversationId: string;
  phase: LabAgentPhase;
  label: string;
  detail: string;
  status: LabRunStatus;
  updatedAt: string;
};

export async function writeLabRunProgress(ownerId: string, progress: Omit<LabRunProgress, "updatedAt">) {
  await ensureSchema();
  const updatedAt = new Date();
  await getDb().insert(labAgentRuns).values({
    id: progress.id,
    ownerId,
    conversationId: progress.conversationId,
    phase: progress.phase,
    label: progress.label,
    detail: progress.detail,
    status: progress.status,
    updatedAt,
  }).onConflictDoUpdate({
    target: labAgentRuns.id,
    set: {
      conversationId: progress.conversationId,
      phase: progress.phase,
      label: progress.label,
      detail: progress.detail,
      status: progress.status,
      updatedAt,
    },
  });
}

export async function readLabRunProgress(ownerId: string, id: string): Promise<LabRunProgress | null> {
  await ensureSchema();
  const [row] = await getDb().select().from(labAgentRuns)
    .where(and(eq(labAgentRuns.ownerId, ownerId), eq(labAgentRuns.id, id))).limit(1);
  return row ? {
    id: row.id,
    conversationId: row.conversationId,
    phase: row.phase as LabAgentPhase,
    label: row.label,
    detail: row.detail,
    status: row.status as LabRunStatus,
    updatedAt: row.updatedAt.toISOString(),
  } : null;
}
