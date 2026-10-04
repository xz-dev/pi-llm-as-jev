/**
 * Task 5.1 native selector tests: explicit `classifierModel` reference
 * selection (including non-Jev and slash-containing ids), wrong-type/missing/
 * own-emulation exclusion, default Jev discovery fallback, and pinned-model
 * dispatch (`classifyWithModel`) that never rediscovers a different model.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
	ClassifierApi,
	ClassifierModel,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import {
	classifyWithModel,
	type NativeRegistry,
	resolveNativeClassifier,
} from "../src/backend-jev.ts";

type AnyClassifierModel = ClassifierModel<ClassifierApi>;

function classifier(
	provider: string,
	id: string,
	api = "typesafe-system-one",
): AnyClassifierModel {
	return {
		type: "classifier",
		id,
		provider,
		name: id,
		api: api as ClassifierApi,
		baseUrl: "https://unused.invalid",
		input: ["text"],
		contextWindow: 64000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function chatModel(provider: string, id: string): unknown {
	return {
		type: undefined,
		id,
		provider,
		api: "openai-completions",
		baseUrl: "https://chat.invalid",
		input: ["text"],
		contextWindow: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

class FakeRegistry implements NativeRegistry {
	available: unknown[] = [];
	classifyCalls: { provider: string; id: string }[] = [];

	async getAvailableOfType(): Promise<readonly AnyClassifierModel[]> {
		return this.available.filter(
			(m): m is AnyClassifierModel =>
				(m as { type?: string }).type === "classifier",
		);
	}

	async getAvailable(): Promise<readonly unknown[]> {
		return this.available;
	}

	async classify(
		model: AnyClassifierModel,
		_context: unknown,
	): Promise<ClassifierResult> {
		this.classifyCalls.push({ provider: model.provider, id: model.id });
		return {
			api: model.api,
			provider: model.provider,
			model: model.id,
			answers: { q: { type: "bool", probability: 0.9 } },
			stopReason: "stop",
			timestamp: Date.now(),
		} as ClassifierResult;
	}
}

// ---------------------------------------------------------------------------
// Explicit reference selection (5.1)
// ---------------------------------------------------------------------------

test("explicit non-Jev classifier reference is honored exactly", async () => {
	const registry = new FakeRegistry();
	const nonJev = classifier("openrouter", "jaredpalmer/kev-4b");
	registry.available = [nonJev, classifier("typesafe", "jev-latest")];
	const resolved = await resolveNativeClassifier(registry, {
		classifierModel: "openrouter/jaredpalmer/kev-4b",
	});
	assert.ok("model" in resolved);
	if ("model" in resolved) {
		assert.equal(resolved.model.provider, "openrouter");
		assert.equal(resolved.model.id, "jaredpalmer/kev-4b");
	}
});

test("explicit reference with slash inside the model id resolves via first-slash split", async () => {
	const registry = new FakeRegistry();
	const slashed = classifier("openrouter", "typesafe/jev-latest");
	registry.available = [slashed];
	const resolved = await resolveNativeClassifier(registry, {
		classifierModel: "openrouter/typesafe/jev-latest",
	});
	assert.ok("model" in resolved);
	if ("model" in resolved) {
		assert.equal(resolved.model.id, "typesafe/jev-latest");
	}
});

test("explicit reference with a wrong (non-classifier) type is unavailable", async () => {
	const registry = new FakeRegistry();
	// The reference exists as a model but is NOT a classifier.
	registry.available = [chatModel("fake", "fake-model")];
	const resolved = await resolveNativeClassifier(registry, {
		classifierModel: "fake/fake-model",
	});
	assert.ok("error" in resolved);
	if ("error" in resolved) {
		assert.match(resolved.error, /not available|not a classifier/i);
	}
});

test("missing explicit classifier never substitutes another native model", async () => {
	const registry = new FakeRegistry();
	registry.available = [classifier("typesafe", "jev-latest")];
	const resolved = await resolveNativeClassifier(registry, {
		classifierModel: "other/absent-classifier",
	});
	assert.ok("error" in resolved);
	if ("error" in resolved) {
		assert.match(resolved.error, /other\/absent-classifier/);
	}
});

test("own emulation provider is rejected even when explicitly referenced", async () => {
	const registry = new FakeRegistry();
	const emulated = classifier("llm-as-jev", "fake/fake-model");
	registry.available = [emulated, classifier("typesafe", "jev-latest")];
	const resolved = await resolveNativeClassifier(registry, {
		classifierModel: "llm-as-jev/fake/fake-model",
	});
	assert.ok("error" in resolved);
});

// ---------------------------------------------------------------------------
// Default discovery without an explicit reference (Jev preference retained)
// ---------------------------------------------------------------------------

test("no explicit reference keeps Jev provider-priority discovery", async () => {
	const registry = new FakeRegistry();
	registry.available = [
		classifier("opencode", "jev-1.13"),
		classifier("typesafe", "jev-latest"),
	];
	const resolved = await resolveNativeClassifier(registry, {});
	assert.ok("model" in resolved);
	if ("model" in resolved) {
		assert.equal(resolved.model.provider, "typesafe");
	}
});

test("no explicit reference does not pick an arbitrary non-Jev classifier", async () => {
	const registry = new FakeRegistry();
	registry.available = [classifier("openrouter", "jaredpalmer/kev-4b")];
	const resolved = await resolveNativeClassifier(registry, {});
	assert.ok("error" in resolved);
});

// ---------------------------------------------------------------------------
// Pinned-model dispatch (5.1 handoff to core)
// ---------------------------------------------------------------------------

test("classifyWithModel dispatches the already-selected model without rediscovery", async () => {
	const registry = new FakeRegistry();
	const pinned = classifier("openrouter", "jaredpalmer/kev-4b");
	// A different classifier also available: discovery is never consulted.
	registry.available = [classifier("typesafe", "jev-latest")];
	const result = await classifyWithModel(
		registry,
		pinned,
		{ state: {}, questions: {} },
		{},
	);
	assert.equal(result.stopReason, "stop");
	assert.equal(registry.classifyCalls.length, 1);
	assert.equal(registry.classifyCalls[0]?.provider, "openrouter");
	assert.equal(registry.classifyCalls[0]?.id, "jaredpalmer/kev-4b");
});
