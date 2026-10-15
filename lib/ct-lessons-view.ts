/**
 * The lessons tab of the playbook screen as data (stage 5): family cards with links to the playbook items they rest on, and the
 * "not yet touched" map. Pure, so the same model that is rendered is the one the tests read. docs/ct.md「연구 교훈」.
 */
import { CT_FAMILIES, CT_FAMILY_TEXT, type CTFamily } from "./ct-families.ts";
import type { CTCoverage, CTLessonView } from "./ct-lessons.ts";

export const LESSON_VERDICT_TEXT = { dead: "이 판에서 죽음", weak: "약한 증거", unresolved: "판정 불가" } as const;
export const GRADE_ORDER_TEXT: Record<string, string> = {
  rejected_in_training: "학습 기각",
  screen_failed: "학습 게이트 탈락",
  development_failed: "개발 탈락",
  passed_final: "최종 통과",
  failed_final: "최종 탈락",
  adopted_daily: "일봉 채택",
};
/** The DOM id of a playbook list item; a lesson's evidence links point at it. */
export const playbookAnchor = (id: string) => `pb-${id}`;

export type LessonCardModel = {
  id: string;
  family: CTFamily;
  familyText: string;
  verdict: CTLessonView["verdict"];
  verdictText: string;
  causeText: string;
  lesson: string;
  nextToTry: string | null;
  /** Playbook item ids with the anchor to scroll to, and whether the item is in the loaded list. */
  evidence: Array<{ id: string; anchor: string; listed: boolean }>;
  updated: string;
  lastRun: string;
};
export type LessonsPanelModel = {
  /** No lesson has been distilled yet (no run ended under the stage-5 policy and no backfill was run). */
  empty: boolean;
  cards: LessonCardModel[];
  coverage: {
    families: Array<{ family: CTFamily; familyText: string; ideas: number; tests: number; bestGrade: string | null; lastRun: string | null; hasLesson: boolean }>;
    untouched: string[];
    moreUntouched: number;
    touchedCells: number;
    totalCells: number;
    atrUntouched: string[];
    entryWindowUsed: boolean;
    exitUntouched: string[];
    emptyCells: string[];
  } | null;
  note: string;
};

export function lessonsPanelModel(data: { lessons?: CTLessonView[]; coverage?: CTCoverage } | null | undefined, playbookIds: string[]): LessonsPanelModel {
  const listed = new Set(playbookIds);
  const lessons = data?.lessons ?? [];
  const have = new Set(lessons.map((l) => l.family));
  const cov = data?.coverage;
  return {
    empty: lessons.length === 0,
    cards: [...lessons]
      .sort((a, b) => CT_FAMILIES.indexOf(a.family) - CT_FAMILIES.indexOf(b.family))
      .map((l) => ({
        id: l.id,
        family: l.family,
        familyText: CT_FAMILY_TEXT[l.family],
        verdict: l.verdict,
        verdictText: LESSON_VERDICT_TEXT[l.verdict],
        causeText: l.causeText,
        lesson: l.lesson,
        nextToTry: l.nextToTry,
        evidence: l.evidence.map((id) => ({ id, anchor: playbookAnchor(id), listed: listed.has(id) })),
        updated: l.updated,
        lastRun: l.lastRun,
      })),
    coverage: cov
      ? {
          families: cov.families.filter((f) => f.ideas > 0 || f.tests > 0 || have.has(f.family)).map((f) => ({ ...f, familyText: CT_FAMILY_TEXT[f.family], bestGrade: f.bestGrade ? (GRADE_ORDER_TEXT[f.bestGrade] ?? f.bestGrade) : null, hasLesson: have.has(f.family) })),
          untouched: cov.vocabulary.featureCells.untouched,
          moreUntouched: cov.vocabulary.featureCells.moreUntouched,
          touchedCells: cov.vocabulary.featureCells.touched,
          totalCells: cov.vocabulary.featureCells.total,
          atrUntouched: cov.vocabulary.atrUnit.untouched,
          entryWindowUsed: cov.vocabulary.entryWindow.used,
          exitUntouched: cov.vocabulary.managedExit.untouched,
          emptyCells: cov.emptyCells,
        }
      : null,
    note: cov?.note ?? "",
  };
}
