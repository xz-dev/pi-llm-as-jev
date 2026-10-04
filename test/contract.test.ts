import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import type {
	ClassifierAnswer,
	JudgeRequest,
	ThresholdRule,
} from "../src/contract.ts";

test("contract module has no @earendil-works imports", async () => {
	const source = await fs.readFile(
		new URL("../src/contract.ts", import.meta.url),
		"utf8",
	);
	const importLines = source
		.split("\n")
		.filter((line) => line.startsWith("import") || line.includes(' from "'));
	assert.equal(
		importLines.some((line) => line.includes("@earendil-works")),
		false,
	);
	assert.equal(importLines.length, 1); // the single re-export from the canonical client
});

test("contract is a pure re-export of the canonical client types", async () => {
	// D1: one canonical typed client; src/contract.ts must not re-declare
	// contract types, only re-export the client's definitions.
	const source = await fs.readFile(
		new URL("../src/contract.ts", import.meta.url),
		"utf8",
	);
	assert.match(source, /export type \{/);
	// No local type/interface declarations of contract shapes: every export is
	// inside the single `export type { ... } from` block re-exporting the client.
	const localDeclarations = source.split("\n").filter(
		(line) =>
			/^export (?:type|interface|class|const|function)\b/.test(line) &&
			!/from "/.test(line) &&
			line !== "export type {", // the re-export block opener
	);
	assert.equal(localDeclarations.length, 0);
});

test("contract shapes typecheck against pi-ai classifier values", () => {
	const request: JudgeRequest = {
		state: { note: "fixed" },
		questions: {
			choice: {
				type: "choice",
				instructions: "pick",
				criteria: { a: "A", b: "B" },
			},
			bool: {
				type: "bool",
				instructions: "is it",
				criteria: { true: "yes", false: "no" },
			},
			score: {
				type: "score",
				instructions: "rate",
				criteria: ["low", "high"],
			},
		},
		evidence: [
			{ id: "e1", text: "first", metadata: { k: 1 } },
			{ id: "e2", text: "second" },
		],
	};
	assert.equal(Object.keys(request.questions).length, 3);
	assert.equal(request.evidence?.length, 2);

	const answers: Record<string, ClassifierAnswer> = {
		choice: {
			type: "choice",
			choice: "a",
			probabilities: { a: 1, b: 0 },
			confidence: 1,
		},
		bool: { type: "bool", probability: 0.9 },
		score: { type: "score", score: 1, confidence: 1 },
	};
	assert.equal(answers.choice?.type, "choice");

	const rules: Record<string, ThresholdRule> = {
		q: { metric: "confidence", minimum: 0.8 },
		r: { metric: "choiceProbability", choice: "a", minimum: 0.5 },
	};
	assert.equal(rules.q?.metric, "confidence");
});
