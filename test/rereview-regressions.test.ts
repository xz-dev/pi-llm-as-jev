import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
	ClassifierAnswer,
	JudgeRequest,
} from "../client/judgment-client.ts";
import { validateConfig } from "../src/config.ts";
import { LEDGER_TYPE, type LedgerRecord } from "../src/ledger.ts";
import { createJudgmentService, type ServiceRegistry } from "../src/service.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const q = {
	type: "bool" as const,
	instructions: "condition?",
	criteria: { true: "yes", false: "no" },
};
const req = { state: {}, questions: { q } };
const model: Parameters<ServiceRegistry["classify"]>[0] = {
	type: "classifier",
	provider: "native",
	id: "kev",
	name: "offline",
	api: "typesafe-system-one",
	baseUrl: "https://fixture.invalid",
	input: ["text"],
	contextWindow: 100000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const ans: ClassifierAnswer = { type: "bool", probability: 0.9 };
type NativeResult = Awaited<ReturnType<ServiceRegistry["classify"]>>;
const output = (
	answers: Record<string, ClassifierAnswer>,
	extra: Partial<NativeResult> = {},
): NativeResult => ({
	api: model.api,
	provider: model.provider,
	model: model.id,
	answers,
	stopReason: "stop",
	timestamp: Date.now(),
	...extra,
});
function harness(extra: Partial<ServiceRegistry> = {}, timeoutMs = 1000) {
	const config = validateConfig({
		mode: "classifier",
		classifierModel: "native/kev",
		timeoutMs,
	}).config;
	const rows: LedgerRecord[] = [];
	let branch: unknown[] = [];
	const registry: ServiceRegistry = {
		getAvailableOfType: async () => [model],
		getModel: () => undefined,
		getAuth: async () => undefined,
		getProviders: () => [],
		classify: async () => output({ q: ans }),
		streamSimple: () => {
			throw new Error("offline native fixture must not stream");
		},
		...extra,
	};
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: { append: (_type, row) => rows.push(row), branch: () => branch },
	});
	return {
		service,
		registry,
		rows,
		setBranch: (entries: unknown[]) => {
			branch = entries;
		},
	};
}
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release: () => release() };
}

for (const stopReason of ["error", "aborted"] as const)
	test(`R1: joined caller must not accept ${stopReason} provider partial answers`, async () => {
		const wait = gate(),
			entered = gate();
		let calls = 0;
		const h = harness({
			classify: async () => {
				calls++;
				entered.release();
				await wait.promise;
				return output(
					{ q: ans },
					{ stopReason, errorMessage: "synthetic failure" },
				);
			},
		});
		const owner = h.service.judge(req);
		await entered.promise;
		const waiter = h.service.judge(req);
		await sleep(10);
		wait.release();
		assert.equal((await owner).stopReason, stopReason);
		const result = await waiter;
		assert.equal(
			result.stopReason,
			stopReason,
			"failed dispatch must not become successful joined result",
		);
		assert.deepEqual(result.answers, {});
		assert.equal(h.rows.filter((row) => row.kind === "judgment").length, 0);
		assert.equal((await h.service.judge(req)).reuse.hits, 0);
		assert.equal(calls, 2, "failure must leave no answer to reuse");
	});

test("R1: concurrent overflow recovery retains raw answers for each caller's policy", async () => {
	const wait = gate(),
		entered = gate();
	const batches: string[][] = [];
	const h = harness({
		classify: async (_model, context) => {
			const ids = Object.keys(context.questions);
			batches.push(ids);
			if (ids.length > 1) {
				entered.release();
				await wait.promise;
				return output(
					{},
					{ stopReason: "error", errorMessage: "context_length_exceeded" },
				);
			}
			return output(Object.fromEntries(ids.map((id) => [id, ans])));
		},
	});
	const input = { state: {}, questions: { one: q, two: q } };
	const owner = h.service.judge(input, { minConfidence: 0.95 });
	await entered.promise;
	const waiter = h.service.judge(input, { minConfidence: 0.8 });
	await sleep(10);
	wait.release();
	const strict = await owner,
		loose = await waiter;
	assert.equal(strict.stopReason, "stop");
	assert.deepEqual(strict.answers, {});
	assert.deepEqual(strict.dropped, ["one", "two"]);
	assert.equal(loose.stopReason, "stop");
	assert.deepEqual(loose.answers, { one: ans, two: ans });
	assert.deepEqual(loose.dropped, []);
	assert.equal(loose.reuse.sent, 0);
	assert.deepEqual(batches, [["one", "two"], ["one"], ["two"]]);
	const cached = await h.service.judge(input, { minConfidence: 0.95 });
	assert.deepEqual(cached.answers, {});
	assert.deepEqual(cached.dropped, ["one", "two"]);
	assert.equal(batches.length, 3);
});

test("R2: spent auth deadline forbids dispatch and successful result", async () => {
	let calls = 0;
	const h = harness({
		getAuth: () => new Promise(() => {}),
		classify: async () => {
			calls++;
			return output({ q: ans });
		},
	});
	const result = await h.service.judge(req, { timeoutMs: 30 });
	assert.equal(calls, 0);
	assert.equal(result.stopReason, "error");
	assert.deepEqual(result.answers, {});
});

test("R2: configured auth deadline also forbids dispatch", async () => {
	let calls = 0;
	const h = harness(
		{
			getAuth: () => new Promise(() => {}),
			classify: async () => {
				calls++;
				return output({ q: ans });
			},
		},
		30,
	);
	const result = await h.service.judge(req);
	assert.equal(calls, 0);
	assert.equal(result.stopReason, "error");
	assert.deepEqual(result.answers, {});
	assert.equal(h.rows.filter((row) => row.kind === "judgment").length, 0);
});

test("R2: discovery receives aborted deadline signal", async () => {
	let signal: AbortSignal | undefined;
	const h = harness({
		getAvailableOfType: (_type, _provider, options) => {
			signal = options?.signal;
			return new Promise(() => {});
		},
	});
	const result = await h.service.judge(req, { timeoutMs: 20 });
	assert.equal(result.stopReason, "error");
	assert.ok(signal);
	assert.equal(signal.aborted, true);
});

test("R2: expiry between recovery leaves forbids further dispatch and late persistence", async () => {
	const wait = gate();
	const batches: string[][] = [];
	const h = harness({
		classify: async (_model, context) => {
			const ids = Object.keys(context.questions);
			batches.push(ids);
			if (ids.length > 1)
				return output(
					{},
					{ stopReason: "error", errorMessage: "context_length_exceeded" },
				);
			await wait.promise;
			return output(Object.fromEntries(ids.map((id) => [id, ans])));
		},
	});
	const result = await h.service.judge(
		{ state: {}, questions: { one: q, two: q } },
		{ timeoutMs: 30 },
	);
	assert.equal(result.stopReason, "error");
	assert.deepEqual(result.answers, {});
	assert.deepEqual(batches, [["one", "two"], ["one"]]);
	const rows = h.rows.length;
	wait.release();
	await sleep(5);
	assert.equal(h.rows.length, rows);
	assert.equal(h.rows.filter((row) => row.kind === "judgment").length, 0);
});

test("R2: a timed-out waiter cannot abort the independent owner's signal", async () => {
	const wait = gate(),
		entered = gate();
	let signal: AbortSignal | undefined,
		calls = 0;
	const h = harness({
		classify: async (_model, _context, options) => {
			calls++;
			signal = options?.signal;
			entered.release();
			await wait.promise;
			return output({ q: ans });
		},
	});
	const owner = h.service.judge(req);
	await entered.promise;
	const result = await h.service.judge(req, { timeoutMs: 20 });
	assert.equal(result.stopReason, "error");
	assert.deepEqual(result.answers, {});
	assert.equal(signal?.aborted, false);
	wait.release();
	assert.equal((await owner).stopReason, "stop");
	assert.equal(calls, 1);
});

test("R3: capacity observations recorded for active branch replay", async () => {
	const h = harness({
		classify: async () =>
			output(
				{ q: ans },
				{
					usage: {
						input: 20,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 21,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
				},
			),
	});
	assert.equal((await h.service.judge(req)).stopReason, "stop");
	assert.ok(h.rows.some((row) => row.kind === "capacity"));
});

test("R3: empty new branch does not retain learned overflow profile", async () => {
	let reject = true;
	const batches: string[][] = [];
	const h = harness({
		classify: async (_model, context) => {
			const ids = Object.keys(context.questions);
			batches.push(ids);
			if (reject && ids.length > 1)
				return output(
					{},
					{ stopReason: "error", errorMessage: "context_length_exceeded" },
				);
			return output(Object.fromEntries(ids.map((id) => [id, ans])));
		},
	});
	const input = { state: {}, questions: { one: q, two: q } };
	assert.equal((await h.service.judge(input)).stopReason, "stop");
	const before = batches.length;
	h.service.refreshBranch();
	reject = false;
	assert.equal((await h.service.judge(input)).stopReason, "stop");
	assert.deepEqual(batches.slice(before), [["one", "two"]]);
});

test("R3: compact active-branch capacity alone restores in a fresh service", async () => {
	const input = {
		state: { note: "private-state-body" },
		questions: { one: q, two: q },
	};
	const first = harness({
		classify: async (_model, context) => {
			const ids = Object.keys(context.questions);
			return ids.length > 1
				? output(
						{},
						{ stopReason: "error", errorMessage: "context_length_exceeded" },
					)
				: output(Object.fromEntries(ids.map((id) => [id, ans])));
		},
	});
	assert.equal((await first.service.judge(input)).stopReason, "stop");
	const records = first.rows.filter((row) => row.kind === "capacity");
	assert.ok(records.some((row) => row.attempt.outcome === "overflow"));
	assert.ok(records.some((row) => row.attempt.outcome === "answered"));
	assert.equal(JSON.stringify(records).includes("private-state-body"), false);
	for (const row of records) {
		assert.deepEqual(Object.keys(row).sort(), ["attempt", "channel", "kind"]);
		assert.ok(
			Object.keys(row.attempt).every((key) =>
				[
					"outcome",
					"stateBytes",
					"questionBytes",
					"longestQuestionBytes",
					"inputTokens",
				].includes(key),
			),
		);
	}
	const batches: string[][] = [];
	const resumed = harness({
		classify: async (_model, context) => {
			const ids = Object.keys(context.questions);
			batches.push(ids);
			return output(Object.fromEntries(ids.map((id) => [id, ans])));
		},
	});
	resumed.setBranch(
		records.map((data) => ({ type: "custom", customType: LEDGER_TYPE, data })),
	);
	resumed.service.refreshBranch();
	resumed.service.refreshBranch();
	assert.equal(resumed.rows.length, 0, "replay must not append observations");
	assert.equal((await resumed.service.judge(input)).stopReason, "stop");
	assert.deepEqual(batches, [["one"], ["two"]]);
});

test("R4: named-choice rule on bool rejected before dispatch", async () => {
	let calls = 0;
	const h = harness({
		classify: async () => {
			calls++;
			return output({ q: ans });
		},
	});
	const result = await h.service.judge(req, {
		thresholds: {
			q: { metric: "choiceProbability", choice: "yes", minimum: 0.8 },
		},
	});
	assert.equal(result.stopReason, "error");
	assert.equal(calls, 0);
});

test("R4: named-choice rule requires an own existing choice question", async () => {
	let calls = 0;
	const h = harness({
		classify: async () => {
			calls++;
			return output({ q: ans });
		},
	});
	for (const [input, id] of [
		[
			{
				state: {},
				questions: {
					q: {
						type: "score",
						instructions: "level",
						criteria: ["zero", "one"],
					},
				},
			},
			"q",
		],
		[req, "constructor"],
	] satisfies [JudgeRequest, string][]) {
		const result = await h.service.judge(input, {
			thresholds: {
				[id]: { metric: "choiceProbability", choice: "yes", minimum: 0.8 },
			},
		});
		assert.equal(result.stopReason, "error");
		assert.deepEqual(result.answers, {});
	}
	assert.equal(calls, 0);
});

test("R4: existing empty own choice key remains legal through gates, cache and restore", async () => {
	let calls = 0;
	const answer: ClassifierAnswer = {
		type: "choice",
		choice: "",
		probabilities: { "": 0.9, other: 0.1 },
		confidence: 0.9,
	};
	const h = harness({
		classify: async () => {
			calls++;
			return output({ q: answer });
		},
	});
	const input: JudgeRequest = {
		state: {},
		questions: {
			q: {
				type: "choice",
				instructions: "pick",
				criteria: { "": "empty", other: "other" },
			},
		},
	};
	const options = {
		thresholds: {
			q: { metric: "choiceProbability" as const, choice: "", minimum: 0.8 },
		},
	};
	const result = await h.service.judge(input, options);
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(result.answers.q, answer);
	assert.deepEqual((await h.service.judge(input, options)).answers.q, answer);
	assert.equal(calls, 1);
	h.setBranch(
		h.rows.map((data) => ({ type: "custom", customType: LEDGER_TYPE, data })),
	);
	h.service.refreshBranch();
	const restored = await h.service.judge(input, {
		thresholds: {
			q: { metric: "choiceProbability", choice: "", minimum: 0.95 },
		},
	});
	assert.equal(restored.stopReason, "stop");
	assert.deepEqual(restored.answers, {});
	assert.deepEqual(restored.dropped, ["q"]);
	assert.equal(calls, 1);
});

test("B1: elapsed synchronous discovery aborts its supplied deadline signal", async () => {
	let signal: AbortSignal | undefined;
	const h = harness({
		getAvailableOfType: (_type, _provider, options) => {
			signal = options?.signal;
			const end = Date.now() + 40;
			while (Date.now() < end) {
				/* Deliberately prevent the timer callback. */
			}
			return new Promise(() => {});
		},
	});
	const result = await h.service.judge(req, { timeoutMs: 20 });
	assert.equal(result.stopReason, "error");
	assert.equal(signal?.aborted, true);
	await sleep(5);
	assert.equal(signal?.aborted, true);
});

test("B1: late rejected discovery cannot terminate the caller process", () => {
	const service = new URL("../src/service.ts", import.meta.url).href;
	const config = new URL("../src/config.ts", import.meta.url).href;
	const script = `Promise.all([import(${JSON.stringify(service)}), import(${JSON.stringify(config)})]).then(async ([{createJudgmentService},{validateConfig}]) => {
		const settings = validateConfig({mode:'classifier',classifierModel:'native/kev',timeoutMs:20}).config;
		const service = createJudgmentService({config:()=>settings,registry:{getAuth:async()=>undefined,getProviders:()=>[],getAvailableOfType:async()=>{const end=Date.now()+40;while(Date.now()<end){};throw Error('synthetic late discovery rejection');},getModel:()=>undefined,classify:async()=>{throw Error('unused');},streamSimple:()=>{throw Error('unused');}},ledger:{append:undefined,branch:()=>[]}});
		const result = await service.judge({state:{},questions:{q:{type:'bool',instructions:'?',criteria:{true:'yes',false:'no'}}}});
		if(result.stopReason!=='error') throw Error('expected structured timeout');
		await new Promise(resolve=>setTimeout(resolve,10));
		console.log('process survived settled request');
	});`;
	const child = spawnSync(
		process.execPath,
		["--import", "tsx", "--eval", script],
		{
			cwd: new URL("..", import.meta.url).pathname,
			env: { ...process.env, TMPDIR: "/var/tmp" },
			encoding: "utf8",
			timeout: 10_000,
		},
	);
	assert.equal(child.status, 0, child.stdout + child.stderr);
	assert.match(child.stdout, /process survived settled request/);
});

test("B2: actual pre-repair failed-join ledger rows require a fresh judgment", async () => {
	// Emitted by the real frozen v2 service during the independent review,
	// not fabricated keys or inferred provenance from neighboring diagnostics.
	const old: unknown = JSON.parse(
		await readFile(
			new URL("./fixtures/pre-repair-failed-join-ledger.json", import.meta.url),
			"utf8",
		),
	);
	assert.ok(Array.isArray(old));
	const before = JSON.stringify(old);
	let calls = 0;
	const h = harness({
		classify: async () => {
			calls++;
			return output({ q: { type: "bool", probability: 0.1 } });
		},
	});
	h.setBranch(
		old.map((data) => ({ type: "custom", customType: LEDGER_TYPE, data })),
	);
	h.service.refreshBranch();
	const result = await h.service.judge(req);
	assert.equal(result.stopReason, "stop");
	assert.equal(result.reuse.hits, 0);
	assert.deepEqual(result.answers.q, { type: "bool", probability: 0.1 });
	assert.equal(calls, 1);
	assert.equal(
		JSON.stringify(old),
		before,
		"old session entries must not be rewritten",
	);
});
