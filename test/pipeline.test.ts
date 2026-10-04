import assert from "node:assert/strict";
import test from "node:test";
import {
	FRAGMENT_MIN_CHARS,
	type FramedEvidence,
	frameEvidence,
	isContextOverflow,
	sizeOf,
	splitPiece,
	splitQuestions,
	toModelEvidence,
} from "../src/pipeline.ts";

test("isContextOverflow recognizes explicit context-length errors", () => {
	assert.ok(
		isContextOverflow({
			stopReason: "error",
			errorMessage: "context_length_exceeded: input too large",
		}),
	);
	assert.ok(
		isContextOverflow({
			stopReason: "error",
			errorMessage: "maximum context window is 32000 tokens; requested 40000",
		}),
	);
	assert.ok(
		isContextOverflow({
			stopReason: "error",
			errorMessage: "input token count exceeds the maximum limit",
		}),
	);
	assert.ok(
		isContextOverflow({
			stopReason: "error",
			errorMessage: "context overflow",
		}),
	);
});

test("isContextOverflow rejects non-overflow errors", () => {
	assert.equal(
		isContextOverflow({
			stopReason: "error",
			errorMessage: "rate limit exceeded",
		}),
		false,
	);
	assert.equal(
		isContextOverflow({
			stopReason: "error",
			errorMessage: "insufficient_quota: billing",
		}),
		false,
	);
	assert.equal(
		isContextOverflow({
			stopReason: "error",
			errorMessage: "401 unauthorized: bad api key",
		}),
		false,
	);
	assert.equal(
		isContextOverflow({
			stopReason: "error",
			errorMessage: "connection refused",
		}),
		false,
	);
	assert.equal(isContextOverflow({ stopReason: "stop" }), false);
});

test("sizeOf measures state and question bytes, longest question separately", () => {
	const state = { a: "x".repeat(100) };
	const questions = {
		q1: {
			type: "bool",
			instructions: "y".repeat(50),
			criteria: { true: "t", false: "f" },
		},
		q2: {
			type: "bool",
			instructions: "z".repeat(400),
			criteria: { true: "t", false: "f" },
		},
	};
	const size = sizeOf(state, questions);
	assert.equal(size.stateBytes, Buffer.byteLength(JSON.stringify(state)));
	assert.equal(
		size.questionBytes,
		Buffer.byteLength(JSON.stringify(questions)),
	);
	assert.ok(size.longestQuestionBytes > 400);
});

test("splitQuestions halves id lists, undefined for singletons", () => {
	assert.deepEqual(splitQuestions(["a"]), undefined);
	assert.deepEqual(splitQuestions(["a", "b"]), [["a"], ["b"]]);
	assert.deepEqual(splitQuestions(["a", "b", "c"]), [["a", "b"], ["c"]]);
});

test("splitPiece splits record lists by count", () => {
	const records = [1, 2, 3, 4, 5].map((i) => ({
		record: { id: `r${i}`, text: `t${i}` },
	}));
	const halves = splitPiece(records);
	assert.ok(halves);
	assert.equal(halves?.[0].length, 3);
	assert.equal(halves?.[1].length, 2);
	assert.deepEqual(
		halves?.[0].map((f) => f.record.id),
		["r1", "r2", "r3"],
	);
});

test("splitPiece fragments one long record with Unicode-safe bounds", () => {
	// Include a surrogate pair (𝕏) near the midpoint.
	const text = `${"a".repeat(FRAGMENT_MIN_CHARS)}𝕏${"b".repeat(FRAGMENT_MIN_CHARS)}`;
	const halves = splitPiece([{ record: { id: "big", text } }]);
	assert.ok(halves);
	const [first, second] = halves;
	assert.equal(first.length, 1);
	assert.equal(second.length, 1);
	const f1 = first[0];
	const f2 = second[0];
	// Neither fragment text contains an unpaired surrogate.
	assert.ok(!/[\uD800-\uDBFF]$/.test(f1.record.text));
	assert.ok(!/^[\uDC00-\uDFFF]/.test(f2.record.text));
	// Genuine ABSOLUTE bounds live in the frame, outside caller metadata.
	const m1 = f1.bounds;
	const m2 = f2.bounds;
	assert.ok(m1 && m2);
	assert.equal(m1.of, "big");
	assert.equal(m2.of, "big");
	assert.equal(m1.start, 0);
	assert.equal(m1.end, m2.start);
	assert.equal(m2.end, m2.total);
	assert.equal(m1.total, text.length);
	// Caller metadata untouched (none supplied → still absent).
	assert.equal(f1.record.metadata, undefined);
	assert.equal(f1.record.text.length + f2.record.text.length, text.length);
	assert.equal(f1.record.text + f2.record.text, text);
});

test("splitPiece refuses records too small to halve", () => {
	assert.equal(splitPiece([{ record: { id: "s", text: "short" } }]), undefined);
	assert.equal(splitPiece([]), undefined);
});

test("frameEvidence + toModelEvidence keep bounds outside caller metadata", () => {
	const caller = {
		id: "src",
		text: "body",
		metadata: { fragment: { of: "caller", start: 1, end: 2, total: 3 } },
	};
	const framed = frameEvidence([caller]);
	// Whole record: no bounds inferred, caller shape preserved.
	const whole = toModelEvidence(framed) as {
		id: string;
		metadata: { fragment: unknown };
		fragmentBounds?: unknown;
	}[];
	assert.equal(whole.length, 1);
	assert.deepEqual(whole[0].metadata.fragment, {
		of: "caller",
		start: 1,
		end: 2,
		total: 3,
	});
	assert.equal(whole[0].fragmentBounds, undefined);
	// Fragmented: bounds appear OUTSIDE metadata; metadata untouched.
	const fragged: FramedEvidence[] = [
		{
			record: { ...caller, id: "src#0-2", text: "bo" },
			bounds: { of: "src", start: 0, end: 2, total: 4 },
		},
	];
	const out = toModelEvidence(fragged) as {
		id: string;
		metadata: { fragment: unknown };
		fragmentBounds?: { of: string; start: number; end: number; total: number };
	}[];
	assert.equal(out[0].id, "src#0-2");
	assert.deepEqual(out[0].metadata.fragment, {
		of: "caller",
		start: 1,
		end: 2,
		total: 3,
	});
	assert.deepEqual(out[0].fragmentBounds, {
		of: "src",
		start: 0,
		end: 2,
		total: 4,
	});
});
