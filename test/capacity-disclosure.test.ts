/**
 * backend-capacity-disclosure: describeSelection() and JudgeResult.capacity
 * report DECLARED limits with their source and the current calibration;
 * absent metadata is reported, never inferred.
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
import { PRIOR_TOKENS_PER_BYTE } from "../src/capacity.ts";
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

function jev(baseUrl: string, contextWindow?: number): AnyClassifierModel {
	return {
		type: "classifier",
		id: "jev-1.13",
		provider: "typesafe",
		name: "jev",
		api: "typesafe-system-one",
		baseUrl,
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
	constructor(
		public native?: AnyClassifierModel,
		public llm?: AnyModel,
	) {}
	getProviders() {
		return [{ id: "typesafe" }, { id: "fake" }];
	}
	async getAuth() {
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
	return {
		mode: "classifier",
		thinkingLevel: "off",
		timeoutMs: 1000,
		...over,
	} as JudgmentConfig;
}

function service(registry: ServiceRegistry, cfg: JudgmentConfig) {
	let current = cfg;
	const svc = createJudgmentService({
		registry,
		config: () => current,
		ledger: { append: undefined, branch: () => [] },
	});
	return { svc, set: (next: JudgmentConfig) => (current = next) };
}

const Q = {
	q: {
		type: "bool" as const,
		instructions: "?",
		criteria: { true: "y", false: "n" },
	},
};

test("channel constant: TypeSafe direct Jev discloses channel limits and the prior", async () => {
	const { svc } = service(
		new Registry(jev("https://api.typesafe.ai/v1", 8192)),
		config({}),
	);
	assert.equal(svc.capacityVersion, 1);
	const d = await svc.describeSelection?.({ path: "review" });
	assert.ok(d && !("error" in d), JSON.stringify(d));
	assert.equal(d.backend, "classifier");
	assert.equal(d.model, "typesafe/jev-1.13");
	assert.equal(d.limitSource, "channel");
	assert.deepEqual(d.limits, {
		request: 64000,
		stateAndLongestQuestion: 32000,
	});
	assert.equal(d.tokensPerByte, PRIOR_TOKENS_PER_BYTE);
	assert.equal(d.prior, true);
	assert.equal(d.envelopeOverheadBytes, 0);
});

test("override wins over channel constant", async () => {
	const { svc } = service(
		new Registry(jev("https://api.typesafe.ai/v1", 8192)),
		config({
			contextLimits: { "typesafe/jev-1.13": { request: 1234 } },
		} as Partial<JudgmentConfig>),
	);
	const d = await svc.describeSelection?.({ path: "review" });
	assert.ok(d && !("error" in d));
	assert.equal(d.limitSource, "override");
	assert.deepEqual(d.limits, { request: 1234 });
});

test("model metadata is the fallback; absent metadata is reported, not inferred", async () => {
	const withWindow = service(
		new Registry(jev("https://other.invalid/v1", 5000)),
		config({}),
	);
	const d1 = await withWindow.svc.describeSelection?.();
	assert.ok(d1 && !("error" in d1));
	assert.equal(d1.limitSource, "model");
	assert.deepEqual(d1.limits, { contextWindow: 5000 });

	const without = service(
		new Registry(jev("https://other.invalid/v1", undefined)),
		config({}),
	);
	const d2 = await without.svc.describeSelection?.();
	assert.ok(d2 && !("error" in d2));
	assert.equal(d2.limitSource, "none");
	assert.deepEqual(d2.limits, {});
});

test("LLM selection discloses envelope overhead; config change reflected on next call", async () => {
	const registry = new Registry(undefined, chat(128000));
	const { svc, set } = service(
		registry,
		config({
			mode: "llm",
			model: "fake/fake-model",
			provider: "fake",
			modelId: "fake-model",
		}),
	);
	const d = await svc.describeSelection?.();
	assert.ok(d && !("error" in d));
	assert.equal(d.backend, "llm");
	assert.equal(d.limitSource, "model");
	assert.deepEqual(d.limits, { contextWindow: 128000 });
	assert.ok(d.envelopeOverheadBytes > 0);

	set(
		config({
			mode: "llm",
			model: undefined,
			provider: undefined,
			modelId: undefined,
		}),
	);
	const e = await svc.describeSelection?.();
	assert.ok(e && "error" in e);
});

test("judge result freezes prediction capacity; the next query exposes learned calibration", async () => {
	const { svc } = service(
		new Registry(jev("https://api.typesafe.ai/v1", 8192)),
		config({}),
	);
	const before = await svc.describeSelection?.();
	assert.ok(before && !("error" in before) && before.prior === true);
	// Default path is judge(): model metadata, not channel constants.
	assert.equal(before.limitSource, "model");
	const result = await svc.judge({
		state: { s: "x".repeat(100) },
		questions: Q,
	});
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
	assert.ok(result.capacity, "capacity block present");
	assert.equal(result.capacity.model, "typesafe/jev-1.13");
	// judge() (non-review) uses model metadata, review() uses channel constants.
	assert.equal(result.capacity.limitSource, "model");
	assert.equal(result.capacity.prior, true);
	assert.equal(result.capacity.tokensPerByte, before.tokensPerByte);
	const after = await svc.describeSelection?.();
	assert.ok(after && !("error" in after));
	assert.equal(after.prior, false);
	assert.ok(after.tokensPerByte > 0);
});

test("selection query neither runs inference nor appends entries; pre-abort does not discover", async () => {
	const registry = new Registry(jev("https://api.typesafe.ai/v1", 8192));
	let discoveries = 0;
	registry.getAvailableOfType = async () => {
		discoveries++;
		return registry.native ? [registry.native] : [];
	};
	registry.classify = async () => {
		throw new Error("selection must not run inference");
	};
	const writes: unknown[] = [];
	const svc = createJudgmentService({
		registry,
		config: () => config({}),
		ledger: {
			append: (_type, data) => {
				writes.push(data);
			},
			branch: () => [],
		},
	});
	const aborted = new AbortController();
	aborted.abort();
	assert.deepEqual(await svc.describeSelection?.({ signal: aborted.signal }), {
		error: "aborted",
	});
	assert.equal(discoveries, 0);
	const first = await svc.describeSelection?.();
	const next = await svc.describeSelection?.();
	assert.deepEqual(next, first);
	assert.equal(writes.length, 0);
});
