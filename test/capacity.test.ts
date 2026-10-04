import assert from "node:assert/strict";
import test from "node:test";
import {
	type CapacityLimits,
	type CapacityProfile,
	channelKey,
	digest,
	type EnvelopeSize,
	LLM_ENVELOPE_OVERHEAD_BYTES,
	newCapacityProfile,
	observe,
	overflowConstraint,
	PRIOR_TOKENS_PER_BYTE,
	predictOverflow,
} from "../src/capacity.ts";

const s = (
	stateBytes: number,
	questionBytes: number,
	longest = 0,
): EnvelopeSize => ({
	stateBytes,
	questionBytes,
	longestQuestionBytes: longest,
});

test("digest is stable and input-sensitive", () => {
	assert.equal(digest({ a: 1 }), digest({ a: 1 }));
	assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
});

test("channelKey distinguishes backend and model", () => {
	assert.notEqual(
		channelKey("classifier", "typesafe/jev-1.13"),
		channelKey("llm", "typesafe/jev-1.13"),
	);
	assert.notEqual(channelKey("llm", "a/b"), channelKey("llm", "a/c"));
	assert.equal(channelKey("llm", "a/b"), channelKey("llm", "a/b"));
});

test("prior ratio alone predicts overflow against declared context window", () => {
	const profile = newCapacityProfile();
	const limits: CapacityLimits = { contextWindow: 32_000 };
	// state+longest just over the limit at the prior ratio
	const size = s(60_000, 60_000, 0);
	// longest = 60000 → 60000 * (1/1.75) ≈ 34285 > 32000
	assert.equal(overflowConstraint(profile, size, limits), "state");
	assert.ok(predictOverflow(profile, size, limits));
	assert.equal(
		overflowConstraint(profile, s(10_000, 10_000), limits),
		undefined,
	);
});

test("request constraint fires when state+all questions exceed but longest alone fits", () => {
	const profile: CapacityProfile = { tokensPerByte: 0.5, rejections: [] };
	const limits: CapacityLimits = { contextWindow: 1000 };
	// longest: 900*0.5=450 fits; total: 2200*0.5=1100 > 1000
	assert.equal(
		overflowConstraint(profile, s(200, 2000, 900), limits),
		"request",
	);
});

test("learned tokensPerByte replaces the prior", () => {
	const profile = newCapacityProfile();
	const limits: CapacityLimits = { contextWindow: 1000 };
	const huge = s(5000, 5000, 0);
	assert.equal(overflowConstraint(profile, huge, limits), "state");
	observe(profile, {
		outcome: "answered",
		inputTokens: 10,
		stateBytes: 5000,
		questionBytes: 5000,
	});
	// 10/10000 = 0.001 tokens/byte → fits now
	assert.equal(overflowConstraint(profile, huge, limits), undefined);
	assert.equal(profile.tokensPerByte, 0.001);
});

test("observed overflow records a rejection; dominated rejections prune", () => {
	const profile = newCapacityProfile();
	observe(profile, {
		outcome: "overflow",
		stateBytes: 1000,
		questionBytes: 1000,
		longestQuestionBytes: 1000,
	});
	assert.equal(profile.rejections.length, 1);
	assert.equal(
		overflowConstraint(profile, s(1000, 1000, 1000), undefined),
		"rejection",
	);
	assert.equal(
		overflowConstraint(profile, s(500, 500, 500), undefined),
		undefined,
	);
	// A smaller rejection that existing ones cover is ignored (minimal set).
	observe(profile, {
		outcome: "overflow",
		stateBytes: 2000,
		questionBytes: 2000,
		longestQuestionBytes: 2000,
	});
	assert.equal(profile.rejections.length, 1);
	assert.equal(profile.rejections[0].stateBytes, 1000);
	// A non-dominated smaller rejection replaces the dominated larger one.
	observe(profile, {
		outcome: "overflow",
		stateBytes: 500,
		questionBytes: 500,
		longestQuestionBytes: 500,
	});
	assert.equal(profile.rejections.length, 1);
	assert.equal(profile.rejections[0].stateBytes, 500);
	// An admitted size covering the first rejection prunes it
	observe(profile, {
		outcome: "answered",
		inputTokens: 1,
		stateBytes: 1500,
		questionBytes: 1500,
		longestQuestionBytes: 1500,
	});
	assert.ok(!profile.rejections.some((r) => r.stateBytes === 1000));
});

test("duplicate rejection is not recorded twice", () => {
	const profile = newCapacityProfile();
	const attempt = {
		outcome: "overflow" as const,
		stateBytes: 100,
		questionBytes: 100,
		longestQuestionBytes: 100,
	};
	observe(profile, attempt);
	observe(profile, attempt);
	assert.equal(profile.rejections.length, 1);
});

test("LLM envelope overhead is a positive constant", () => {
	assert.ok(LLM_ENVELOPE_OVERHEAD_BYTES > 0);
	assert.ok(PRIOR_TOKENS_PER_BYTE > 0.5);
});
