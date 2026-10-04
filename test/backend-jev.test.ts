import assert from "node:assert/strict";
import test from "node:test";
import type {
	ClassifierApi,
	ClassifierModel,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import {
	classifyWithJev,
	classifyWithModel,
	classifyWithNative,
	findJevModel,
	isJevClassifierModel,
	JEV_PROVIDER_PRIORITY,
	type JevRegistry,
	selectJevModel,
} from "../src/backend-jev.ts";

type AnyClassifierModel = ClassifierModel<ClassifierApi>;

function emptyResult(model: AnyClassifierModel): ClassifierResult {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function classifier(provider: string, id: string): AnyClassifierModel {
	return {
		type: "classifier",
		id,
		provider,
		name: id,
		api: "typesafe-system-one",
		baseUrl: "https://unused.invalid",
		input: ["text"],
		contextWindow: 64000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

/** Fake registry with scripted availability and classify behavior. */
class FakeJevRegistry implements JevRegistry {
	available: AnyClassifierModel[] = [];
	classifyCalls: { model: AnyClassifierModel; options?: unknown }[] = [];
	result: ClassifierResult | undefined;
	error: Error | undefined;
	delayMs = 0;
	signalSeen: AbortSignal[] = [];
	/** When set, discovery never settles and ignores its abort signal. */
	discoveryHangs = false;
	/** Optional discovery latency in ms (settles normally after the delay). */
	discoveryDelayMs = 0;

	getAvailableOfType(): Promise<readonly AnyClassifierModel[]> {
		if (this.discoveryHangs) {
			return new Promise(() => {});
		}
		if (this.discoveryDelayMs > 0) {
			return new Promise((resolve) => {
				setTimeout(() => resolve([...this.available]), this.discoveryDelayMs);
			});
		}
		return Promise.resolve([...this.available]);
	}

	classify(
		model: AnyClassifierModel,
		_context: unknown,
		options?: { signal?: AbortSignal },
	): Promise<ClassifierResult> {
		this.classifyCalls.push({ model, options });
		if (options?.signal) this.signalSeen.push(options.signal);
		if (this.error) return Promise.reject(this.error);
		if (this.delayMs > 0) {
			return new Promise<ClassifierResult>((resolve) => {
				const timer = setTimeout(
					() => resolve(this.result ?? emptyResult(model)),
					this.delayMs,
				);
				options?.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve({
						api: model.api,
						provider: model.provider,
						model: model.id,
						answers: {},
						stopReason: "aborted" as const,
						timestamp: Date.now(),
					});
				});
			});
		}
		return Promise.resolve(this.result ?? emptyResult(model));
	}
}

test("jev identity filter keeps jev variants, rejects other classifiers", () => {
	assert.equal(
		isJevClassifierModel(classifier("typesafe", "jev-latest")),
		true,
	);
	assert.equal(
		isJevClassifierModel(classifier("openrouter", "~typesafe/jev-latest")),
		true,
	);
	assert.equal(
		isJevClassifierModel(classifier("cloudflare-workers-ai", "typesafe/jev")),
		true,
	);
	assert.equal(
		isJevClassifierModel(classifier("opencode", "jev-1.13-free")),
		true,
	);
	assert.equal(
		isJevClassifierModel(classifier("vercel-ai-gateway", "typesafe-ai/jev")),
		true,
	);
	// Non-jev classifiers hosted on the same supported providers.
	assert.equal(
		isJevClassifierModel(classifier("openrouter", "jaredpalmer/kev-4b")),
		false,
	);
	assert.equal(
		isJevClassifierModel(
			classifier("openrouter", "inception/mercury-decide:free"),
		),
		false,
	);
	assert.equal(
		isJevClassifierModel(classifier("openrouter", "respan/span-01")),
		false,
	);
	assert.equal(
		isJevClassifierModel(classifier("vercel-ai-gateway", "liquid/d1")),
		false,
	);
	assert.equal(
		isJevClassifierModel(
			classifier("openrouter", "togethercomputer/tev1-4b-experimental"),
		),
		false,
	);
	// Our own emulation provider is excluded even with a jev-shaped id.
	assert.equal(
		isJevClassifierModel(classifier("llm-as-jev", "typesafe/jev")),
		false,
	);
	// Prefix must be segment-anchored: kev-jev-like ids do not qualify.
	assert.equal(isJevClassifierModel(classifier("typesafe", "notjev-1")), false);
});

test("selection order follows provider priority then id", () => {
	const picked = selectJevModel([
		classifier("opencode", "jev-1.13"),
		classifier("vercel-ai-gateway", "typesafe-ai/jev"),
		classifier("openrouter", "~typesafe/jev-latest"),
		classifier("typesafe", "jev-latest"),
		classifier("cloudflare-workers-ai", "typesafe/jev"),
	]);
	assert.equal(picked?.provider, "typesafe");

	const withoutTypesafe = selectJevModel([
		classifier("opencode", "jev-1.13"),
		classifier("openrouter", "~typesafe/jev-latest"),
	]);
	assert.equal(withoutTypesafe?.provider, "openrouter");

	const ties = selectJevModel([
		classifier("openrouter", "~typesafe/jev-1.13"),
		classifier("openrouter", "typesafe/jev-1.13"),
	]);
	assert.equal(ties?.id, "typesafe/jev-1.13");

	assert.equal(
		selectJevModel([
			classifier("openrouter", "jaredpalmer/kev-4b"),
			classifier("openrouter", "respan/span-01"),
		]),
		undefined,
	);
	assert.deepEqual(JEV_PROVIDER_PRIORITY, [
		"typesafe",
		"openrouter",
		"cloudflare-workers-ai",
		"vercel-ai-gateway",
		"opencode",
	]);
});

test("findJevModel returns undefined when nothing jev is available", async () => {
	const registry = new FakeJevRegistry();
	registry.available = [classifier("openrouter", "respan/span-01")];
	assert.equal(await findJevModel(registry), undefined);
});

test("classifyWithJev delegates to the selected model and registry result", async () => {
	const registry = new FakeJevRegistry();
	const typesafe = classifier("typesafe", "jev-latest");
	const opencode = classifier("opencode", "jev-1.13");
	registry.available = [
		classifier("openrouter", "jaredpalmer/kev-4b"),
		opencode,
		typesafe,
	];
	registry.result = {
		api: typesafe.api,
		provider: typesafe.provider,
		model: typesafe.id,
		answers: { q: { type: "bool", probability: 0.8 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const result = await classifyWithJev(registry, {
		state: {},
		questions: {},
	});
	assert.equal(result.stopReason, "stop");
	assert.equal(registry.classifyCalls.length, 1);
	assert.equal(registry.classifyCalls[0]?.model.provider, "typesafe");
});

test("none-available error is structured, not thrown", async () => {
	const registry = new FakeJevRegistry();
	const result = await classifyWithJev(registry, { state: {}, questions: {} });
	assert.equal(result.stopReason, "error");
	assert.match(
		result.errorMessage ?? "",
		/No Jev classifier model is available/,
	);
	assert.equal(registry.classifyCalls.length, 0);
});

test("pre-aborted caller yields aborted without discovery or classify", async () => {
	const registry = new FakeJevRegistry();
	const controller = new AbortController();
	controller.abort();
	const result = await classifyWithJev(
		registry,
		{ state: {}, questions: {} },
		{
			signal: controller.signal,
		},
	);
	assert.equal(result.stopReason, "aborted");
	assert.equal(registry.classifyCalls.length, 0);
});

test("abort during classification surfaces the registry's aborted result", async () => {
	const registry = new FakeJevRegistry();
	registry.available = [classifier("typesafe", "jev-latest")];
	registry.delayMs = 60;
	const controller = new AbortController();
	const pending = classifyWithJev(
		registry,
		{ state: {}, questions: {} },
		{ signal: controller.signal },
	);
	await new Promise((resolve) => setTimeout(resolve, 5));
	controller.abort();
	const result = await pending;
	assert.equal(result.stopReason, "aborted");
	assert.equal(registry.classifyCalls.length, 1);
});

test("timeout returns a structured timeout error without waiting forever", async () => {
	const registry = new FakeJevRegistry();
	registry.available = [classifier("typesafe", "jev-latest")];
	registry.delayMs = 5_000;
	const result = await classifyWithJev(
		registry,
		{ state: {}, questions: {} },
		{ timeoutMs: 40 },
	);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /timed out after 40ms/);
});

test("classify rejection is a structured error, never thrown", async () => {
	const registry = new FakeJevRegistry();
	registry.available = [classifier("typesafe", "jev-latest")];
	registry.error = new Error("401 unauthorized");
	const result = await classifyWithJev(registry, { state: {}, questions: {} });
	assert.equal(result.stopReason, "error");
});

test("hung discovery settles as a timeout error even when the registry ignores the signal", async () => {
	const registry = new FakeJevRegistry();
	registry.available = [classifier("typesafe", "jev-latest")];
	registry.discoveryHangs = true;
	const result = await withTimeout(
		classifyWithJev(registry, { state: {}, questions: {} }, { timeoutMs: 15 }),
		200,
		"classifyWithJev did not settle within 200ms",
	);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /timed out after 15ms/);
	assert.equal(registry.classifyCalls.length, 0);
});

test("caller abort during hung discovery yields aborted, not error", async () => {
	const registry = new FakeJevRegistry();
	registry.available = [classifier("typesafe", "jev-latest")];
	registry.discoveryHangs = true;
	const controller = new AbortController();
	const pending = classifyWithJev(
		registry,
		{ state: {}, questions: {} },
		{ signal: controller.signal },
	);
	await sleep(20);
	controller.abort();
	const result = await withTimeout(
		pending,
		200,
		"classifyWithJev did not settle after caller abort",
	);
	assert.equal(result.stopReason, "aborted");
	assert.equal(registry.classifyCalls.length, 0);
});

test("expired deadline after discovery returns timeout error without dispatching classify", async () => {
	const registry = new FakeJevRegistry();
	const model = classifier("typesafe", "jev-latest");
	registry.available = [model];
	registry.delayMs = 5_000;
	// Consume the whole budget inside discovery: classify must never dispatch.
	registry.discoveryDelayMs = 25;
	const result = await classifyWithJev(
		registry,
		{ state: {}, questions: {} },
		{ timeoutMs: 10 },
	);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /timed out after 10ms/);
	assert.equal(registry.classifyCalls.length, 0);
});

test("no-dispatch guarantee holds even for a slow classify result arriving late", async () => {
	const registry = new FakeJevRegistry();
	registry.available = [classifier("typesafe", "jev-latest")];
	registry.delayMs = 5_000;
	const result = await classifyWithJev(
		registry,
		{ state: {}, questions: {} },
		{ timeoutMs: 30 },
	);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /timed out after 30ms/);
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	message: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	try {
		return await Promise.race([promise, guard]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// classifyWithModel pinned dispatch + explicit-classifier selection (task 5.1)
// ---------------------------------------------------------------------------

test("classifyWithModel dispatches the pinned model without rediscovery", async () => {
	const registry = new FakeJevRegistry();
	const pinned = classifier("openrouter", "jaredpalmer/kev-4b");
	registry.available = [classifier("typesafe", "jev-latest")];
	const result = await classifyWithModel(
		registry,
		pinned,
		{ state: {}, questions: {} },
		{ timeoutMs: 5000 },
	);
	assert.equal(result.stopReason, "stop");
	assert.equal(registry.classifyCalls.length, 1);
	assert.equal(registry.classifyCalls[0]?.model.provider, "openrouter");
	assert.equal(registry.classifyCalls[0]?.model.id, "jaredpalmer/kev-4b");
});

test("classifyWithModel honors caller abort before dispatch", async () => {
	const registry = new FakeJevRegistry();
	const pinned = classifier("typesafe", "jev-latest");
	const controller = new AbortController();
	controller.abort();
	const result = await classifyWithModel(
		registry,
		pinned,
		{ state: {}, questions: {} },
		{ signal: controller.signal },
	);
	assert.equal(result.stopReason, "aborted");
	assert.equal(registry.classifyCalls.length, 0);
});

test("classifyWithModel never dispatches after the deadline", async () => {
	const registry = new FakeJevRegistry();
	const pinned = classifier("typesafe", "jev-latest");
	registry.delayMs = 5_000;
	const result = await classifyWithModel(
		registry,
		pinned,
		{ state: {}, questions: {} },
		{ timeoutMs: 30 },
	);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /timed out after 30ms/);
});

test("classifyWithNative explicit non-Jev selection pins that exact model", async () => {
	const registry = new FakeJevRegistry();
	const kev = classifier("openrouter", "jaredpalmer/kev-4b");
	registry.available = [kev, classifier("typesafe", "jev-latest")];
	const result = await classifyWithNative(
		registry,
		{ classifierModel: "openrouter/jaredpalmer/kev-4b" },
		{ state: {}, questions: {} },
		{ timeoutMs: 5000 },
	);
	assert.equal(result.stopReason, "stop");
	assert.equal(registry.classifyCalls.length, 1);
	assert.equal(registry.classifyCalls[0]?.model.id, "jaredpalmer/kev-4b");
});

test("classifyWithNative missing explicit model does not substitute another native model", async () => {
	const registry = new FakeJevRegistry();
	registry.available = [classifier("typesafe", "jev-latest")];
	const result = await classifyWithNative(
		registry,
		{ classifierModel: "ghost/net-clf" },
		{ state: {}, questions: {} },
		{ timeoutMs: 5000 },
	);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /ghost\/net-clf/);
	assert.equal(registry.classifyCalls.length, 0);
});

test("classifyWithNative own emulation reference is rejected, never dispatched", async () => {
	const registry = new FakeJevRegistry();
	registry.available = [
		classifier("llm-as-jev", "fake/fake-model"),
		classifier("typesafe", "jev-latest"),
	];
	const result = await classifyWithNative(
		registry,
		{ classifierModel: "llm-as-jev/fake/fake-model" },
		{ state: {}, questions: {} },
		{ timeoutMs: 5000 },
	);
	assert.equal(result.stopReason, "error");
	assert.equal(registry.classifyCalls.length, 0);
});

test("classifyWithNative default still prefers Jev by provider priority", async () => {
	const registry = new FakeJevRegistry();
	registry.available = [
		classifier("opencode", "jev-1.13"),
		classifier("typesafe", "jev-latest"),
	];
	const result = await classifyWithNative(
		registry,
		{},
		{ state: {}, questions: {} },
		{ timeoutMs: 5000 },
	);
	assert.equal(result.stopReason, "stop");
	assert.equal(registry.classifyCalls[0]?.model.provider, "typesafe");
});

test("classifyWithJev keeps working as the standalone Jev entry point", async () => {
	const registry = new FakeJevRegistry();
	registry.available = [classifier("typesafe", "jev-latest")];
	const result = await classifyWithJev(registry, {
		state: {},
		questions: {},
	});
	assert.equal(result.stopReason, "stop");
	assert.equal(registry.classifyCalls.length, 1);
	assert.equal(registry.classifyCalls[0]?.model.provider, "typesafe");
});
