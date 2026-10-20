/**
 * Stateless v2 judge() integration tests with fake registries: backend
 * selection, never-throws, per-attempt idle/hard clocks, failover isolation,
 * explicit legacy-field rejection, redaction and cancellation ownership.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
	Api,
	AssistantMessage,
	ClassifierApi,
	ClassifierModel,
	ClassifierResult,
	Model,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { JudgeRequest } from "../client/judgment-client.ts";
import type { JudgmentConfig } from "../src/config.ts";
import {
	DEFAULT_CLASSIFIER_IDLE_TIMEOUT_MS,
	DEFAULT_LLM_IDLE_TIMEOUT_MS,
} from "../src/config.ts";
import type { ServiceRegistry } from "../src/service.ts";
import { createJudgmentService } from "../src/service.ts";

type AnyModel = Model<Api>;
type AnyClassifierModel = ClassifierModel<ClassifierApi>;

const USAGE: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
};

function chatModel(contextWindow = 8192): AnyModel {
	return {
		type: undefined,
		id: "fake-model",
		provider: "fake",
		api: "openai-completions",
		baseUrl: "https://fake.invalid",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 1024,
	} as AnyModel;
}

function jevModel(): AnyClassifierModel {
	return {
		type: "classifier",
		id: "jev-1.13",
		provider: "typesafe",
		name: "jev",
		api: "typesafe-system-one",
		baseUrl: "https://unused.invalid",
		input: ["text"],
		contextWindow: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function toolCall(args: unknown): ToolCall {
	return {
		type: "toolCall",
		id: "c1",
		name: "answer",
		arguments: args as never,
	};
}

function llmMessage(content: unknown[]): AssistantMessage {
	return {
		role: "assistant",
		content: content as AssistantMessage["content"],
		api: "openai-completions",
		provider: "fake",
		model: "fake-model",
		usage: USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const BOOL = {
	type: "bool",
	instructions: "is it",
	criteria: { true: "yes", false: "no" },
} as const;

function request(): JudgeRequest {
	return { state: { note: "x" }, questions: { ok: BOOL } };
}

function jevAnswer(probability = 0.9): ClassifierResult {
	return {
		api: "typesafe-system-one",
		provider: "typesafe",
		model: "jev-1.13",
		answers: { ok: { type: "bool", probability } },
		stopReason: "stop",
		usage: USAGE,
		timestamp: Date.now(),
	};
}

function config(partial: Partial<JudgmentConfig> = {}): JudgmentConfig {
	return {
		mode: "auto",
		thinkingLevel: "off",
		model: "fake/fake-model",
		provider: "fake",
		modelId: "fake-model",
		...partial,
	};
}

interface RegistryOptions {
	native?: AnyClassifierModel[];
	nativeResult?: ClassifierResult;
	nativeError?: Error;
	nativeDelayMs?: number;
	nativeHangs?: boolean;
	nativeSignalIgnores?: boolean;
	llm?: AnyModel;
	llmMessages?: AssistantMessage[];
	llmHangs?: boolean;
	llmEvents?: Record<string, unknown>[][];
	auth?: Record<string, string | Promise<never>>;
}

/** Minimal scripted registry covering the v2 surface. */
function fakeRegistry(opts: RegistryOptions): ServiceRegistry & {
	nativeCalls: { options?: unknown }[];
	llmCalls: { options?: { signal?: AbortSignal } }[];
} {
	const nativeCalls: { options?: unknown }[] = [];
	const llmCalls: { options?: { signal?: AbortSignal } }[] = [];
	const llmQueue = [...(opts.llmMessages ?? [])];
	const llmEvents = [...(opts.llmEvents ?? [])];
	return {
		nativeCalls,
		llmCalls,
		getProviders: () => Object.keys(opts.auth ?? {}).map((id) => ({ id })),
		getAuth: async (id: string) => {
			const entry = opts.auth?.[id];
			if (entry instanceof Promise) return entry as never; // hangs
			return entry ? { auth: { apiKey: entry } } : { auth: {} };
		},
		getModel: (provider: string, id: string) =>
			opts.llm && opts.llm.provider === provider && opts.llm.id === id
				? opts.llm
				: undefined,
		getAvailableOfType: async () => [...(opts.native ?? [])],
		classify: (
			_m: AnyClassifierModel,
			_c: unknown,
			options?: { signal?: AbortSignal },
		) => {
			nativeCalls.push({ options });
			if (opts.nativeHangs) {
				return new Promise<ClassifierResult>((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => {
							if (!opts.nativeSignalIgnores)
								resolve({ ...jevAnswer(0), stopReason: "aborted" });
						},
						{ once: true },
					);
				});
			}
			if (opts.nativeError) return Promise.reject(opts.nativeError);
			if (opts.nativeDelayMs) {
				return new Promise<ClassifierResult>((resolve) => {
					const timer = setTimeout(
						() => resolve(opts.nativeResult ?? jevAnswer()),
						opts.nativeDelayMs,
					);
					options?.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							resolve({ ...jevAnswer(0), stopReason: "aborted" });
						},
						{ once: true },
					);
				});
			}
			return Promise.resolve(opts.nativeResult ?? jevAnswer());
		},
		streamSimple: (
			_m: AnyModel,
			_c: unknown,
			options?: { signal?: AbortSignal },
		) => {
			llmCalls.push({ options });
			if (opts.llmHangs) return createAssistantMessageEventStream();
			const events = llmEvents.shift() ?? [];
			const final = llmQueue.shift() ?? llmMessage([toolCall({ value: true })]);
			const stream = createAssistantMessageEventStream();
			for (const event of events) stream.push(event as never);
			stream.end(final);
			return stream;
		},
	} as never;
}

const SERVICE = (registry: ServiceRegistry, cfg: JudgmentConfig) =>
	createJudgmentService({ registry, config: () => cfg });

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let t: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			p,
			new Promise<never>((_, r) => {
				t = setTimeout(() => r(new Error("test timeout")), ms);
			}),
		]);
	} finally {
		if (t !== undefined) clearTimeout(t);
	}
}

// --- discovery and shape ---

test("version two surface: judge/availability/describeSelection only", async () => {
	const service = SERVICE(fakeRegistry({ native: [jevModel()] }), config());
	assert.equal(service.version, 2);
	assert.equal(service.capacityVersion, 2);
	assert.equal(typeof service.judge, "function");
	const anyService = service as unknown as Record<string, unknown>;
	assert.equal(anyService.review, undefined);
	assert.equal(anyService.reviewVersion, undefined);
	assert.equal(anyService.reviewCacheVersion, undefined);
	assert.equal(anyService.reviewStagesVersion, undefined);
});

test("native success returns v2 shape with declared capacity", async () => {
	const registry = fakeRegistry({ native: [jevModel()] });
	const result = await SERVICE(registry, config()).judge(request());
	assert.equal(result.stopReason, "stop");
	assert.equal(result.backend, "classifier");
	assert.equal(result.model, "typesafe/jev-1.13");
	assert.deepEqual(result.answers.ok, { type: "bool", probability: 0.9 });
	assert.deepEqual(result.dropped, []);
	assert.equal(result.capacity?.limitSource, "model");
	assert.equal(result.capacity?.limits.contextWindow, 8192);
	const anyResult = result as unknown as Record<string, unknown>;
	assert.equal(anyResult.reuse, undefined);
	assert.equal(anyResult.progress, undefined);
	assert.equal(anyResult.diagnostics, undefined);
	assert.equal(anyResult.unresolved, undefined);
	assert.equal(anyResult.inputDimensions, undefined);
});

test("identical calls each dispatch independent inference", async () => {
	const registry = fakeRegistry({ native: [jevModel()] });
	const service = SERVICE(registry, config());
	await service.judge(request());
	await service.judge(request());
	assert.equal(registry.nativeCalls.length, 2);
});

test("explicit legacy request/options fields fail without inference", async () => {
	const registry = fakeRegistry({ native: [jevModel()] });
	const service = SERVICE(registry, config());
	for (const bad of [
		() =>
			service.judge({
				...request(),
				evidence: [{ id: "e", text: "x" }],
			} as never),
		() => service.judge(request(), { timeoutMs: 1000 } as never),
		() => service.judge(request(), { fresh: "t" } as never),
		() => service.judge(request(), { checkpoint: "c" } as never),
	]) {
		const result = await bad();
		assert.equal(result.stopReason, "error");
		assert.match(
			result.errorMessage ?? "",
			/removed in service version two|pack evidence|invalid request/i,
		);
	}
	assert.equal(registry.nativeCalls.length, 0);
});

test("invalid request never dispatches and never fails over", async () => {
	const registry = fakeRegistry({
		native: [jevModel()],
		llm: chatModel(),
	});
	const service = SERVICE(registry, config());
	const result = await service.judge({ state: "nope", questions: {} } as never);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /invalid request/);
	assert.equal(registry.nativeCalls.length, 0);
	assert.equal(registry.llmCalls.length, 0);
});

// --- repaired admission/readiness/privacy regressions ---

for (const mode of ["classifier", "llm"] as const) {
	test(`${mode} dispatch redacts state and every question string`, async () => {
		const secret = "fixture-private-key-only";
		const registry = fakeRegistry({
			native: [jevModel()],
			llm: chatModel(),
			auth: { typesafe: secret, fake: secret },
		});
		let wire: unknown;
		const classify = registry.classify.bind(registry);
		registry.classify = (model, context, options) => {
			wire = context;
			return classify(model, context, options);
		};
		const stream = registry.streamSimple.bind(registry);
		registry.streamSimple = (model, context, options) => {
			wire = context;
			return stream(model, context, options);
		};
		const req: JudgeRequest = {
			state: { note: secret },
			questions: {
				ok: {
					type: "bool",
					instructions: `check ${secret}`,
					criteria: { true: `yes ${secret}`, false: `no ${secret}` },
				},
			},
		};
		const result = await SERVICE(registry, config({ mode })).judge(req);
		assert.equal(result.stopReason, "stop");
		assert.ok(wire);
		assert.doesNotMatch(JSON.stringify(wire), new RegExp(secret));
		assert.match(JSON.stringify(wire), /\[REDACTED\]/);
		assert.equal(
			req.state.note,
			secret,
			"redaction never mutates caller input",
		);
	});

	test(`${mode} redacted schema maps answers and policy to original own keys`, async () => {
		const secret = "fixture-schema-key";
		const labels = [secret, "__proto__", "constructor", "toString"];
		const criteria = Object.fromEntries(labels.map((label) => [label, label]));
		const questions = Object.fromEntries(
			[secret, "__proto__", "constructor", "toString"].map((id) => [
				id,
				{ type: "choice" as const, instructions: secret, criteria },
			]),
		);
		const registry = fakeRegistry({
			native: [jevModel()],
			llm: chatModel(),
			auth: { typesafe: secret, fake: secret },
			llmMessages: labels.map(() =>
				llmMessage([toolCall({ choice: "[REDACTED]" })]),
			),
		});
		registry.classify = async (_model, context) => {
			assert.doesNotMatch(JSON.stringify(context), new RegExp(secret));
			return {
				...jevAnswer(),
				answers: Object.fromEntries(
					Object.keys(context.questions).map((id) => [
						id,
						{
							type: "choice" as const,
							choice: "[REDACTED]",
							confidence: 1,
							probabilities: Object.fromEntries(
								["[REDACTED]", ...labels.slice(1)].map((label) => [
									label,
									label === "[REDACTED]" ? 1 : 0,
								]),
							),
						},
					]),
				),
			};
		};
		const result = await SERVICE(registry, config({ mode })).judge(
			{ state: {}, questions },
			{
				thresholds: Object.fromEntries(
					Object.keys(questions).map((id) => [
						id,
						{
							metric: "choiceProbability" as const,
							choice: secret,
							minimum: 0.9,
						},
					]),
				),
			},
		);
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(Object.keys(result.answers), Object.keys(questions));
		for (const id of Object.keys(questions)) {
			assert.ok(Object.hasOwn(result.answers, id));
			const answer = result.answers[id];
			assert.equal(answer.type, "choice");
			if (answer.type !== "choice") assert.fail("expected choice");
			assert.equal(answer.choice, secret);
			assert.deepEqual(
				answer.probabilities,
				Object.fromEntries(
					labels.map((label) => [label, label === secret ? 1 : 0]),
				),
			);
			assert.equal(
				Object.getPrototypeOf(answer.probabilities),
				Object.prototype,
			);
		}
	});
}

for (const mode of ["classifier", "llm", "auto", "auto-llm"] as const) {
	for (const failure of ["missing", "rejected"] as const) {
		test(`${mode} ${failure} selected auth never dispatches that candidate`, async () => {
			const registry = fakeRegistry({ native: [jevModel()], llm: chatModel() });
			const failed =
				mode === "llm" || mode === "auto-llm" ? "fake" : "typesafe";
			const authCalls: string[] = [];
			registry.getAuth = async (provider) => {
				authCalls.push(provider);
				if (provider === failed) {
					if (failure === "missing") return undefined;
					throw new Error("PRIVATE-AUTH-FAILURE");
				}
				return { auth: {} }; // Pi credential-free readiness is still a resolved AuthResult.
			};
			const result = await SERVICE(registry, config({ mode })).judge(request());
			assert.equal(
				result.stopReason,
				mode.startsWith("auto") ? "stop" : "error",
			);
			assert.equal(
				registry.nativeCalls.length,
				failed === "typesafe" ? 0 : mode.startsWith("auto") ? 1 : 0,
			);
			assert.equal(
				registry.llmCalls.length,
				failed === "fake" ? 0 : mode.startsWith("auto") ? 1 : 0,
			);
			assert.doesNotMatch(JSON.stringify(result), /PRIVATE-AUTH/);
			assert.equal(
				authCalls.filter((id) => id === failed).length,
				1,
				"no readiness retry within candidate",
			);
		});
	}
}

test("redaction never merges colliding schema identifiers or dispatches malformed schema", async () => {
	for (const kind of ["questions", "labels", "type"] as const) {
		const secret = kind === "type" ? "bool" : "fixture-schema-key";
		const registry = fakeRegistry({
			native: [jevModel()],
			llm: chatModel(),
			auth: { typesafe: secret },
		});
		const questions =
			kind === "questions"
				? Object.fromEntries([
						[secret, BOOL],
						["[REDACTED]", BOOL],
					])
				: kind === "labels"
					? {
							ok: {
								type: "choice" as const,
								instructions: "pick",
								criteria: { [secret]: "one", "[REDACTED]": "two" },
							},
						}
					: { ok: BOOL };
		const result = await SERVICE(registry, config()).judge({
			state: {},
			questions,
		});
		assert.equal(result.stopReason, "error");
		assert.deepEqual(result.answers, {});
		assert.equal(registry.nativeCalls.length, 0);
		assert.equal(registry.llmCalls.length, 0);
		assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
	}
});

test("redacted identifiers stay private in incompatible-answer errors", async () => {
	const secret = "fixture-schema-key";
	const registry = fakeRegistry({
		native: [jevModel()],
		nativeResult: { ...jevAnswer(), answers: {} },
		auth: { typesafe: secret },
	});
	const result = await SERVICE(registry, config({ mode: "classifier" })).judge({
		state: {},
		questions: { [secret]: BOOL },
	});
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /incompatible answer/);
	assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("admission snapshots state, questions and nested policy before setup awaits", async () => {
	const registry = fakeRegistry({ native: [jevModel()] });
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	registry.getAuth = async () => {
		await gate;
		return { auth: {} };
	};
	const req = structuredClone(request());
	const opts = {
		thresholds: { ok: { metric: "confidence" as const, minimum: 0.8 } },
	};
	let wire: unknown;
	const classify = registry.classify.bind(registry);
	registry.classify = (model, context, options) => {
		wire = context;
		return classify(model, context, options);
	};
	const pending = SERVICE(registry, config({ mode: "classifier" })).judge(
		req,
		opts,
	);
	req.state.note = "MUTATED";
	req.questions.ok.instructions = "MUTATED";
	opts.thresholds.ok.minimum = 1;
	release();
	const result = await pending;
	assert.deepEqual(wire, request());
	assert.equal(result.stopReason, "stop");
	assert.ok(result.answers.ok, "admitted 0.8 threshold, not mutated 1");
});

test("admission freezes classifierBaseUrl and later calls observe settings changes", async () => {
	const original = jevModel();
	const registry = fakeRegistry({ native: [original] });
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	registry.getAuth = async () => {
		await gate;
		return { auth: {} };
	};
	const cfg = config({
		mode: "classifier",
		classifierModel: "typesafe/jev-1.13",
		classifierBaseUrl: "https://first.example/v1/systemone/",
	});
	const endpoints: string[] = [];
	const classify = registry.classify.bind(registry);
	registry.classify = (model, context, options) => {
		endpoints.push(model.baseUrl);
		return classify(model, context, options);
	};
	const service = SERVICE(registry, cfg);
	const pending = service.judge(request());
	cfg.classifierBaseUrl = "https://second.example/v1";
	release();
	assert.equal((await pending).stopReason, "stop");
	assert.equal((await service.judge(request())).stopReason, "stop");
	assert.deepEqual(endpoints, [
		"https://first.example/v1",
		"https://second.example/v1",
	]);
	assert.equal(original.baseUrl, "https://unused.invalid");
});

test("alternate replays original state/questions after caller changes between attempts", async () => {
	const req = structuredClone(request());
	const registry = fakeRegistry({ native: [jevModel()], llm: chatModel() });
	registry.classify = async () => {
		req.state.note = "MUTATED";
		req.questions.ok.instructions = "MUTATED";
		return {
			...jevAnswer(),
			stopReason: "error",
			errorMessage: "transport failed",
		};
	};
	let wire: { state: unknown; question: unknown } | undefined;
	const stream = registry.streamSimple.bind(registry);
	registry.streamSimple = (model, context, options) => {
		wire = JSON.parse(context.messages[0].content as string);
		return stream(model, context, options);
	};
	const result = await SERVICE(registry, config()).judge(req);
	assert.equal(result.backend, "llm");
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(wire?.state, request().state);
	assert.deepEqual(wire?.question, BOOL);
});

test("native alternate applies admitted nested threshold, not LLM-time caller mutation", async () => {
	const opts = {
		thresholds: { ok: { metric: "confidence" as const, minimum: 0.8 } },
	};
	const registry = fakeRegistry({ native: [jevModel()], llm: chatModel() });
	registry.streamSimple = () => {
		opts.thresholds.ok.minimum = 1;
		const stream = createAssistantMessageEventStream();
		stream.end({
			...llmMessage([]),
			stopReason: "error",
			errorMessage: "transport failed",
		});
		return stream;
	};
	const result = await SERVICE(registry, config({ mode: "auto-llm" })).judge(
		request(),
		opts,
	);
	assert.equal(result.backend, "classifier");
	assert.equal(result.stopReason, "stop");
	assert.ok(result.answers.ok);
});

test("invalid JSON questions fail at admission without waiting on auth", async () => {
	const registry = fakeRegistry({
		native: [jevModel()],
		auth: { typesafe: new Promise<never>(() => {}) },
	});
	let authCalls = 0;
	registry.getAuth = async () => {
		authCalls++;
		return new Promise(() => {});
	};
	const cyclic: Record<string, unknown> = { ...BOOL };
	cyclic.extra = cyclic;
	const result = await withTimeout(
		SERVICE(registry, config()).judge({
			state: {},
			questions: { ok: cyclic },
		} as never),
		500,
	);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /invalid request/);
	assert.equal(authCalls, 0);
});

for (const mode of ["auto", "auto-llm"] as const) {
	for (const primaryOverflow of [true, false]) {
		test(`${mode} preserves actual alternate overflow (primary overflow ${primaryOverflow})`, async () => {
			const primary = primaryOverflow
				? "400: context_length_exceeded"
				: "401: unauthorized";
			const registry = fakeRegistry({
				native: [jevModel()],
				llm: chatModel(4096),
				nativeResult: {
					...jevAnswer(),
					stopReason: "error",
					errorMessage:
						mode === "auto" ? primary : "400: context_length_exceeded",
				},
				llmMessages: [
					{
						...llmMessage([]),
						stopReason: "error",
						errorMessage:
							mode === "auto-llm" ? primary : "400: context_length_exceeded",
					},
				],
			});
			const result = await SERVICE(registry, config({ mode })).judge(request());
			assert.equal(result.stopReason, "error");
			assert.equal(result.contextOverflow, true);
			assert.equal(result.backend, mode === "auto" ? "llm" : "classifier");
			assert.equal(result.capacity?.model, result.model);
			assert.deepEqual(result.answers, {});
		});
	}
	test(`${mode} overflow never survives terminal unavailable/auth readiness failure`, async () => {
		for (const alternate of ["missing", "rejected-auth"] as const) {
			const registry = fakeRegistry({
				native:
					mode === "auto-llm" && alternate === "missing" ? [] : [jevModel()],
				llm:
					mode === "auto" && alternate === "missing" ? undefined : chatModel(),
				nativeResult: {
					...jevAnswer(),
					stopReason: "error",
					errorMessage: "400: context_length_exceeded",
				},
				llmMessages: [
					{
						...llmMessage([]),
						stopReason: "error",
						errorMessage: "400: context_length_exceeded",
					},
				],
			});
			if (alternate === "rejected-auth")
				registry.getAuth = async (id) => {
					if (id === (mode === "auto" ? "fake" : "typesafe"))
						throw new Error("auth failed");
					return { auth: {} };
				};
			const result = await SERVICE(registry, config({ mode })).judge(request());
			assert.equal(result.stopReason, "error");
			assert.equal(result.contextOverflow, undefined);
		}
	});
}

for (const failure of ["result", "iterator"] as const) {
	test(`async LLM ${failure} failure uses one real native alternate, no output repair`, async () => {
		const registry = fakeRegistry({ native: [jevModel()], llm: chatModel() });
		let streams = 0;
		registry.streamSimple = () => {
			streams++;
			return {
				result: () =>
					failure === "result"
						? Promise.reject(new Error("PRIVATE-TRANSPORT"))
						: Promise.resolve(llmMessage([])),
				[Symbol.asyncIterator]: () => ({
					next: () =>
						failure === "iterator"
							? Promise.reject(new Error("PRIVATE-TRANSPORT"))
							: Promise.resolve({ done: true as const, value: undefined }),
				}),
			} as ReturnType<ServiceRegistry["streamSimple"]>;
		};
		const result = await withTimeout(
			SERVICE(registry, config({ mode: "auto-llm" })).judge(request()),
			500,
		);
		assert.equal(result.stopReason, "stop");
		assert.equal(result.backend, "classifier");
		assert.equal(registry.nativeCalls.length, 1);
		assert.equal(streams, 1);
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE-TRANSPORT/);
	});
}

// --- routing and failover ---

test("auto native success runs no LLM inference", async () => {
	const registry = fakeRegistry({ native: [jevModel()], llm: chatModel() });
	const result = await SERVICE(registry, config()).judge(request());
	assert.equal(result.stopReason, "stop");
	assert.equal(registry.llmCalls.length, 0);
});

test("auto with no native candidate uses the configured LLM", async () => {
	const registry = fakeRegistry({ llm: chatModel() });
	const result = await SERVICE(registry, config()).judge(request());
	assert.equal(result.stopReason, "stop");
	assert.equal(result.backend, "llm");
	assert.equal(result.model, "fake/fake-model");
	assert.equal(result.answers.ok?.type, "bool");
});

test("auto-llm prefers LLM; fallback to native on LLM failure", async () => {
	const r = fakeRegistry({
		native: [jevModel()],
		llm: chatModel(),
	});
	r.streamSimple = () => {
		const s = createAssistantMessageEventStream();
		s.end({ ...llmMessage([]), stopReason: "error", errorMessage: "boom" });
		return s;
	};
	const result = await SERVICE(r, config({ mode: "auto-llm" })).judge(
		request(),
	);
	assert.equal(result.stopReason, "stop");
	assert.equal(result.backend, "classifier");
});

test("auto-llm with a usable LLM never runs native inference", async () => {
	const registry = fakeRegistry({ native: [jevModel()], llm: chatModel() });
	const result = await SERVICE(registry, config({ mode: "auto-llm" })).judge(
		request(),
	);
	assert.equal(result.stopReason, "stop");
	assert.equal(result.backend, "llm");
	assert.equal(registry.nativeCalls.length, 0);
});

test("native failure permits exactly one complete LLM attempt", async () => {
	const registry = fakeRegistry({
		native: [jevModel()],
		nativeError: new Error("transport down"),
		llm: chatModel(),
	});
	const result = await SERVICE(registry, config()).judge(request());
	assert.equal(result.stopReason, "stop");
	assert.equal(result.backend, "llm");
	assert.equal(result.answers.ok?.type, "bool");
});

test("forced classifier never tries the LLM", async () => {
	const registry = fakeRegistry({
		nativeError: new Error("boom"),
		llm: chatModel(),
	});
	const result = await SERVICE(registry, config({ mode: "classifier" })).judge(
		request(),
	);
	assert.equal(result.stopReason, "error");
	assert.equal(registry.llmCalls.length, 0);
});

test("both failed: bounded redacted summary, empty answers", async () => {
	const registry = fakeRegistry({
		nativeError: new Error("native down"),
		llm: chatModel(),
	});
	registry.streamSimple = () => {
		const s = createAssistantMessageEventStream();
		s.end({ ...llmMessage([]), stopReason: "error", errorMessage: "llm down" });
		return s;
	};
	const result = await SERVICE(registry, config()).judge(request());
	assert.equal(result.stopReason, "error");
	assert.deepEqual(result.answers, {});
	assert.match(
		result.errorMessage ?? "",
		/both automatic backend attempts failed|no .*available/,
	);
});

test("valid negative / all-dropped native result is final, no fallback", async () => {
	// Bool certainty is max(p, 1-p): 0.5 certainty stays under minimum 0.8.
	const registry = fakeRegistry({
		native: [jevModel()],
		nativeResult: jevAnswer(0.5),
		llm: chatModel(),
	});
	const result = await SERVICE(registry, config()).judge(request(), {
		minConfidence: 0.8,
	});
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(result.answers, {});
	assert.deepEqual(result.dropped, ["ok"]);
	assert.equal(registry.llmCalls.length, 0);
});

test("context overflow permits one alternate on complete input", async () => {
	const registry = fakeRegistry({
		native: [jevModel()],
		nativeResult: {
			...jevAnswer(0),
			stopReason: "error",
			errorMessage: "maximum context length is 4096 exceeded",
			answers: {},
		},
		llm: chatModel(),
	});
	const result = await SERVICE(registry, config()).judge(request());
	assert.equal(result.stopReason, "stop");
	assert.equal(result.backend, "llm");
	assert.equal(result.contextOverflow, undefined);
});

test("overflow primary plus auth-failed alternate reports no stale overflow flag", async () => {
	const registry = fakeRegistry({
		native: [jevModel()],
		nativeResult: {
			...jevAnswer(0),
			stopReason: "error",
			errorMessage: "maximum context length is 4096 exceeded",
			answers: {},
		},
		llm: chatModel(),
	});
	registry.streamSimple = () => {
		const s = createAssistantMessageEventStream();
		s.end({
			...llmMessage([]),
			stopReason: "error",
			errorMessage: "401 unauthorized",
		});
		return s;
	};
	const result = await SERVICE(registry, config()).judge(request());
	assert.equal(result.stopReason, "error");
	assert.equal(result.contextOverflow, undefined);
});

test("caller abort during alternate setup prevents its dispatch", async () => {
	// Native fails; the LLM's selected-provider auth resolution hangs, and
	// the caller abort lands while the alternate is in setup — its dispatch
	// never happens and the operation resolves aborted.
	const registry = fakeRegistry({
		nativeError: new Error("down"),
		llm: chatModel(),
		auth: { fake: new Promise<never>(() => {}) },
	});
	const controller = new AbortController();
	const service = SERVICE(registry, config());
	const pending = service.judge(request(), { signal: controller.signal });
	setTimeout(() => controller.abort(), 5);
	const result = await pending;
	assert.equal(result.stopReason, "aborted");
	assert.equal(registry.llmCalls.length, 0);
});

test("late primary result cannot publish after failover", async () => {
	// Native hangs ignoring its signal; LLM answers. A late native completion
	// must never replace the alternate's terminal result.
	const registry = fakeRegistry({
		native: [jevModel()],
		nativeHangs: true,
		nativeSignalIgnores: true,
		llm: chatModel(),
	});
	const result = await withTimeout(
		SERVICE(registry, config()).judge(request(), { idleTimeoutMs: 25 }),
		1000,
	);
	assert.equal(result.stopReason, "stop");
	assert.equal(result.backend, "llm");
});

// --- timing ---

test("default idle windows: classifier 10s, LLM 15s", async () => {
	// Silent native attempt expires at the 10s default — prove via an
	// accelerated override-free check that the default constant is used.
	const registry = fakeRegistry({
		native: [jevModel()],
		nativeHangs: true,
		llm: chatModel(),
	});
	// Configured smaller slot value proves slot lookup; default constants
	// are asserted structurally.
	const service = SERVICE(
		registry,
		config({ timeouts: { classifier: { idleTimeoutMs: 30 } } }),
	);
	const result = await service.judge(request());
	assert.equal(result.stopReason, "stop");
	assert.equal(result.backend, "llm");
	assert.equal(DEFAULT_CLASSIFIER_IDLE_TIMEOUT_MS, 10_000);
	assert.equal(DEFAULT_LLM_IDLE_TIMEOUT_MS, 15_000);
});

test("native idle expiry: non-streaming classifier fails at the idle window", async () => {
	const registry = fakeRegistry({
		native: [jevModel()],
		nativeHangs: true,
	});
	const result = await SERVICE(
		registry,
		config({
			mode: "classifier",
			timeouts: { classifier: { idleTimeoutMs: 30 } },
		}),
	).judge(request());
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /no generation progress|timed out/i);
});

test("fresh alternate clocks: fallback gets its own independent window", async () => {
	const registry = fakeRegistry({
		native: [jevModel()],
		nativeHangs: true,
		llm: chatModel(),
	});
	const started = Date.now();
	const result = await SERVICE(registry, config()).judge(request(), {
		idleTimeoutMs: 30,
	});
	assert.equal(result.stopReason, "stop");
	assert.equal(result.backend, "llm");
	// LLM got its own fresh clock — it did not inherit the spent native window.
	assert.ok(Date.now() - started < 5_000);
});

test("hard cap spans the whole attempt including setup", async () => {
	const registry = fakeRegistry({
		native: [jevModel()],
		nativeDelayMs: 200,
		llm: chatModel(),
	});
	const result = await SERVICE(registry, config()).judge(request(), {
		modelTimeoutMs: 40,
	});
	// Native exhausts its 40ms hard cap mid-classification; LLM gets fresh
	// 40ms and completes fast.
	assert.equal(result.stopReason, "stop");
	assert.equal(result.backend, "llm");
});

test("LLM heartbeat-shaped events without generation never renew idle", async () => {
	const registry = fakeRegistry({ llm: chatModel() });
	// Emit heartbeat/empty events periodically, then never finish: only
	// genuine generation renews idle, so the attempt still expires.
	registry.streamSimple = (_m, _c, options) => {
		const stream = createAssistantMessageEventStream();
		const beat = setInterval(() => {
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: "  ",
				partial: llmMessage([]),
			});
			if (options?.signal?.aborted) clearInterval(beat);
		}, 10);
		return stream;
	};
	const result = await SERVICE(
		registry,
		config({ mode: "llm", timeouts: { llm: { idleTimeoutMs: 35 } } }),
	).judge(request());
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /no generation progress|timed out/i);
});

test("stalled LLM stream expires at its idle window", async () => {
	const registry = fakeRegistry({ llm: chatModel(), llmHangs: true });
	const result = await SERVICE(
		registry,
		config({ mode: "llm", timeouts: { llm: { idleTimeoutMs: 30 } } }),
	).judge(request());
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /no generation progress|timed out/i);
});

test("genuine generation outlasts the idle number with no hard cap", async () => {
	const registry = fakeRegistry({ llm: chatModel() });
	registry.streamSimple = (_m, _c, _options) => {
		const stream = createAssistantMessageEventStream();
		let n = 0;
		const beat = setInterval(() => {
			n += 1;
			if (n >= 5) {
				clearInterval(beat);
				stream.push({
					type: "toolcall_delta",
					contentIndex: 0,
					delta: "true",
					partial: llmMessage([]),
				});
				stream.end(llmMessage([toolCall({ value: true })]));
				return;
			}
			stream.push({
				type: "thinking_delta",
				contentIndex: 0,
				delta: "thinking",
				partial: llmMessage([]),
			});
		}, 15);
		return stream;
	};
	const result = await withTimeout(
		SERVICE(registry, config({ mode: "llm" })).judge(request(), {
			idleTimeoutMs: 30,
		}),
		1000,
	);
	assert.equal(result.stopReason, "stop");
});

// --- migration gate ---

test("one LLM hard cap spans serial questions and output repair; omission leaves no cap", async () => {
	for (const hardLimit of [undefined, 120]) {
		let calls = 0;
		const registry = fakeRegistry({ llm: chatModel() });
		registry.streamSimple = (_model, _context, options) => {
			calls++;
			const final =
				calls === 2 ? llmMessage([]) : llmMessage([toolCall({ value: true })]);
			const stream = createAssistantMessageEventStream();
			const timer = setTimeout(() => stream.end(final), 50);
			options?.signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					stream.end({ ...final, content: [], stopReason: "aborted" });
				},
				{ once: true },
			);
			return stream;
		};
		const result = await withTimeout(
			SERVICE(registry, config({ mode: "llm" })).judge(
				{ state: {}, questions: { first: BOOL, second: BOOL } },
				{
					idleTimeoutMs: 1000,
					...(hardLimit === undefined ? {} : { modelTimeoutMs: hardLimit }),
				},
			),
			2000,
		);
		assert.equal(
			calls,
			3,
			"two questions and one repair share the same attempt",
		);
		assert.equal(result.stopReason, hardLimit === undefined ? "stop" : "error");
		if (hardLimit === undefined)
			assert.deepEqual(Object.keys(result.answers), ["first", "second"]);
		else
			assert.deepEqual(
				result.answers,
				{},
				"hard expiry must not publish the first answer",
			);
	}
});

test("legacy timeoutMs blocks inference with an actionable error", async () => {
	const registry = fakeRegistry({ native: [jevModel()] });
	const service = createJudgmentService({
		registry,
		config: () => config(),
		settingsBlock: () =>
			'llm-as-jev.json: legacy "timeoutMs" requires migration',
	});
	const result = await service.judge(request());
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /requires migration/);
	assert.equal(registry.nativeCalls.length, 0);
});

// --- public error boundaries ---

test("judge hides non-HTTP adapter bodies on results, rejection and abort", async () => {
	for (const message of [
		"PRIVATE-ERROR-BODY",
		'{"message":"PRIVATE-ERROR-BODY (400)"}',
	]) {
		for (const kind of [
			"native",
			"rejection",
			"aborted",
			"llm",
			"throw",
		] as const) {
			const registry = fakeRegistry({
				native: [jevModel()],
				nativeResult: {
					...jevAnswer(),
					stopReason: kind === "aborted" ? "aborted" : "error",
					errorMessage: message,
				},
				...(kind === "rejection" ? { nativeError: new Error(message) } : {}),
				llm: chatModel(),
				llmMessages: [
					{ ...llmMessage([]), stopReason: "error", errorMessage: message },
				],
			});
			if (kind === "throw")
				registry.streamSimple = () => {
					throw new Error(message);
				};
			const llm = kind === "llm" || kind === "throw";
			const result = await SERVICE(
				registry,
				config({ mode: llm ? "llm" : "classifier" }),
			).judge(request());
			assert.equal(result.stopReason, kind === "aborted" ? "aborted" : "error");
			assert.equal(result.model, llm ? "fake/fake-model" : "typesafe/jev-1.13");
			assert.equal(result.errorMessage, "provider or transport failure");
			assert.equal(result.contextOverflow, undefined);
		}
	}
});

test("discovery and metadata failures hide upstream bodies and settle safely", async () => {
	for (const mode of ["classifier", "llm"] as const) {
		const registry = fakeRegistry({});
		registry.getAvailableOfType = async () => {
			throw new Error('{"message":"PRIVATE-DISCOVERY"}');
		};
		registry.getModel = () => {
			throw new Error("PRIVATE-LOOKUP");
		};
		const service = SERVICE(
			registry,
			config({ mode, classifierModel: "typesafe/jev-1.13" }),
		);
		const result = await service.judge(request());
		assert.equal(result.stopReason, "error");
		assert.equal(
			result.model,
			mode === "classifier" ? "typesafe/jev-1.13" : "fake/fake-model",
		);
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE-/);
		const selection = await service.describeSelection?.();
		assert.deepEqual(selection, { error: "provider or transport failure" });
		assert.deepEqual(await service.availability(), {});
	}
	const service = createJudgmentService({
		registry: fakeRegistry({}),
		config: () => {
			throw new Error("PRIVATE-CONFIG-READ");
		},
	});
	assert.deepEqual(await service.describeSelection?.(), {
		error: "provider or transport failure",
	});
	assert.deepEqual(await service.availability(), {});
	assert.doesNotMatch(
		JSON.stringify(await service.judge(request())),
		/PRIVATE-/,
	);
});

test("overflow uses SDK status prefixes, not parenthesized digits in bodies", async () => {
	for (const [message, overflow] of [
		['System One API error (400): {"code":"context_length_exceeded"}', true],
		['400: {"code":"context_length_exceeded"}', true],
		['408: {"code":"context_length_exceeded"}', true],
		['413: {"code":"context_length_exceeded"}', true],
		['401: {"code":"context_length_exceeded"}', false],
		['402: {"code":"context_length_exceeded"}', false],
		['422: {"code":"context_length_exceeded"}', false],
		['System One API error (422): {"code":"context_length_exceeded"}', false],
		['{"message":"context_length_exceeded; reference (401)"}', true],
	] as const) {
		for (const mode of ["classifier", "llm"] as const) {
			const registry = fakeRegistry({
				native: [jevModel()],
				nativeResult: {
					...jevAnswer(),
					stopReason: "error",
					errorMessage: message,
				},
				llm: chatModel(),
				llmMessages: [
					{ ...llmMessage([]), stopReason: "error", errorMessage: message },
				],
			});
			const result = await SERVICE(registry, config({ mode })).judge(request());
			assert.equal(result.contextOverflow === true, overflow, message);
			assert.equal(
				result.model,
				mode === "classifier" ? "typesafe/jev-1.13" : "fake/fake-model",
			);
			assert.doesNotMatch(
				result.errorMessage ?? "",
				/context_length_exceeded|reference/,
			);
		}
	}
});

test("native thrown SDK errors retain status-based overflow discrimination", async () => {
	for (const status of [422, 401, 402, 400]) {
		const registry = fakeRegistry({
			native: [jevModel()],
			nativeError: new Error(`${status}: context_length_exceeded`),
		});
		const result = await SERVICE(
			registry,
			config({ mode: "classifier" }),
		).judge(request());
		assert.equal(
			result.contextOverflow === true,
			status === 400,
			String(status),
		);
		assert.equal(
			result.errorMessage,
			`provider request failed (HTTP ${status})`,
		);
	}
});

// --- capacity v2 ---

test("describeSelection is read-only and reports override/model/none", async () => {
	const registry = fakeRegistry({ native: [jevModel()] });
	const service = SERVICE(registry, config());
	const sel = await service.describeSelection?.();
	assert.ok(sel && !("error" in sel));
	if (!("error" in sel)) {
		assert.equal(sel.backend, "classifier");
		assert.equal(sel.model, "typesafe/jev-1.13");
		assert.equal(sel.limitSource, "model");
		assert.equal(sel.limits.contextWindow, 8192);
	}
	assert.equal(registry.nativeCalls.length, 0); // no inference

	const overridden = SERVICE(
		registry,
		config({ contextLimits: { "typesafe/jev-1.13": { request: 100 } } }),
	);
	const sel2 = await overridden.describeSelection?.();
	assert.ok(sel2 && !("error" in sel2));
	if (!("error" in sel2)) {
		assert.equal(sel2.limitSource, "override");
		assert.deepEqual(sel2.limits, { request: 100 });
	}

	const noMeta = fakeRegistry({
		llm: { ...chatModel(), contextWindow: 0 },
	});
	const sel3 = await SERVICE(
		noMeta,
		config({ mode: "llm" }),
	).describeSelection?.();
	assert.ok(sel3 && !("error" in sel3));
	if (!("error" in sel3)) {
		assert.equal(sel3.limitSource, "none");
		assert.deepEqual(sel3.limits, {});
	}
});

test("fallback result reports the actual terminal model's capacity", async () => {
	const registry = fakeRegistry({
		native: [jevModel()],
		nativeError: new Error("down"),
		llm: chatModel(4096),
	});
	const result = await SERVICE(registry, config()).judge(request());
	assert.equal(result.backend, "llm");
	assert.equal(result.capacity?.model, "fake/fake-model");
	assert.equal(result.capacity?.limits.contextWindow, 4096);
});

// --- cancellation and lifecycle ---

test("concurrent identical calls keep independent cancellation", async () => {
	const registry = fakeRegistry({ native: [jevModel()], nativeDelayMs: 60 });
	const service = SERVICE(registry, config());
	const one = new AbortController();
	const a = service.judge(request(), { signal: one.signal });
	const b = service.judge(request());
	setTimeout(() => one.abort(), 5);
	const [ra, rb] = await Promise.all([a, b]);
	assert.equal(ra.stopReason, "aborted");
	assert.equal(rb.stopReason, "stop");
});

test("abortAll cancels in-flight work (navigation/shutdown)", async () => {
	const registry = fakeRegistry({ native: [jevModel()], nativeDelayMs: 500 });
	const service = SERVICE(registry, config());
	const pending = service.judge(request());
	setTimeout(() => service.abortAll(), 10);
	const result = await withTimeout(pending, 1000);
	assert.equal(result.stopReason, "aborted");
});

// --- policy ---

test("named-choice probability rule applies to fresh inference only", async () => {
	const registry = fakeRegistry({ native: [jevModel()] });
	registry.classify = (async (
		_m: AnyClassifierModel,
		_c: unknown,
		o?: { signal?: AbortSignal },
	) => {
		registry.nativeCalls.push({ options: o });
		return {
			api: "typesafe-system-one",
			provider: "typesafe",
			model: "jev-1.13",
			answers: {
				v: {
					type: "choice",
					choice: "a",
					probabilities: { a: 0.85, b: 0.15 },
					confidence: 0.7,
				},
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
	}) as typeof registry.classify;
	const req: JudgeRequest = {
		state: {},
		questions: {
			v: { type: "choice", instructions: "pick", criteria: { a: "A", b: "B" } },
		},
	};
	const service = SERVICE(registry, config());
	const pass = await service.judge(req, {
		thresholds: {
			v: { metric: "choiceProbability", choice: "a", minimum: 0.8 },
		},
	});
	assert.equal(pass.answers.v?.type, "choice");
	// Same request with a stricter rule runs FRESH inference.
	const fail = await service.judge(req, {
		thresholds: {
			v: { metric: "choiceProbability", choice: "a", minimum: 0.9 },
		},
	});
	assert.deepEqual(fail.dropped, ["v"]);
	assert.equal(registry.nativeCalls.length, 2);
});

test("malformed raw answer never publishes partial results", async () => {
	const registry = fakeRegistry({
		native: [jevModel()],
		nativeResult: {
			...jevAnswer(0),
			answers: { ok: { type: "bool" } as never }, // missing probability
			stopReason: "stop",
		},
	});
	const result = await SERVICE(registry, config({ mode: "classifier" })).judge(
		request(),
	);
	assert.equal(result.stopReason, "error");
	assert.deepEqual(result.answers, {});
});
