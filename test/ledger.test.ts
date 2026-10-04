import assert from "node:assert/strict";
import test from "node:test";
import type { ClassifierAnswer } from "../client/judgment-client.ts";
import {
	isOwnBookkeeping,
	LEDGER_TYPE,
	type LedgerRecord,
	restoreLedger,
	writeLedger,
} from "../src/ledger.ts";

const ANSWER: ClassifierAnswer = { type: "bool", probability: 0.9 };

const entry = (data: unknown) => ({
	type: "custom",
	customType: LEDGER_TYPE,
	data,
});

test("writeLedger uses the two-argument append and reports failures", () => {
	const seen: [string, unknown][] = [];
	const append = (type: string, data: unknown) => seen.push([type, data]);
	const record: LedgerRecord = {
		kind: "judgment",
		key: "k1",
		answer: ANSWER,
		backend: "classifier",
		model: "typesafe/jev-1.13",
		thinkingLevel: "none",
	};
	assert.ok(writeLedger(append, record));
	assert.deepEqual(seen, [[LEDGER_TYPE, record]]);
	assert.equal(writeLedger(undefined, record), false);
	const throwing = (): void => {
		throw new Error("disk full");
	};
	assert.equal(writeLedger(throwing, record), false);
});

test("isOwnBookkeeping matches only our custom type", () => {
	assert.ok(isOwnBookkeeping(entry({})));
	assert.equal(
		isOwnBookkeeping({ type: "custom", customType: "other", data: {} }),
		false,
	);
	assert.equal(isOwnBookkeeping({ type: "message" }), false);
});

test("restoreLedger replays judgments, rejections and capacity in branch order", () => {
	const branch = [
		entry({
			kind: "judgment",
			key: "k1",
			answer: ANSWER,
			backend: "classifier",
			model: "m",
			thinkingLevel: "none",
		}),
		entry({ kind: "rejected", envelope: "env1" }),
		entry({
			kind: "capacity",
			channel: "ch1",
			attempt: {
				outcome: "answered",
				inputTokens: 10,
				stateBytes: 5,
				questionBytes: 5,
				longestQuestionBytes: 5,
			},
		}),
	];
	const restored = restoreLedger(branch);
	assert.equal(restored.answers.get("k1"), ANSWER);
	assert.ok(restored.rejected.has("env1"));
	assert.equal(restored.capacity.get("ch1")?.length, 1);
});

test("restoreLedger ignores malformed and foreign entries", () => {
	const branch = [
		entry({ kind: "judgment", key: "bad", answer: { type: "nonsense" } }),
		entry({ kind: "judgment", answer: ANSWER }), // missing key
		entry({ kind: "unknown-kind" }),
		{
			type: "custom",
			customType: "other",
			data: { kind: "judgment", key: "x", answer: ANSWER },
		},
		entry({ kind: "capacity", channel: "c", attempt: { nonsense: true } }),
	];
	const restored = restoreLedger(branch);
	assert.equal(restored.answers.size, 0);
	assert.equal(restored.capacity.size, 0);
});

test("restoreLedger later judgment for the same key wins (branch order)", () => {
	const later: ClassifierAnswer = { type: "bool", probability: 0.2 };
	const restored = restoreLedger([
		entry({
			kind: "judgment",
			key: "k",
			answer: ANSWER,
			backend: "classifier",
			model: "m",
			thinkingLevel: "none",
		}),
		entry({
			kind: "judgment",
			key: "k",
			answer: later,
			backend: "classifier",
			model: "m",
			thinkingLevel: "none",
		}),
	]);
	assert.equal(restored.answers.get("k"), later);
});

test("ledger records never contain state/evidence bodies or secrets by construction", () => {
	const records: LedgerRecord[] = [
		{
			kind: "judgment",
			key: "k",
			answer: ANSWER,
			backend: "llm",
			model: "m",
			thinkingLevel: "low",
		},
		{ kind: "rejected", envelope: "digest-only" },
		{
			kind: "capacity",
			channel: "ch",
			attempt: { outcome: "overflow", stateBytes: 1, questionBytes: 1 },
		},
		{
			kind: "diag",
			backend: "llm",
			model: "m",
			hits: 1,
			joined: 0,
			sent: 1,
			inputTokens: 5,
			outputTokens: 2,
			outcome: "stop",
		},
	];
	const text = JSON.stringify(records);
	assert.ok(!text.includes("sk-"));
	assert.ok(!text.includes("api_key"));
	assert.ok(!text.includes("evidence"));
	assert.ok(
		!records.some(
			(r) => "evidence" in r || "text" in r || "body" in r || "request" in r,
		),
	);
});

test("legacy jev-tagged judgment entries are stale and never restored", () => {
	const answer: ClassifierAnswer = { type: "bool", probability: 0.9 };
	const branch = [
		entry({
			kind: "judgment",
			key: "k1",
			answer,
			backend: "jev", // legacy prototype tag
			model: "typesafe/jev-1.13",
			thinkingLevel: "none",
		}),
		entry({
			kind: "judgment",
			key: "k2",
			answer,
			backend: "classifier",
			model: "typesafe/jev-1.13",
			thinkingLevel: "none",
		}),
		entry({
			kind: "judgment",
			key: "k3",
			answer,
			backend: "llm",
			model: "fake/fake-model",
			thinkingLevel: "off",
		}),
	];
	const restored = restoreLedger(branch);
	assert.equal(restored.answers.has("k1"), false); // stale tag ignored
	assert.equal(restored.answers.has("k2"), true); // classifier tag restored
	assert.equal(restored.answers.has("k3"), true); // llm tag restored
});
