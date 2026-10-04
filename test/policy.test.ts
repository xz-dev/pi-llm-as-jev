import assert from "node:assert/strict";
import test from "node:test";
import type {
	ClassifierAnswer,
	ThresholdRule,
} from "../client/judgment-client.ts";
import {
	accepted,
	boolCertainty,
	measuredValue,
	type ThresholdPolicy,
} from "../src/policy.ts";

const choice: ClassifierAnswer = {
	type: "choice",
	choice: "contradicted",
	probabilities: { contradicted: 0.85, ok: 0.15 },
	confidence: 0.7,
};
const boolAns = (p: number): ClassifierAnswer => ({
	type: "bool",
	probability: p,
});
const score: ClassifierAnswer = { type: "score", score: 2, confidence: 0.6 };

test("boolCertainty is max(p, 1-p)", () => {
	assert.equal(boolCertainty(0.9), 0.9);
	assert.equal(boolCertainty(0.1), 0.9);
	assert.equal(boolCertainty(0.5), 0.5);
});

test("default confidence threshold applies to choice and score", () => {
	const policy: ThresholdPolicy = { default: 0.8, perQuestion: {} };
	assert.equal(accepted(choice, "classifier", "q", policy), false);
	assert.equal(accepted(score, "classifier", "q", policy), false);
	assert.equal(
		accepted({ ...choice, confidence: 0.85 }, "classifier", "q", policy),
		true,
	);
});

test("bool answers use certainty max(p,1-p) against the default", () => {
	const policy: ThresholdPolicy = { default: 0.8, perQuestion: {} };
	assert.ok(accepted(boolAns(0.9), "classifier", "q", policy));
	assert.ok(!accepted(boolAns(0.65), "classifier", "q", policy)); // certainty 0.65 < 0.8
	assert.ok(!accepted(boolAns(0.35), "classifier", "q", policy)); // certainty 0.65 < 0.8
});

test("named-choice probability rule beats overall confidence", () => {
	// confidence 0.7 < 0.8 but contradicted probability 0.85 >= 0.8 → accept
	const policy: ThresholdPolicy = {
		default: 0.8,
		perQuestion: {
			q: { metric: "choiceProbability", choice: "contradicted", minimum: 0.8 },
		},
	};
	assert.ok(accepted(choice, "classifier", "q", policy));
	// Probability below the rule but confidence above → reject on the rule
	const lowProb = {
		...choice,
		probabilities: { contradicted: 0.7, ok: 0.3 },
		confidence: 0.9,
	};
	assert.equal(accepted(lowProb, "classifier", "q", policy), false);
});

test("per-question rule replaces (not stacks with) the default", () => {
	const policy: ThresholdPolicy = {
		default: 0.9,
		perQuestion: { q: { metric: "confidence", minimum: 0.5 } },
	};
	assert.ok(
		accepted({ ...choice, confidence: 0.6 }, "classifier", "q", policy),
	);
	// Another question still uses 0.9
	assert.equal(
		accepted({ ...choice, confidence: 0.6 }, "classifier", "other", policy),
		false,
	);
});

test("no rule at all accepts everything on jev", () => {
	const policy: ThresholdPolicy = { perQuestion: {} };
	assert.ok(accepted(choice, "classifier", "q", policy));
	assert.ok(accepted(boolAns(0.5), "classifier", "q", policy));
});

test("LLM backend ignores every numeric rule; nothing drops", () => {
	const strict: ThresholdPolicy = {
		default: 1,
		perQuestion: { q: { metric: "confidence", minimum: 1 } },
	};
	assert.ok(accepted(choice, "llm", "q", strict));
	assert.ok(accepted(boolAns(0.5), "llm", "q", strict));
});

test("measuredValue handles missing probability and non-choice questions", () => {
	const rule: ThresholdRule = {
		metric: "choiceProbability",
		choice: "absent",
		minimum: 0.5,
	};
	assert.equal(measuredValue(choice, rule), undefined);
	assert.equal(measuredValue(score, rule), undefined);
	assert.equal(
		measuredValue(score, { metric: "confidence", minimum: 0.5 }),
		0.6,
	);
});
