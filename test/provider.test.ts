import assert from "node:assert/strict";
import test from "node:test";
import type { JudgmentConfig } from "../src/config.ts";
import {
	createEmulatedClassifierProvider,
	EMULATED_PROVIDER_ID,
	emulatedClassifierModel,
} from "../src/provider.ts";

/** Concrete shape of the emulation provider (optional members present). */
interface EmulatedProvider {
	id: string;
	auth: {
		apiKey?: {
			login?: unknown;
			check?: (
				input: never,
			) => Promise<{ type?: string; source?: string } | undefined>;
			resolve?: (
				input: never,
			) => Promise<{ auth?: unknown; source?: string } | undefined>;
		};
		oauth?: unknown;
	};
	getModels: () => readonly unknown[];
	getAllModels?: () => readonly unknown[];
	classify?: (
		model: NonNullable<ReturnType<typeof emulatedClassifierModel>>,
		context: ClassifierContext,
		options?: { signal?: AbortSignal; timeoutMs?: number },
	) => Promise<ClassifierResult>;
}

import type {
	Api,
	AssistantMessage,
	ClassifierContext,
	ClassifierResult,
	Model,
	ToolCall,
} from "@earendil-works/pi-ai";

function config(overrides: Partial<JudgmentConfig> = {}): JudgmentConfig {
	return {
		mode: "llm",
		model: "fake/fake-model",
		provider: "fake",
		modelId: "fake-model",
		thinkingLevel: "off",
		timeoutMs: 5000,
		...overrides,
	};
}

function chatModel(): Model<Api> {
	return {
		name: "Fake model",
		id: "fake-model",
		provider: "fake",
		api: "openai-completions",
		baseUrl: "https://fake.invalid",
		input: ["text"],
		cost: { input: 1.5, output: 2, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 123456,
		maxTokens: 4096,
		type: undefined,
	};
}

interface RecordedCall {
	context: { tools: { name: string }[] };
	options: Record<string, unknown> | undefined;
}

class FakeRegistry {
	authReady = true;
	private readonly chat = chatModel();
	private readonly calls: RecordedCall[] = [];

	getModel(provider: string, id: string) {
		return provider === "fake" && id === "fake-model" ? this.chat : undefined;
	}

	async checkAuth() {
		return this.authReady ? { source: "env" } : undefined;
	}

	recorded() {
		return this.calls;
	}

	// LlmRegistry slice used by the delegated backend.
	streamSimple(
		_model: unknown,
		context: { tools: { name: string }[] },
		options?: Record<string, unknown>,
	) {
		this.calls.push({ context, options });
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "c1",
					name: "answer",
					arguments: { choice: "ok" },
				} satisfies ToolCall,
			],
			api: "openai-completions",
			provider: "fake",
			model: "fake-model",
			usage: {
				input: 3,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 4,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		return { result: async () => message };
	}
}

test("unconfigured: no classifier model is exposed", () => {
	assert.equal(
		emulatedClassifierModel(
			config({ model: undefined, provider: undefined, modelId: undefined }),
		),
		undefined,
	);
	const provider: EmulatedProvider = createEmulatedClassifierProvider({
		registry: new FakeRegistry(),
		config: config({
			model: undefined,
			provider: undefined,
			modelId: undefined,
		}),
	});
	assert.deepEqual(provider.getModels?.() ?? [], []);
	assert.deepEqual(provider.getAllModels?.() ?? [], []);
	assert.equal(provider.auth.apiKey?.login, undefined);
	assert.equal(provider.auth.oauth, undefined);
});

test("configured: one classifier model with chat-derived contextWindow and cost", () => {
	const registry = new FakeRegistry();
	const provider: EmulatedProvider = createEmulatedClassifierProvider({
		registry,
		config: config(),
	});
	const models = provider.getAllModels?.() ?? [];
	assert.equal(models.length, 1);
	const model = models[0] as
		| NonNullable<ReturnType<typeof emulatedClassifierModel>>
		| undefined;
	assert.equal(model?.type, "classifier");
	assert.equal(model?.id, "fake/fake-model");
	assert.equal(model?.provider, EMULATED_PROVIDER_ID);
	assert.equal(model?.contextWindow, 123456);
	assert.deepEqual(model?.cost, {
		input: 1.5,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
	});
	assert.deepEqual(provider.getModels?.() ?? [], []);
});

test("configured but chat model unknown to registry: no models advertised", () => {
	const registry = new FakeRegistry();
	const provider: EmulatedProvider = createEmulatedClassifierProvider({
		registry,
		config: config({
			model: "other/model",
			provider: "other",
			modelId: "model",
		}),
	});
	assert.deepEqual(provider.getAllModels?.() ?? [], []);
});

test("availability delegates to the underlying chat provider auth", async () => {
	const registry = new FakeRegistry();
	const provider: EmulatedProvider = createEmulatedClassifierProvider({
		registry,
		config: config(),
	});
	assert.deepEqual(await provider.auth.apiKey?.check?.({} as never), {
		type: "api_key",
		source: "delegated",
	});
	const resolved = await provider.auth.apiKey?.resolve?.({} as never);
	assert.equal(resolved?.source, "delegated");
	assert.ok((resolved?.auth as { apiKey?: string } | undefined)?.apiKey);

	registry.authReady = false;
	assert.equal(await provider.auth.apiKey?.check?.({} as never), undefined);
	assert.equal(await provider.auth.apiKey?.resolve?.({} as never), undefined);
});

test("classify delegates to the LLM backend with provenance and no leaked chat models", async () => {
	const registry = new FakeRegistry();
	const provider: EmulatedProvider = createEmulatedClassifierProvider({
		registry,
		config: config(),
	});
	const model = emulatedClassifierModel(config());
	assert.ok(model && provider.classify);
	const context: ClassifierContext = {
		state: { note: "x" },
		questions: {
			q: {
				type: "choice",
				instructions: "pick",
				criteria: { ok: "fine", bad: "not fine" },
			},
		},
	};
	const result: ClassifierResult = await provider.classify(model, context, {
		signal: undefined,
		timeoutMs: 1234,
	});
	assert.equal(result.stopReason, "stop");
	assert.equal(result.provider, EMULATED_PROVIDER_ID);
	assert.equal(result.model, "fake/fake-model");
	assert.equal(result.answers.q?.type, "choice");
	assert.equal((result.answers.q as { choice: string }).choice, "ok");

	const calls = registry.recorded();
	assert.equal(calls.length, 1);
	assert.deepEqual(
		calls[0]?.context.tools.map((t) => t.name),
		["answer"],
	);
	const passedTimeout = calls[0]?.options?.timeoutMs;
	assert.ok(
		typeof passedTimeout === "number" &&
			passedTimeout >= 1230 &&
			passedTimeout <= 1234,
		`timeoutMs passed through (got ${String(passedTimeout)})`,
	);

	// No chat models on the emulation provider itself.
	assert.deepEqual(provider.getModels?.() ?? [], []);
	assert.equal(provider.auth.apiKey?.login, undefined);
});

test("classify with vanished chat model returns a structured error", async () => {
	const registry = new FakeRegistry();
	const provider: EmulatedProvider = createEmulatedClassifierProvider({
		registry,
		config: config(),
	});
	const model = emulatedClassifierModel(config());
	assert.ok(model && provider.classify);
	const registryWithoutModel = new FakeRegistry();
	registryWithoutModel.authReady = true;
	const unavailable: EmulatedProvider = createEmulatedClassifierProvider({
		registry: registryWithoutModel,
		config: config({ model: "gone/model", provider: "gone", modelId: "model" }),
	});
	assert.ok(unavailable.classify);
	const result = await unavailable.classify(model, {
		state: {},
		questions: {},
	});
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /not available/);
});

test("provider snapshots refresh metadata and retained-descriptor dispatch without re-registration", async () => {
	const registry = new FakeRegistry();
	let current = config();
	let reads = 0;
	registry.getModel = ((provider: string, id: string) =>
		provider === "fake" && ["fake-model", "next"].includes(id)
			? { ...chatModel(), id, contextWindow: id === "next" ? 24000 : 123456 }
			: undefined) as typeof registry.getModel;
	const provider: EmulatedProvider = createEmulatedClassifierProvider({
		registry,
		config: () => {
			reads += 1;
			return current;
		},
	});
	const old = provider.getAllModels!()[0] as NonNullable<
		ReturnType<typeof emulatedClassifierModel>
	>;
	current = config({ model: "fake/next", modelId: "next", timeoutMs: 1500 });
	const model = provider.getAllModels!()[0] as typeof old;
	assert.equal(model.id, "fake/next");
	assert.equal(model.contextWindow, 24000);
	const context: ClassifierContext = {
		state: {},
		questions: {
			q: {
				type: "choice",
				instructions: "pick",
				criteria: { ok: "yes", bad: "no" },
			},
		},
	};
	const before = reads;
	const result = await provider.classify!(old, context);
	assert.equal(reads, before + 1);
	assert.equal(result.model, "fake/next");
	assert.equal(result.stopReason, "stop");
	const timeout = registry.recorded()[0].options?.timeoutMs as number;
	assert.ok(
		timeout > 0 && timeout <= 1500,
		"configured timeout is used without caller override",
	);
	registry.authReady = false;
	assert.equal(await provider.auth.apiKey!.check!({} as never), undefined);
	current = config({
		model: undefined,
		provider: undefined,
		modelId: undefined,
	});
	assert.deepEqual(provider.getAllModels!(), []);
	const removed = await provider.classify!(old, context);
	assert.equal(removed.stopReason, "error");
	assert.equal(
		registry.recorded().length,
		1,
		"removed target never dispatches old descriptor",
	);
	current = config();
	assert.equal(
		(provider.getAllModels!()[0] as typeof old).id,
		"fake/fake-model",
	);
});

test("in-flight provider repair keeps model, thinking and timeout across an edit", async () => {
	const registry = new FakeRegistry();
	let current = config({ thinkingLevel: "high", timeoutMs: 10000 });
	registry.getModel = ((_provider: string, id: string) => ({
		...chatModel(),
		id,
		reasoning: true,
	})) as typeof registry.getModel;
	const seen: { model: string; reasoning: unknown; timeout: unknown }[] = [];
	let entered!: () => void;
	const admission = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const stream = registry.streamSimple.bind(registry);
	registry.streamSimple = (model, context, options) => {
		seen.push({
			model: (model as { id: string }).id,
			reasoning: options?.reasoning,
			timeout: options?.timeoutMs,
		});
		const message = stream(model, context, options);
		if (seen.length !== 1) return message;
		return {
			result: async () => {
				entered();
				await barrier;
				return { ...(await message.result()), content: [] };
			},
		};
	};
	const provider: EmulatedProvider = createEmulatedClassifierProvider({
		registry,
		config: () => current,
	});
	const old = provider.getAllModels!()[0] as NonNullable<
		ReturnType<typeof emulatedClassifierModel>
	>;
	const pending = provider.classify!(old, {
		state: {},
		questions: {
			q: {
				type: "choice",
				instructions: "pick",
				criteria: { ok: "yes", bad: "no" },
			},
		},
	});
	await admission;
	current = config({
		model: "fake/next",
		modelId: "next",
		thinkingLevel: "low",
		timeoutMs: 1,
	});
	release();
	const result = await pending;
	assert.equal(result.model, "fake/fake-model");
	assert.equal(result.stopReason, "stop");
	assert.equal(seen.length, 2, "malformed output repaired once");
	assert.ok(
		seen.every(
			(call) => call.model === "fake-model" && call.reasoning === "high",
		),
	);
	assert.ok(
		seen.every(
			(call) =>
				typeof call.timeout === "number" &&
				call.timeout > 1 &&
				call.timeout <= 10000,
		),
	);
});

test("registerEmulatedClassifierProvider registers through the native form", () => {
	const registered: unknown[] = [];
	const pi = {
		registerProvider(provider: unknown) {
			registered.push(provider);
		},
	};
	const provider: EmulatedProvider = createEmulatedClassifierProvider({
		registry: new FakeRegistry(),
		config: config(),
	});
	pi.registerProvider(provider);
	assert.equal(registered.length, 1);
	assert.equal((registered[0] as { id: string }).id, EMULATED_PROVIDER_ID);
});
