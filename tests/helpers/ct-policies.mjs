// The policy a contract carried at each stage, derived from today's CT_POLICY the way an older contract would have been frozen
// (stage-5 fields absent). Used to keep older-stage behaviour under test after the default policy moved on.
import { CT_POLICY } from "../../lib/ct-spec.ts";
const { lessonReserveUsd: _a, lessonMaxInputChars: _b, lessonMaxOutputTokens: _c, ...beforeStage5 } = CT_POLICY;
export const STAGE3_POLICY = { ...beforeStage5, traderTools: 1, sessionMaxCharts: 32 };
export const STAGE4_POLICY = { ...beforeStage5, traderTools: 2 };
export const STAGE5_POLICY = CT_POLICY;
