/**
 * traderTools 8 (2026-10-16): cost-lean designer sessions (docs/ct.md「비용 절감 세션」).
 *
 * Measured on run c58b159a ($3.13): 32% of the money went to rewriting a refused submission from scratch (four refusals,
 * one error each, ~10k characters of JSON per retry, then re-cached), and 49% to a third session whose components could no
 * longer enter a book. Nothing here changes a gate, a measurement or what the designer may see; it changes how often the
 * designer has to write the same thing twice.
 */
import { z } from "zod";
import type { CTResearch, CTSession } from "./ct-research.ts";

/** amend_submission: dotted paths into the last refused submission (candidates.0.selfRebuttal.1.chance). */
export const ctAmendSchema = z
  .object({
    edits: z
      .array(
        z
          .object({
            path: z.string().min(1).max(200),
            value: z.unknown().optional(),
            remove: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(40),
  })
  .strict();
export type CTAmend = z.infer<typeof ctAmendSchema>;

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

/** Apply amend_submission edits to a copy of the stored draft. An unknown path is an error, never a silent new branch. */
export function ctApplySubmissionEdits(draft: unknown, edits: CTAmend["edits"]) {
  if (!draft || typeof draft !== "object") throw new Error("고칠 직전 제출이 없습니다. submit_candidates로 전체를 제출하세요.");
  const root = structuredClone(draft) as Record<string, unknown>;
  for (const edit of edits) {
    const keys = edit.path.split(".");
    if (keys.some((k) => !k || FORBIDDEN.has(k))) throw new Error(`잘못된 경로: ${edit.path}`);
    let node: unknown = root;
    for (const key of keys.slice(0, -1)) {
      const next = Array.isArray(node) ? node[Number(key)] : (node as Record<string, unknown>)[key];
      if (!next || typeof next !== "object") throw new Error(`경로 없음: ${edit.path} (${key})`);
      node = next;
    }
    const last = keys.at(-1)!;
    if (Array.isArray(node)) {
      const i = last === "-" ? node.length : Number(last);
      if (!Number.isInteger(i) || i < 0 || i > node.length) throw new Error(`배열 위치 없음: ${edit.path}`);
      if (edit.remove) {
        if (i >= node.length) throw new Error(`배열 위치 없음: ${edit.path}`);
        node.splice(i, 1);
      } else node[i] = edit.value;
    } else {
      const obj = node as Record<string, unknown>;
      if (edit.remove) delete obj[last];
      else obj[last] = edit.value;
    }
  }
  return root;
}

export const CT_AMEND_HINT =
  "전체를 다시 보내지 말고 amend_submission으로 고칠 필드만 보내세요: path는 직전 제출 JSON의 점 표기(예: candidates.0.selfRebuttal.0.chance, components.2.mapping.1.sourceId), value는 새 값, 배열 끝에 추가는 마지막 칸을 -로, 삭제는 remove:true.";

/**
 * Column tables for arrays of same-shaped objects: the keys of a 14-row exitCompare or 5-row horizons table are sent once,
 * not once per row. Nested objects flatten to dotted columns; a missing cell is null. Numbers and text are unchanged.
 */
export function ctTabulate(rows: Array<Record<string, unknown>>) {
  const flat = rows.map((row) => flatten(row));
  const columns = [...new Set(flat.flatMap((r) => Object.keys(r)))];
  return { columns, rows: flat.map((r) => columns.map((c) => (c in r ? r[c] : null))) };
}
function flatten(value: Record<string, unknown>, prefix = "", out: Record<string, unknown> = {}) {
  for (const [key, v] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v as Record<string, unknown>, name, out);
    else out[name] = v;
  }
  return out;
}
const tableable = (v: unknown): v is Array<Record<string, unknown>> =>
  Array.isArray(v) && v.length >= 2 && v.every((x) => x && typeof x === "object" && !Array.isArray(x));

/** The query_conditional_returns answer with every list of rows as a column table (same numbers, fewer tokens). */
export function ctCompactAnswer<T extends Record<string, unknown>>(out: T) {
  const tables: string[] = [];
  const compact: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(out)) {
    if (tableable(v)) {
      compact[key] = ctTabulate(v);
      tables.push(key);
    } else compact[key] = v;
  }
  return tables.length ? { ...compact, tableFormat: `${tables.join("·")}: {columns, rows} · 각 행은 columns 순서의 값 · 점 표기 열은 중첩 필드` } : compact;
}

/**
 * Per-turn effort. A session opens at the contract's effort (high); measurement turns (reading a query, a label, a chart)
 * run at medium, and the turns that decide or write — after screen_rule / diagnose_trades, after a refused submission, the
 * final-turn notice — go back to high. Returns the level the NEXT turn should run at.
 */
export function ctTurnEffort(toolNames: string[], options: { finalNotice: boolean; refused: boolean }): "medium" | "high" {
  if (options.finalNotice || options.refused) return "high";
  return toolNames.some((n) => n === "screen_rule" || n === "diagnose_trades" || n === "submit_candidates" || n === "amend_submission") ? "high" : "medium";
}

/** What earlier sessions measured that stays valid by id (labels, contrasts), so a reflection does not re-run them. */
export function ctReusableMeasurements(ct: Pick<CTResearch, "labels" | "contrasts">, before: CTSession["index"]) {
  const labels = Object.values(ct.labels ?? {})
    .filter((l) => l.session < before)
    .map((l) => ({ labelId: l.labelId, session: l.session + 1, params: l.params, events: l.events, positiveMoments: l.positiveMoments }));
  const contrasts = (ct.contrasts ?? [])
    .filter((x) => x.session < before)
    .map((x) => ({ contrastId: x.contrastId, labelId: x.labelId, session: x.session + 1, summary: x.summary }));
  return labels.length || contrasts.length ? { labels, contrasts } : null;
}
