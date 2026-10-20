/**
 * Public judgment-service contract (design D1/D2, version two).
 *
 * The canonical, self-contained, copy-able client lives at
 * `client/judgment-client.ts` and owns every type definition. This module is
 * a pure re-export so extension-side code has one import site and the two
 * contracts can never diverge. No `@earendil-works/*` dependency.
 */

export type {
	CapacityDisclosure,
	ClassifierAnswer,
	ClassifierBoolAnswer,
	ClassifierBoolQuestion,
	ClassifierChoiceAnswer,
	ClassifierChoiceQuestion,
	ClassifierQuestion,
	ClassifierScoreAnswer,
	ClassifierScoreQuestion,
	JsonObject,
	JsonValue,
	JudgeOptions,
	JudgeRequest,
	JudgeResult,
	JudgmentService,
	ThresholdRule,
	Usage,
} from "../client/judgment-client.ts";
