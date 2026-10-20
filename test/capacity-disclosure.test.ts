/**
 * backend-capacity-disclosure (capacityVersion 2): describeSelection() and
 * JudgeResult.capacity report DECLARED limits with source override/model/none
 * — no learned ratios, channel constants, envelope estimates or inference.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	Api,
	ClassifierApi,
	ClassifierModel,
	ClassifierResult,
	Model,
	Usage,
} from "@earendil-works/pi-ai";
import type { JudgmentConfig } from "../src/config.ts";
import type { ServiceRegistry } from "../src/service.ts";
import { createJudgmentService } from "../src/service.ts";

type AnyModel = Model<Api>;
type AnyClassifierModel = ClassifierModel<ClassifierApi>;

const USAGE: Usage = {
	input: 40,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 40,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function jev(contextWindow?: number): AnyClassifierModel {
	return {
		type: "classifier",
		id: "jev-1.13",
		provider: "typesafe",
		name: "jev",
		api: "typesafe-system-one",
		baseUrl: "https://api.typesafe.ai/v1",
		input: ["text"],
		contextWindow,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as unknown as AnyClassifierModel;
}

function chat(contextWindow?: number): AnyModel {
	return {
		id: "fake-model",
		provider: "fake",
		name: "fake",
		api: "openai-completions",
		baseUrl: "https://unused.invalid",
		input: ["text"],
		contextWindow,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as unknown as AnyModel;
}

class Registry implements ServiceRegistry {
	classifyCalls = 0;
	constructor(
		public native?: AnyClassifierModel,
		public llm?: AnyModel,
	) {}
	getProviders() {
		return [{ id: "typesafe" }, { id: "fake" }];
	}
	async getAuth(_provider?: string): ReturnType<ServiceRegistry["getAuth"]> {
		return { auth: { apiKey: "k" } };
	}
	getModel(provider: string, id: string) {
		return this.llm && this.llm.provider === provider && this.llm.id === id
			? this.llm
			: undefined;
	}
	async getAvailableOfType(): Promise<readonly AnyClassifierModel[]> {
		return this.native ? [this.native] : [];
	}
	async classify(
		model: AnyClassifierModel,
		context: { questions: Record<string, unknown> },
	): Promise<ClassifierResult> {
		this.classifyCalls++;
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(context.questions))
			answers[id] = { type: "bool", probability: 0.9 };
		return {
			api: model.api,
			provider: model.provider,
			model: `${model.provider}/${model.id}`,
			answers: answers as ClassifierResult["answers"],
			stopReason: "stop",
			usage: USAGE,
			timestamp: Date.now(),
		};
	}
	streamSimple(): never {
		throw new Error("unused");
	}
}

function config(over: Partial<JudgmentConfig>): JudgmentConfig {
	return { mode: "classifier", thinkingLevel: "off", ...over };
}

const Q = {
	q: {
		type: "bool" as const,
		instructions: "?",
		criteria: { true: "y", false: "n" },
	},
};

test("model metadata is reported with source model; no learned fields exist", async () => {
	const svc = createJudgmentService({
		registry: new Registry(jev(8192)),
		config: () => config({}),
	});
	assert.equal(svc.capacityVersion, 2);
	const d = await svc.describeSelection?.();
	assert.ok(d && !("error" in d), JSON.stringify(d));
	if ("error" in d) return;
	assert.equal(d.backend, "classifier");
	assert.equal(d.model, "typesafe/jev-1.13");
	assert.equal(d.limitSource, "model");
	assert.deepEqual(d.limits, { contextWindow: 8192 });
	// v2 shape: no learned/envelope fields at all.
	const keys = Object.keys(d).sort();
	assert.deepEqual(keys, ["backend", "limitSource", "limits", "model"]);
});

test("exact configured override wins; unrelated channel constants are gone", async () => {
	const svc = createJudgmentService({
		registry: new Registry(jev(8192)),
		config: () =>
			config({ contextLimits: { "typesafe/jev-1.13": { request: 1234 } } }),
	});
	const d = await svc.describeSelection?.();
	assert.ok(d && !("error" in d));
	if ("error" in d) return;
	assert.equal(d.limitSource, "override");
	assert.deepEqual(d.limits, { request: 1234 });
});

test("a recognized built-in channel gets only override or model metadata", async () => {
	// TypeSafe direct Jev previously carried review-only channel constants;
	// v2 reports the model's own window or an exact override only.
	const svc = createJudgmentService({
		registry: new Registry(jev(8192)),
		config: () => config({}),
	});
	const d = await svc.describeSelection?.();
	assert.ok(d && !("error" in d));
	if ("error" in d) return;
	assert.notEqual(d.limitSource, "channel" as never);
	assert.equal(d.limitSource, "model");
});

test("absent metadata stays absent with source none", async () => {
	const svc = createJudgmentService({
		registry: new Registry(undefined, chat(undefined)),
		config: () =>
			config({
				mode: "llm",
				model: "fake/fake-model",
				provider: "fake",
				modelId: "fake-model",
			}),
	});
	const d = await svc.describeSelection?.();
	assert.ok(d && !("error" in d));
	if ("error" in d) return;
	assert.equal(d.limitSource, "none");
	assert.deepEqual(d.limits, {});
});

test("config change between queries is observed without inference", async () => {
	const registry = new Registry(undefined, chat(128000));
	let current = config({
		mode: "llm",
		model: "fake/fake-model",
		provider: "fake",
		modelId: "fake-model",
	});
	const svc = createJudgmentService({ registry, config: () => current });
	const d = await svc.describeSelection?.();
	assert.ok(d && !("error" in d));
	if (!("error" in d)) assert.deepEqual(d.limits, { contextWindow: 128000 });
	current = config({ mode: "llm" });
	const e = await svc.describeSelection?.();
	assert.ok(e && "error" in e);
	assert.equal(registry.classifyCalls, 0);
});

test("result capacity belongs to the terminal attempt's model", async () => {
	const registry = new Registry(jev(8192));
	const svc = createJudgmentService({
		registry,
		config: () => config({}),
	});
	const result = await svc.judge({ state: {}, questions: Q });
	assert.equal(result.stopReason, "stop");
	assert.equal(result.capacity?.model, "typesafe/jev-1.13");
	assert.equal(result.capacity?.limitSource, "model");
	assert.equal(result.capacity?.limits.contextWindow, 8192);
});

test("capacity and availability skip unauthenticated configured LLM without inference", async () => {
	const registry = new Registry(jev(8192), chat(4096));
	registry.getAuth = async (provider?: string) =>
		provider === "fake" ? undefined : { auth: { apiKey: "k" } };
	const svc = createJudgmentService({
		registry,
		config: () =>
			config({
				mode: "auto-llm",
				model: "fake/fake-model",
				provider: "fake",
				modelId: "fake-model",
			}),
	});
	const selected = await svc.describeSelection?.();
	assert.ok(selected && !("error" in selected));
	if (!("error" in selected)) assert.equal(selected.backend, "classifier");
	assert.deepEqual(await svc.availability(), {
		classifier: "typesafe/jev-1.13",
	});
	assert.equal(registry.classifyCalls, 0);
});

test("credential-free resolved Pi auth is ready for capacity and availability", async () => {
	const registry = new Registry(undefined, chat(4096));
	registry.getAuth = async () => ({ auth: {} });
	const svc = createJudgmentService({
		registry,
		config: () =>
			config({
				mode: "llm",
				model: "fake/fake-model",
				provider: "fake",
				modelId: "fake-model",
			}),
	});
	const selected = await svc.describeSelection?.();
	assert.ok(selected && !("error" in selected));
	if (!("error" in selected)) assert.equal(selected.backend, "llm");
	assert.deepEqual(await svc.availability(), { llm: "fake/fake-model" });
	assert.equal(registry.classifyCalls, 0);
});

for (const mode of ["auto", "auto-llm"] as const) {
	for (const clock of ["idleTimeoutMs", "modelTimeoutMs"] as const) {
		test(`${mode} metadata gives alternate fresh ${clock} after preferred hangs`, async () => {
			const registry = new Registry(jev(8192), chat(4096));
			registry.getAvailableOfType = async () => {
				if (mode === "auto") return new Promise(() => {});
				await new Promise((resolve) => setTimeout(resolve, 45));
				return [jev(8192)];
			};
			registry.getAuth = async (provider?: string) => {
				if (provider === "fake") {
					if (mode === "auto-llm") return new Promise(() => {});
					await new Promise((resolve) => setTimeout(resolve, 45));
				}
				return { auth: { apiKey: "k" } };
			};
			const svc = createJudgmentService({
				registry,
				config: () =>
					config({
						mode,
						model: "fake/fake-model",
						provider: "fake",
						modelId: "fake-model",
						timeouts: {
							classifier: {
								idleTimeoutMs: 150,
								[clock]: mode === "auto" ? 20 : 150,
							},
							llm: {
								idleTimeoutMs: 150,
								[clock]: mode === "auto-llm" ? 20 : 150,
							},
						},
					}),
			});
			const selected = await svc.describeSelection?.();
			assert.ok(selected && !("error" in selected), JSON.stringify(selected));
			if (!("error" in selected))
				assert.equal(selected.backend, mode === "auto" ? "llm" : "classifier");
			assert.deepEqual(
				await svc.availability(),
				mode === "auto"
					? { llm: "fake/fake-model" }
					: { classifier: "typesafe/jev-1.13" },
			);
			assert.equal(registry.classifyCalls, 0);
		});
	}

	test(`${mode} metadata caller cancellation is terminal before alternate setup`, async () => {
		const registry = new Registry(jev(8192), chat(4096));
		const controller = new AbortController();
		let alternateCalls = 0;
		registry.getAvailableOfType = async () => {
			if (mode === "auto") {
				controller.abort();
				return new Promise(() => {});
			}
			alternateCalls++;
			return [jev(8192)];
		};
		registry.getAuth = async (provider?: string) => {
			if (mode === "auto-llm" && provider === "fake") {
				controller.abort();
				return new Promise(() => {});
			}
			if (mode === "auto" && provider === "fake") alternateCalls++;
			return { auth: { apiKey: "k" } };
		};
		const svc = createJudgmentService({
			registry,
			config: () =>
				config({
					mode,
					model: "fake/fake-model",
					provider: "fake",
					modelId: "fake-model",
				}),
		});
		assert.deepEqual(
			await svc.describeSelection?.({ signal: controller.signal }),
			{ error: "aborted" },
		);
		assert.equal(alternateCalls, 0);
		assert.equal(registry.classifyCalls, 0);
	});
}

test("pre-aborted query returns aborted without discovery", async () => {
	const registry = new Registry(jev(8192));
	let discoveries = 0;
	registry.getAvailableOfType = async () => {
		discoveries++;
		return registry.native ? [registry.native] : [];
	};
	const svc = createJudgmentService({
		registry,
		config: () => config({}),
	});
	const aborted = new AbortController();
	aborted.abort();
	assert.deepEqual(await svc.describeSelection?.({ signal: aborted.signal }), {
		error: "aborted",
	});
	assert.equal(discoveries, 0);
});
