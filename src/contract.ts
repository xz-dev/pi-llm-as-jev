/**
 * Public judgment-service contract (design D1/D2).
 *
 * The canonical, self-contained, copy-able client lives at
 * `client/judgment-client.ts` and owns every type definition. This module is
 * a pure re-export so extension-side code has one import site and the two
 * contracts can never diverge. No `@earendil-works/*` dependency.
 */

export type {
	ClassifierAnswer,
	ClassifierBoolAnswer,
	ClassifierBoolQuestion,
	ClassifierChoiceAnswer,
	ClassifierChoiceQuestion,
	ClassifierQuestion,
	ClassifierScoreAnswer,
	ClassifierScoreQuestion,
	EvidenceRecord,
	JsonObject,
	JsonValue,
	JudgeOptions,
	JudgeRequest,
	JudgeResult,
	JudgmentService,
	ReviewAttemptObservation,
	ReviewDiagnostics,
	ReviewEvidenceFrame,
	ReviewOptions,
	ReviewProgress,
	ReviewResult,
	ReviewService,
	ReviewStageProgress,
	ReviewStageProjection,
	ReviewUsageField,
	ReviewUsageTotals,
	ThresholdRule,
	Usage,
} from "../client/judgment-client.ts";
