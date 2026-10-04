import assert from "node:assert/strict";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Host-only registration spike: no inference or persistent configuration. */
export default function spike(pi: ExtensionAPI): void {
	let ready = true;
	const model = {
		type: "classifier" as const,
		id: "stub/chat-model",
		provider: "llm-as-jev-spike",
		name: "Classifier registration spike",
		api: "llm-as-jev-spike",
		baseUrl: "https://unused.invalid",
		input: ["text"] as ["text"],
		contextWindow: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const unsupported = (): never => {
		throw new Error("This provider has no chat models");
	};
	const provider: Provider = {
		id: model.provider,
		name: model.name,
		auth: {
			apiKey: {
				name: "Delegated chat credentials",
				check: async () =>
					ready ? { type: "api_key", source: "delegated" } : undefined,
				resolve: async () =>
					ready
						? { auth: { apiKey: "emulated" }, source: "delegated" }
						: undefined,
			},
		},
		getModels: () => [],
		getAllModels: () => [model],
		stream: unsupported,
		streamSimple: unsupported,
		classify: async () => ({
			api: model.api,
			provider: model.provider,
			model: model.id,
			answers: { sample: { type: "bool", probability: 1 } },
			stopReason: "stop",
			timestamp: Date.now(),
		}),
	};
	pi.registerProvider(provider);
	pi.on("session_start", async (_event, ctx) => {
		const registry = ctx.modelRegistry;
		assert.equal(provider.auth.apiKey?.login, undefined);
		assert.equal(provider.auth.oauth, undefined);
		const available = await registry.getAvailableOfType(
			"classifier",
			model.provider,
		);
		assert.equal(available.length, 1);
		assert.equal(available[0]?.id, model.id);
		assert.deepEqual(registry.getModelsOfType("chat", model.provider), []);
		const result = await registry.classify(model, {
			state: { text: "stub" },
			questions: {
				sample: {
					type: "bool",
					instructions: "Stub question",
					criteria: { true: "yes", false: "no" },
				},
			},
		});
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(result.answers.sample, { type: "bool", probability: 1 });
		ready = false;
		assert.deepEqual(
			await registry.getAvailableOfType("classifier", model.provider),
			[],
		);
		console.error(
			"CLASSIFIER_SPIKE_PASS: native Provider; classifier dispatch; delegated availability; no login handler",
		);
		ctx.shutdown();
	});
}
