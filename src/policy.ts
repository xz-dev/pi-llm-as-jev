/**
 * Native-classifier numeric policy (task 4.4). Numeric acceptance rules apply
 * ONLY to native-classifier adapter answers. For discrete LLM decisions every numeric rule is ignored:
 * the model directly selects the business answer and nothing is dropped.
 */

import type {
	ClassifierAnswer,
	ClassifierQuestion,
	ThresholdRule,
} from "../client/judgment-client.ts";

/** Bool certainty metric: `max(p, 1-p)`. */
export function boolCertainty(probability: number): number {
	return Math.max(probability, 1 - probability);
}

/** The measured numeric an answer offers for a given rule, if any. */
export function measuredValue(
	answer: ClassifierAnswer,
	rule: ThresholdRule,
): number | undefined {
	if (rule.metric === "confidence") {
		if (answer.type === "bool") return boolCertainty(answer.probability);
		return answer.confidence;
	}
	if (answer.type !== "choice") return undefined;
	const probability = Object.hasOwn(answer.probabilities, rule.choice)
		? answer.probabilities[rule.choice]
		: undefined;
	return typeof probability === "number" && Number.isFinite(probability)
		? probability
		: undefined;
}

export type ThresholdPolicy = {
	/** Global default minimum; undefined = accept. */
	default?: number;
	/** Per-question rules overriding the default. */
	perQuestion: Record<string, ThresholdRule>;
};

/**
 * Decide whether one raw answer passes the caller's policy. LLM backend
 * answers always pass: numeric rules never gate discrete selections.
 */
export function accepted(
	answer: ClassifierAnswer,
	backend: "classifier" | "llm",
	questionId: string,
	policy: ThresholdPolicy,
): boolean {
	if (backend === "llm") return true;
	const rule = Object.hasOwn(policy.perQuestion, questionId)
		? policy.perQuestion[questionId]
		: undefined;
	if (rule) {
		const value = measuredValue(answer, rule);
		return value !== undefined && value >= rule.minimum;
	}
	if (policy.default === undefined) return true;
	const value = measuredValue(answer, {
		metric: "confidence",
		minimum: policy.default,
	});
	return value !== undefined && value >= policy.default;
}

// ---------------------------------------------------------------------------
// Raw-answer admission (F2): validate a provider/LLM/cache/ledger answer
// against the question that requested it BEFORE it can be accepted, cached,
// joined, restored, policy-gated or persisted. Construct a sanitized
// contract-shaped RAW answer that keeps only the defined fields — provider
// extras are dropped, never persisted. This is admission validation, not a
// calibration/capability framework: it enforces the Pi classifier answer
// contract's own types, legal labels, score levels and finite ranges.
// ---------------------------------------------------------------------------

const isFiniteNumber = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v);

/** Own enumerable properties only — inherited `constructor`/`toString` never pass. */
function ownEntries(value: object): [string, unknown][] {
	return Object.entries(value);
}

/**
 * Validate one raw answer against its question and return the sanitized
 * contract-shaped answer, or undefined when the answer is incompatible
 * (wrong type, illegal label, missing/out-of-range numeric fields, missing
 * probabilities, or not an own property of the answers map).
 */
export function validateAnswer(
	question: ClassifierQuestion,
	raw: unknown,
): ClassifierAnswer | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	if (question === undefined || question === null) return undefined;
	const answer = raw as Record<string, unknown>;
	// Own-key check happens at the answers-map seam (hasOwn on the map);
	// here the value shape itself must be a plain own-field object.
	if (question.type === "bool") {
		if (answer.type !== "bool") return undefined;
		if (!isFiniteNumber(answer.probability)) return undefined;
		if (answer.probability < 0 || answer.probability > 1) return undefined;
		return { type: "bool", probability: answer.probability };
	}
	if (question.type === "score") {
		if (answer.type !== "score") return undefined;
		if (!isFiniteNumber(answer.score)) return undefined;
		if (answer.score < 0 || answer.score > question.criteria.length - 1)
			return undefined;
		if (!isFiniteNumber(answer.confidence)) return undefined;
		if (answer.confidence < 0 || answer.confidence > 1) return undefined;
		return {
			type: "score",
			score: answer.score,
			confidence: answer.confidence,
		};
	}
	if (question.type === "choice") {
		if (answer.type !== "choice") return undefined;
		if (typeof answer.choice !== "string") return undefined;
		const legal = question.criteria;
		if (!Object.hasOwn(legal, answer.choice)) return undefined;
		if (!isFiniteNumber(answer.confidence)) return undefined;
		if (answer.confidence < 0 || answer.confidence > 1) return undefined;
		const probabilitiesRaw = answer.probabilities;
		if (
			probabilitiesRaw === null ||
			typeof probabilitiesRaw !== "object" ||
			Array.isArray(probabilitiesRaw)
		) {
			return undefined;
		}
		// Probabilities must cover EXACTLY the legal keys, each finite in [0,1].
		const legalKeys = ownEntries(legal).map(([k]) => k);
		const seen = new Set(ownEntries(probabilitiesRaw).map(([k]) => k));
		if (legalKeys.length !== seen.size) return undefined;
		const probabilities: Record<string, number> = {};
		for (const key of legalKeys) {
			if (!seen.has(key)) return undefined;
			const value = (probabilitiesRaw as Record<string, unknown>)[key];
			if (!isFiniteNumber(value)) return undefined;
			if (value < 0 || value > 1) return undefined;
			// Own-key-safe write: legal labels can be `__proto__` etc.
			Object.defineProperty(probabilities, key, {
				value,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return {
			type: "choice",
			choice: answer.choice,
			probabilities,
			confidence: answer.confidence,
		};
	}
	return undefined;
}
