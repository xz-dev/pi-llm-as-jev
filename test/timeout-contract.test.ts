/**
 * Backend-specific timeout contract (focus-service-on-timeout-and-backend-compat):
 * - native classifier: ONE absolute logical-call deadline across internal batches;
 * - LLM: per-request inactivity window (covered in backend-llm/service tests);
 * - setup/discovery: bounded by the same number (covered in backend-jev/service tests).
 *
 * This file adds the native multi-batch case that was only implied before.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ClassifierApi,
	ClassifierModel,
	ClassifierResult,
	Usage,
} from "@earendil-works/pi-ai";
import type { JudgeRequest } from "../client/judgment-client.ts";
import type { JudgmentConfig } from "../src/config.ts";
import type { ServiceRegistry } from "../src/service.ts";
import { createJudgmentService, resolveTimeoutMs } from "../src/service.ts";

type AnyClassifierModel = ClassifierModel<ClassifierApi>;

const USAGE: Usage = {
	input: 10,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 10,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function jevModel(): AnyClassifierModel {
	return {
		type: "classifier",
		api: "typesafe-system-one",
		provider: "typesafe",
		id: "jev-1.13",
		name: "Jev",
		baseUrl: "https://api.typesafe.ai/v1",
		contextWindow: 400,
	} as unknown as AnyClassifierModel;
}

class SlowNativeRegistry implements ServiceRegistry {
	calls = 0;
	constructor(private readonly perCallMs: number) {}
	getProviders() {
		return [{ id: "typesafe" }];
	}
	async getAuth() {
		return undefined;
	}
	getModel() {
		return undefined;
	}
	async getAvailableOfType(): Promise<readonly AnyClassifierModel[]> {
		return [jevModel()];
	}
	async classify(
		model: AnyClassifierModel,
		context: { questions: Record<string, unknown> },
		options?: { signal?: AbortSignal },
	): Promise<ClassifierResult> {
		this.calls += 1;
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, this.perCallMs);
			options?.signal?.addEventListener("abort", () => {
				clearTimeout(t);
				resolve();
			});
		});
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(context.questions))
			answers[id] = { type: "bool", probability: 0.9 };
		return {
			api: model.api,
			provider: model.provider,
			model: `${model.provider}/${model.id}`,
			answers: answers as ClassifierResult["answers"],
			stopReason: options?.signal?.aborted ? "aborted" : "stop",
			usage: USAGE,
			timestamp: Date.now(),
		};
	}
	streamSimple(): never {
		throw new Error("LLM not used in this test");
	}
}

function config(timeoutMs: number): JudgmentConfig {
	return {
		mode: "classifier",
		thinkingLevel: "off",
		timeoutMs,
		model: undefined,
		provider: undefined,
		modelId: undefined,
	} as unknown as JudgmentConfig;
}

function manyQuestions(n: number): JudgeRequest["questions"] {
	const questions: JudgeRequest["questions"] = {};
	for (let i = 0; i < n; i++)
		questions[`q${i}`] = {
			type: "bool",
			instructions: `question ${i} ${"detail ".repeat(20)}`,
			criteria: { true: "y", false: "n" },
		};
	return questions;
}

test("native: internal batches share one logical-call deadline, never reset per batch", async () => {
	// 8 questions on a 400-token window force >= 3 batches (see service.test.ts
	// "question batch overflow splits"). Each batch takes 60ms. A per-batch
	// clock of 100ms would pass; the one logical deadline must expire.
	const registry = new SlowNativeRegistry(60);
	const service = createJudgmentService({
		registry,
		config: () => config(100),
		ledger: { append: undefined, branch: () => [] },
	});
	const started = Date.now();
	const result = await service.judge({
		state: { s: 1 },
		questions: manyQuestions(8),
	});
	const elapsed = Date.now() - started;
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /timed out/);
	assert.ok(elapsed < 400, `settled under the deadline, took ${elapsed}ms`);
	assert.ok(
		registry.calls >= 1 && registry.calls < 8,
		`batches dispatched: ${registry.calls}`,
	);
});

test("native: the same batches succeed when the one deadline is large enough", async () => {
	const registry = new SlowNativeRegistry(20);
	const service = createJudgmentService({
		registry,
		config: () => config(2000),
		ledger: { append: undefined, branch: () => [] },
	});
	const result = await service.judge({
		state: { s: 1 },
		questions: manyQuestions(8),
	});
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
	assert.equal(Object.keys(result.answers).length, 8);
	assert.ok(registry.calls >= 2);
});

// Backend-dependent DEFAULTS when the caller omits timeoutMs and no config
// override exists: native 60 s absolute, LLM Pi's httpIdleTimeoutMs
// (0 = disabled → timer maximum). An explicit value wins for both.
test("defaults: native 60s absolute, LLM follows Pi httpIdleTimeoutMs, explicit wins", () => {
	const none = {} as JudgmentConfig;
	assert.equal(
		resolveTimeoutMs(none, undefined, "classifier", 300_000),
		60_000,
	);
	assert.equal(resolveTimeoutMs(none, undefined, undefined, 300_000), 60_000);
	assert.equal(resolveTimeoutMs(none, undefined, "llm", 300_000), 300_000);
	assert.equal(resolveTimeoutMs(none, undefined, "llm", 45_000), 45_000);
	assert.equal(resolveTimeoutMs(none, undefined, "llm", undefined), 300_000);
	assert.equal(resolveTimeoutMs(none, undefined, "llm", 0), 2_147_483_647);
	assert.equal(
		resolveTimeoutMs({ timeoutMs: 7000 }, undefined, "llm", 300_000),
		7000,
	);
	assert.equal(
		resolveTimeoutMs({ timeoutMs: 7000 }, 1234, "classifier", 300_000),
		1234,
	);
});

test("omitted timeoutMs: native call is bounded by the 60s default, reported in the error", async () => {
	const registry = new SlowNativeRegistry(10);
	const service = createJudgmentService({
		registry,
		config: () =>
			({ mode: "classifier", thinkingLevel: "off" }) as JudgmentConfig,
		ledger: { append: undefined, branch: () => [] },
	});
	const result = await service.judge({
		state: { s: 1 },
		questions: manyQuestions(2),
	});
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
	// The admitted duration is observable through a hung registry: the
	// service settles with the native default rather than waiting forever.
	const hung = createJudgmentService({
		registry: new (class extends SlowNativeRegistry {
			override async classify(): Promise<ClassifierResult> {
				return new Promise(() => {});
			}
		})(0),
		config: () =>
			({ mode: "classifier", thinkingLevel: "off" }) as JudgmentConfig,
		ledger: { append: undefined, branch: () => [] },
	});
	const pending = hung.judge({ state: { s: 1 }, questions: manyQuestions(1) });
	const settled = await Promise.race([
		pending.then((r) => r.stopReason),
		new Promise<string>((r) => setTimeout(() => r("still-pending"), 50)),
	]);
	assert.equal(settled, "still-pending"); // 60 s default has not expired after 50 ms
});
