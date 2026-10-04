import assert from "node:assert/strict";
import test from "node:test";
import type { ClassifierAnswer } from "../client/judgment-client.ts";
import {
	freshEligible,
	type JudgmentIdentity,
	judgmentKey,
	newCache,
	noteFresh,
	trackPending,
} from "../src/cache.ts";

const base: JudgmentIdentity = {
	backend: "classifier",
	model: "typesafe/jev-1.13",
	thinkingLevel: "none",
	state: { task: "x" },
	evidence: [],
	previousAnswers: {},
	questionId: "q1",
	question: {
		type: "bool",
		instructions: "ok?",
		criteria: { true: "y", false: "n" },
	},
	isFinalStage: true,
};

const ANSWER: ClassifierAnswer = { type: "bool", probability: 0.9 };

test("identity is stable for identical inputs", () => {
	assert.equal(judgmentKey(base), judgmentKey({ ...base }));
});

test("backend, model, thinking, state, evidence, question all affect identity", () => {
	const key = judgmentKey(base);
	assert.notEqual(judgmentKey({ ...base, backend: "llm" }), key);
	assert.notEqual(judgmentKey({ ...base, model: "typesafe/jev-2" }), key);
	assert.notEqual(judgmentKey({ ...base, thinkingLevel: "low" }), key);
	assert.notEqual(judgmentKey({ ...base, state: { task: "y" } }), key);
	assert.notEqual(
		judgmentKey({
			...base,
			evidence: [{ record: { id: "e1", text: "t" } }],
		}),
		key,
	);
	assert.notEqual(judgmentKey({ ...base, questionId: "q2" }), key);
	assert.notEqual(
		judgmentKey({
			...base,
			question: {
				type: "bool",
				instructions: "changed",
				criteria: { true: "y", false: "n" },
			},
		}),
		key,
	);
});

test("ordered evidence distinguishes identity: order matters, fragment bounds matter", () => {
	const a = { record: { id: "a", text: "A" } };
	const b = { record: { id: "b", text: "B" } };
	const forward = judgmentKey({ ...base, evidence: [a, b] });
	const backward = judgmentKey({ ...base, evidence: [b, a] });
	assert.notEqual(forward, backward);
	const fragA = {
		record: { id: "a#0-10", text: "A" },
		bounds: { of: "a", start: 0, end: 10, total: 20 },
	};
	const fragA2 = {
		record: { id: "a#0-11", text: "A" },
		bounds: { of: "a", start: 0, end: 11, total: 20 },
	};
	assert.notEqual(
		judgmentKey({ ...base, evidence: [fragA] }),
		judgmentKey({ ...base, evidence: [fragA2] }),
	);
	// Caller metadata participates in identity but is never trusted as
	// bounds: same genuine bounds + different metadata = different identity.
	const withMeta = {
		record: {
			id: "a#0-10",
			text: "A",
			metadata: { fragment: { of: "x", start: 9, end: 9, total: 9 } },
		},
		bounds: { of: "a", start: 0, end: 10, total: 20 },
	};
	assert.notEqual(
		judgmentKey({ ...base, evidence: [fragA] }),
		judgmentKey({ ...base, evidence: [withMeta] }),
	);
});

test("previousAnswers are part of identity (stage histories cannot collide)", () => {
	assert.notEqual(
		judgmentKey({ ...base, previousAnswers: { other: ANSWER } }),
		judgmentKey(base),
	);
});

test("fresh token membership gates eligibility", () => {
	const cache = newCache(0);
	const key = judgmentKey(base);
	assert.ok(freshEligible(cache, undefined, key));
	assert.equal(freshEligible(cache, "tok1", key), false);
	noteFresh(cache, "tok1", key);
	assert.ok(freshEligible(cache, "tok1", key));
	assert.equal(freshEligible(cache, "tok2", key), false);
});

test("final-stage flag distinguishes identity (F6)", () => {
	assert.notEqual(
		judgmentKey({ ...base, isFinalStage: true }),
		judgmentKey({ ...base, isFinalStage: false }),
	);
});

test("pending join resolves and cleans up", async () => {
	const cache = newCache(0);
	const key = judgmentKey(base);
	let resolveFn: (v: { stopReason: "stop"; answer: ClassifierAnswer }) => void =
		() => {};
	const promise = new Promise<{ stopReason: "stop"; answer: ClassifierAnswer }>(
		(res) => {
			resolveFn = res;
		},
	);
	trackPending(cache, key, promise);
	assert.ok(cache.pending.has(key));
	resolveFn({ stopReason: "stop", answer: ANSWER });
	assert.deepEqual(await promise, { stopReason: "stop", answer: ANSWER });
	await promise.finally(() => {});
	// Cleanup happens in the finally callback scheduled by trackPending.
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(cache.pending.has(key), false);
});

test("cache generation separates branch scopes", () => {
	const c1 = newCache(1);
	const c2 = newCache(2);
	c1.answers.set(judgmentKey(base), ANSWER);
	assert.equal(c2.answers.has(judgmentKey(base)), false);
	assert.notEqual(c1.generation, c2.generation);
});
