import assert from "node:assert/strict";
import test from "node:test";
import type {
	ClassifierApi,
	ClassifierModel,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import {
	classifyWithModel,
	findJevModel,
	isJevClassifierModel,
	JEV_PROVIDER_PRIORITY,
	type JevRegistry,
	resolveNativeClassifier,
	selectJevModel,
} from "../src/backend-jev.ts";
import { newAttemptClocks } from "../src/service.ts";

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

	async getAvailableOfType(): Promise<readonly AnyClassifierModel[]> {
		return [...this.available];
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

/** Clocks shorthand: caller signal plus the given idle/hard durations. */
function clocks(
	signal?: AbortSignal,
	idleTimeoutMs = 10_000,
	modelTimeoutMs?: number,
) {
	return newAttemptClocks({ idleTimeoutMs, modelTimeoutMs }, signal);
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

test("resolveNativeClassifier pins an explicit non-Jev selection exactly", async () => {
	const registry = new FakeJevRegistry();
	const kev = classifier("openrouter", "jaredpalmer/kev-4b");
	registry.available = [kev, classifier("typesafe", "jev-latest")];
	const resolved = await resolveNativeClassifier(registry, {
		classifierModel: "openrouter/jaredpalmer/kev-4b",
	});
	assert.ok("model" in resolved);
	if ("model" in resolved)
		assert.equal(resolved.model.id, "jaredpalmer/kev-4b");
});

test("resolveNativeClassifier missing explicit model never substitutes", async () => {
	const registry = new FakeJevRegistry();
	registry.available = [classifier("typesafe", "jev-latest")];
	const resolved = await resolveNativeClassifier(registry, {
		classifierModel: "ghost/net-clf",
	});
	assert.ok("error" in resolved);
	if ("error" in resolved) assert.match(resolved.error, /ghost\/net-clf/);
});

test("resolveNativeClassifier excludes own emulation even when listed", async () => {
	const registry = new FakeJevRegistry();
	registry.available = [
		classifier("llm-as-jev", "fake/fake-model"),
		classifier("typesafe", "jev-latest"),
	];
	const resolved = await resolveNativeClassifier(registry, {
		classifierModel: "llm-as-jev/fake/fake-model",
	});
	assert.ok("error" in resolved);
});

test("classifyWithModel dispatches the pinned model without rediscovery", async () => {
	const registry = new FakeJevRegistry();
	const pinned = classifier("openrouter", "jaredpalmer/kev-4b");
	registry.available = [classifier("typesafe", "jev-latest")];
	const c = clocks();
	const result = await classifyWithModel(
		registry,
		pinned,
		{ state: {}, questions: {} },
		{ signal: c.signal },
	);
	c.dispose();
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
	const c = clocks(controller.signal);
	const result = await classifyWithModel(
		registry,
		pinned,
		{ state: {}, questions: {} },
		{ signal: c.signal },
	);
	c.dispose();
	assert.equal(result.stopReason, "aborted");
	assert.equal(registry.classifyCalls.length, 0);
});

test("classifyWithModel abort settles when the registry stops on the signal", async () => {
	const registry = new FakeJevRegistry();
	const pinned = classifier("typesafe", "jev-latest");
	registry.delayMs = 5_000;
	const controller = new AbortController();
	const c = clocks(controller.signal);
	const pending = classifyWithModel(
		registry,
		pinned,
		{ state: {}, questions: {} },
		{ signal: c.signal },
	);
	await new Promise((resolve) => setTimeout(resolve, 10));
	controller.abort();
	const result = await pending;
	c.dispose();
	assert.equal(result.stopReason, "aborted");
});

test("classifyWithModel settles when the attempt clock fires on a hung registry", async () => {
	const registry = new FakeJevRegistry();
	const pinned = classifier("typesafe", "jev-latest");
	// Registry classify hangs forever but never observes its signal.
	registry.classify = () => new Promise<ClassifierResult>(() => {});
	const c = clocks(undefined, 30);
	const result = await classifyWithModel(
		registry,
		pinned,
		{ state: {}, questions: {} },
		{ signal: c.signal },
	);
	c.dispose();
	// Signal race settles the call as aborted; the service maps it to the
	// clock that actually fired (idle vs hard vs caller).
	assert.equal(result.stopReason, "aborted");
});

test("classify rejection is a structured error, never thrown", async () => {
	const registry = new FakeJevRegistry();
	const pinned = classifier("typesafe", "jev-latest");
	registry.error = new Error("401 unauthorized");
	const c = clocks();
	const result = await classifyWithModel(
		registry,
		pinned,
		{ state: {}, questions: {} },
		{ signal: c.signal },
	);
	c.dispose();
	assert.equal(result.stopReason, "error");
});
