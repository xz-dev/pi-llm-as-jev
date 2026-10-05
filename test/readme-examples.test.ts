/** Compile and execute the README's actual TypeScript fences, without rewriting them. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const fixture = `
import type { JudgmentService, JudgeRequest, EvidenceRecord } from "./judgment-client.ts";
const calls: JudgeRequest[] = [];
const service: JudgmentService = {
 version: 1,
 async judge(request) {
  calls.push(request);
  return { answers: {}, dropped: [], backend: "classifier", model: "offline/fixture", stopReason: "stop", reuse: { hits: 0, joined: 0, sent: 1 } };
 },
 async availability() { return {}; }
};
const evidence: EvidenceRecord[] = [{ id: "one", text: "synthetic finding" }];
const request: JudgeRequest = { state: {}, questions: { verdict: { type: "choice", instructions: "verdict", criteria: { ship: "ship", hold: "hold", revert: "revert" } } } };
`;

test("exact README snippets compile and run with explicit external bindings", async () => {
	const dir = await fs.mkdtemp("/var/tmp/jev-readme-");
	try {
		const text = await fs.readFile(path.join(root, "README.md"), "utf8");
		const snippets = [...text.matchAll(/```ts\n([\s\S]*?)```/g)].map(
			(match) => match[1],
		);
		assert.equal(snippets.length, 5, "every TypeScript fence must be covered");
		await fs.copyFile(
			path.join(root, "client/judgment-client.ts"),
			path.join(dir, "judgment-client.ts"),
		);
		await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
		const prefixes = [
			"", // Quick start: execute with the service genuinely absent.
			'import type { JsonObject, ClassifierQuestion, ClassifierAnswer, Usage } from "./judgment-client.ts";\n',
			fixture,
			"", // Review discovery: compile the additive API, run without a service.
			fixture,
		];
		for (const [index, snippet] of snippets.entries()) {
			await fs.writeFile(
				path.join(dir, `snippet-${index}.ts`),
				prefixes[index] + snippet,
			);
		}
		await fs.writeFile(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2023",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					noEmit: true,
					allowImportingTsExtensions: true,
					skipLibCheck: true,
					types: [],
				},
				include: ["*.ts"],
			}),
		);
		const compiled = spawnSync(
			path.join(root, "node_modules/.bin/tsc"),
			["-p", path.join(dir, "tsconfig.json")],
			{ encoding: "utf8", timeout: 30_000 },
		);
		assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
		for (let index = 0; index < snippets.length; index++) {
			const executed = spawnSync(
				path.join(root, "node_modules/.bin/tsx"),
				[path.join(dir, `snippet-${index}.ts`)],
				{ encoding: "utf8", timeout: 10_000 },
			);
			assert.equal(executed.status, 0, executed.stdout + executed.stderr);
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
