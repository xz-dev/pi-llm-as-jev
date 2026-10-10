/**
 * Integration tests for judge() end to end (tasks 5.3, 4.2-4.7, 6.1-6.2)
 * with fake registries: backend selection, never-throws, caching, evidence
 * recovery, cancellation/branch races, ledger resume.
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
	Tool,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import type {
	ClassifierAnswer,
	JudgeOptions,
	JudgeRequest,
	JudgeResult,
} from "../client/judgment-client.ts";
import type { JudgmentConfig } from "../src/config.ts";
import { LEDGER_TYPE, type LedgerRecord } from "../src/ledger.ts";
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

function chatModel(contextWindow = 8192, reasoning = false): AnyModel {
	return {
		type: undefined,
		id: "fake-model",
		provider: "fake",
		api: "openai-completions",
		baseUrl: "https://fake.invalid",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning,
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

/** Answers a bool question through the discrete tool-call shape. */
function boolToolMessage(value: boolean): AssistantMessage {
	return llmMessage([toolCall({ value })]);
}
function choiceToolMessage(choice: string): AssistantMessage {
	return llmMessage([toolCall({ choice })]);
}
function scoreToolMessage(score: number): AssistantMessage {
	return llmMessage([toolCall({ score })]);
}

/** Jev-shaped result builder. */
function jevResult(
	answers: Record<string, unknown>,
	model = "typesafe/jev-1.13",
): ClassifierResult {
	return {
		api: "typesafe-system-one",
		provider: "typesafe",
		model,
		answers: answers as ClassifierResult["answers"],
		stopReason: "stop",
		usage: USAGE,
		timestamp: Date.now(),
	};
}

/**
 * Fake registry: no jev models by default, one scripted LLM queue, optional
 * jev classifier with scripted classify results. Records every dispatch.
 */
class FakeRegistry implements ServiceRegistry {
	llmCalls: { userContent: string; toolNames: string[] }[] = [];
	jevCalls: { model: string; state: unknown; questions: string[] }[] = [];
	private llmQueue: AssistantMessage[] = [];
	private jevResults: ClassifierResult[] = [];
	private lastJevResult: ClassifierResult | null = null;
	available: AnyClassifierModel[] = [];
	llm: AnyModel | undefined;
	/** Secrets this registry reports as resolved (for redaction tests). */
	authKeys = new Map<string, string>();
	llmContextWindow = 8192;
	jevContextWindow = 8192;

	replayLlm(messages: AssistantMessage[]) {
		this.llmQueue = [...messages];
	}
	replayJev(results: ClassifierResult[]) {
		this.jevResults = [...results];
	}

	getProviders(): { id: string }[] {
		return [...this.authKeys.keys()].map((id) => ({ id }));
	}

	async getAuth(providerId: string) {
		const key = this.authKeys.get(providerId);
		return key ? { auth: { apiKey: key } } : undefined;
	}

	getModel(provider: string, id: string): AnyModel | undefined {
		if (this.llm && this.llm.provider === provider && this.llm.id === id) {
			return { ...this.llm, contextWindow: this.llmContextWindow };
		}
		return undefined;
	}

	async getAvailableOfType(): Promise<readonly AnyClassifierModel[]> {
		return this.available.map((m) => ({
			...m,
			contextWindow: this.jevContextWindow,
		}));
	}

	async classify(
		model: AnyClassifierModel,
		context: {
			state: Record<string, unknown>;
			questions: Record<string, unknown>;
		},
	): Promise<ClassifierResult> {
		this.jevCalls.push({
			model: `${model.provider}/${model.id}`,
			state: context.state,
			questions: Object.keys(context.questions),
		});
		const next = this.jevResults.shift() ?? this.lastJevResult ?? null;
		if (next) this.lastJevResult = next;
		if (!next) throw new Error("no scripted jev result");
		return next;
	}

	streamSimple(
		_model: never,
		context: {
			systemPrompt: string;
			messages: { content: unknown }[];
			tools: Tool[];
		},
		options?: Parameters<ServiceRegistry["streamSimple"]>[2],
	): { result(): Promise<AssistantMessage> } {
		void options;
		this.llmCalls.push({
			userContent: String((context.messages[0] as { content: string }).content),
			toolNames: context.tools.map((t) => t.name),
		});
		const next = this.llmQueue.shift() ?? llmMessage([]);
		return {
			result: async () => next,
		};
	}
}

/** Narrow an answer by type for assertions. */
function asChoice(a: ClassifierAnswer | undefined) {
	assert.equal(a?.type, "choice");
	return a as {
		type: "choice";
		choice: string;
		probabilities: Record<string, number>;
		confidence: number;
	};
}
function asBool(a: ClassifierAnswer | undefined) {
	assert.equal(a?.type, "bool");
	return a as { type: "bool"; probability: number };
}

/** Harness whose registry already resolves one provider key (pre-construction). */
function harnessWithAuth(key: string): Harness {
	const registry = new FakeRegistry();
	registry.llm = chatModel();
	registry.authKeys.set("fake", key);
	const ledgerRecords: LedgerRecord[] = [];
	const branchEntries: unknown[] = [];
	const config = baseConfig();
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: {
			append: (_type, data) => ledgerRecords.push(data),
			branch: () => branchEntries,
		},
	});
	return { registry, ledgerRecords, branchEntries, service, config };
}

function baseConfig(overrides: Partial<JudgmentConfig> = {}): JudgmentConfig {
	return {
		mode: "llm",
		thinkingLevel: "off",
		timeoutMs: 5000,
		model: "fake/fake-model",
		provider: "fake",
		modelId: "fake-model",
		...overrides,
	};
}

function mixedRequest(): JudgeRequest {
	return {
		state: { project: "svc", stage: "test" },
		questions: {
			deploy: {
				type: "choice",
				instructions: "Pick the deployment verdict",
				criteria: { ship: "Ready", hold: "Hold", revert: "Revert" },
			},
			green: {
				type: "bool",
				instructions: "Are tests green?",
				criteria: { true: "yes", false: "no" },
			},
			severity: {
				type: "score",
				instructions: "Rate severity",
				criteria: ["low", "medium", "high"],
			},
		},
	};
}

interface Harness {
	registry: FakeRegistry;
	ledgerRecords: LedgerRecord[];
	branchEntries: unknown[];
	service: ReturnType<typeof createJudgmentService>;
	config: JudgmentConfig;
}

function harness(overrides: Partial<JudgmentConfig> = {}): Harness {
	const registry = new FakeRegistry();
	registry.llm = chatModel();
	const ledgerRecords: LedgerRecord[] = [];
	const branchEntries: unknown[] = [];
	const config = baseConfig(overrides);
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: {
			append: (type, data) => {
				assert.equal(type, LEDGER_TYPE);
				ledgerRecords.push(data);
			},
			branch: () => branchEntries,
		},
	});
	return { registry, ledgerRecords, branchEntries, service, config };
}

// ---------------------------------------------------------------------------
// Focused milestone: no Jev + LLM → discrete mixed-type answers
// ---------------------------------------------------------------------------

test("milestone: no jev, LLM answers choice/bool/score discretely with backend llm", async () => {
	const h = harness();
	h.registry.replayLlm([
		choiceToolMessage("ship"),
		boolToolMessage(true),
		scoreToolMessage(2),
	]);
	const result = await h.service.judge(mixedRequest());
	assert.equal(result.stopReason, "stop");
	assert.equal(result.backend, "llm");
	assert.equal(result.model, "fake/fake-model");
	assert.equal(result.answers.deploy.type, "choice");
	assert.equal(result.answers.deploy.choice, "ship");
	// Compatibility encoding, not self-reported certainty:
	assert.equal(result.answers.deploy.confidence, 1);
	assert.equal(result.answers.deploy.probabilities.ship, 1);
	assert.equal(result.answers.green.type, "bool");
	assert.equal(result.answers.green.probability, 1);
	assert.equal(result.answers.severity.type, "score");
	assert.equal(result.answers.severity.score, 2);
	assert.deepEqual(result.dropped, []);
	assert.equal(result.reuse.sent, 3); // one LLM call per question
	assert.equal(result.usage?.input, 30); // reported, summed
	assert.equal(h.registry.jevCalls.length, 0);
});

test("milestone: structured missing-backend errors, never a throw", async () => {
	// No LLM configured, mode llm.
	const h = harness({
		mode: "llm",
		model: undefined,
		provider: undefined,
		modelId: undefined,
	});
	const result = await h.service.judge(mixedRequest());
	assert.equal(result.stopReason, "error");
	assert.deepEqual(result.answers, {});
	assert.ok(result.errorMessage);
	assert.match(result.errorMessage!, /no LLM model is configured/);

	// Forced classifier mode with no native candidate: never switches to LLM.
	const h2 = harness({ mode: "classifier" });
	h2.registry.llm = chatModel();
	const r2 = await h2.service.judge(mixedRequest());
	assert.equal(r2.stopReason, "error");
	assert.match(r2.errorMessage!, /No Jev classifier model is available/);
	assert.equal(h2.registry.llmCalls.length, 0);
	assert.equal(h2.registry.jevCalls.length, 0);

	// Auto with neither: error naming the configuration.
	const h3 = harness({
		mode: "auto",
		model: undefined,
		provider: undefined,
		modelId: undefined,
	});
	const r3 = await h3.service.judge(mixedRequest());
	assert.equal(r3.stopReason, "error");
	assert.match(
		r3.errorMessage!,
		/no selected\/default native classifier is available and no LLM model is configured/,
	);
});

test("milestone: repeated identical call hits the raw cache with zero new dispatches", async () => {
	const h = harness();
	h.registry.replayLlm([boolToolMessage(true)]);
	const req: JudgeRequest = {
		state: { a: 1 },
		questions: {
			q: {
				type: "bool",
				instructions: "ok?",
				criteria: { true: "y", false: "n" },
			},
		},
	};
	const first = await h.service.judge(req);
	assert.equal(first.stopReason, "stop");
	assert.equal(first.reuse.sent, 1);
	assert.equal(first.reuse.hits, 0);
	const second = await h.service.judge(req);
	assert.equal(second.stopReason, "stop");
	assert.equal(second.reuse.sent, 0);
	assert.equal(second.reuse.hits, 1);
	assert.deepEqual(second.answers, first.answers);
	assert.equal(h.registry.llmCalls.length, 1);
});

test("milestone: stricter Jev caller policy on a cached raw judgment drops without re-sending", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.replayJev([
		jevResult({
			q: {
				type: "choice",
				choice: "ok",
				probabilities: { ok: 0.9, bad: 0.1 },
				confidence: 0.85,
			},
		}),
	]);
	const req: JudgeRequest = {
		state: { a: 1 },
		questions: {
			q: {
				type: "choice",
				instructions: "pick",
				criteria: { ok: "fine", bad: "not fine" },
			},
		},
	};
	const lenient = await h.service.judge(req, { minConfidence: 0.8 });
	assert.equal(lenient.stopReason, "stop");
	assert.equal(asChoice(lenient.answers.q).choice, "ok");
	assert.deepEqual(lenient.dropped, []);
	const strict = await h.service.judge(req, { minConfidence: 0.9 });
	assert.equal(strict.stopReason, "stop");
	assert.deepEqual(strict.answers, {});
	assert.deepEqual(strict.dropped, ["q"]);
	// No second provider request for the stricter view.
	assert.equal(h.registry.jevCalls.length, 1);
});

// ---------------------------------------------------------------------------
// Backend selection scenarios (spec: Backend selection / Never throws)
// ---------------------------------------------------------------------------

test("auto prefers jev when a jev classifier is available", async () => {
	const h = harness({ mode: "auto" });
	h.registry.available = [jevModel()];
	h.registry.replayJev([jevResult({ q: { type: "bool", probability: 0.95 } })]);
	const result = await h.service.judge({
		state: {},
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	});
	assert.equal(result.backend, "classifier");
	assert.equal(result.model, "typesafe/jev-1.13");
	assert.equal(asBool(result.answers.q).probability, 0.95);
	assert.equal(h.registry.llmCalls.length, 0);
});

test("auto without jev falls back to the configured LLM model", async () => {
	const h = harness({ mode: "auto" });
	h.registry.replayLlm([boolToolMessage(false)]);
	const result = await h.service.judge({
		state: {},
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	});
	assert.equal(result.backend, "llm");
	assert.equal(asBool(result.answers.q).probability, 0);
});

test("forced llm mode never uses a jev classifier even when available", async () => {
	const h = harness({ mode: "llm" });
	h.registry.available = [jevModel()];
	h.registry.replayLlm([boolToolMessage(true)]);
	const result = await h.service.judge({
		state: {},
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	});
	assert.equal(result.backend, "llm");
	assert.equal(h.registry.jevCalls.length, 0);
});

test("availability reports classifier and llm identities", async () => {
	const h = harness({ mode: "auto" });
	h.registry.authKeys.set("fake", "usable-key"); // usable credentials
	h.registry.available = [jevModel()];
	assert.deepEqual(await h.service.availability(), {
		classifier: "typesafe/jev-1.13",
		llm: "fake/fake-model",
	});
});

// ---------------------------------------------------------------------------
// Never throws
// ---------------------------------------------------------------------------

test("judge resolves (never throws) for invalid inputs", async () => {
	const h = harness();
	h.registry.replayLlm([boolToolMessage(true)]);
	const cases: unknown[] = [
		null,
		undefined,
		42,
		"string",
		{ state: "not-object", questions: {} },
		{ state: {}, questions: [] },
		{ state: {}, questions: {} },
		{ state: {}, questions: { q: { type: "banana", instructions: "?" } } },
		{
			state: {},
			questions: { q: { type: "choice", instructions: "?", criteria: {} } },
		},
		{
			state: {},
			questions: { q: { type: "score", instructions: "?", criteria: [] } },
		},
		{
			state: {},
			questions: {
				q: {
					type: "bool",
					instructions: "?",
					criteria: { true: 1, false: "n" },
				},
			},
		},
		{
			state: {},
			questions: { q: { type: "bool", instructions: "?" } },
			evidence: "no",
		},
		{
			state: {},
			questions: {
				q: {
					type: "bool",
					instructions: "?",
					criteria: { true: "y", false: "n" },
				},
			},
			evidence: [
				{ id: "dup", text: "a" },
				{ id: "dup", text: "b" },
			],
		},
	];
	for (const bad of cases) {
		const result = await h.service.judge(bad as JudgeRequest);
		assert.equal(
			result.stopReason,
			"error",
			`expected error for ${JSON.stringify(bad)}`,
		);
		assert.deepEqual(result.answers, {});
		assert.ok(result.errorMessage);
	}
	// Invalid options also resolve, never throw.
	const badOpts = await h.service.judge(
		{
			state: {},
			questions: {
				q: {
					type: "bool",
					instructions: "?",
					criteria: { true: "y", false: "n" },
				},
			},
		},
		{ minConfidence: 5 } as JudgeOptions,
	);
	assert.equal(badOpts.stopReason, "error");
	const badRule = await h.service.judge(
		{
			state: {},
			questions: {
				q: { type: "choice", instructions: "?", criteria: { ok: "y" } },
			},
		},
		{
			thresholds: {
				q: { metric: "choiceProbability", choice: "absent", minimum: 0.5 },
			},
		},
	);
	assert.equal(badRule.stopReason, "error");
	assert.match(badRule.errorMessage!, /unknown choice "absent"/);
});

test("pre-aborted signal resolves aborted with no dispatch", async () => {
	const h = harness();
	h.registry.replayLlm([boolToolMessage(true)]);
	const controller = new AbortController();
	controller.abort();
	const result = await h.service.judge(
		{
			state: {},
			questions: {
				q: {
					type: "bool",
					instructions: "?",
					criteria: { true: "y", false: "n" },
				},
			},
		},
		{ signal: controller.signal },
	);
	assert.equal(result.stopReason, "aborted");
	assert.equal(h.registry.llmCalls.length, 0);
});

test("backend provider failure resolves as structured error", async () => {
	const h = harness();
	// Empty queue → no tool call → malformed → one retry → error.
	h.registry.replayLlm([llmMessage([]), llmMessage([])]);
	const result = await h.service.judge({
		state: {},
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	});
	assert.equal(result.stopReason, "error");
	assert.deepEqual(result.answers, {});
	assert.match(result.errorMessage!, /answer/);
});

// ---------------------------------------------------------------------------
// Caching identity
// ---------------------------------------------------------------------------

test("backend switch misses cache and sends a new request", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.replayJev([jevResult({ q: { type: "bool", probability: 0.9 } })]);
	const req: JudgeRequest = {
		state: { x: 1 },
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	};
	const jevResult1 = await h.service.judge(req);
	assert.equal(jevResult1.backend, "classifier");
	h.config.mode = "llm";
	h.registry.replayLlm([boolToolMessage(true)]);
	const llmView = await h.service.judge(req);
	assert.equal(llmView.backend, "llm");
	assert.equal(llmView.reuse.sent, 1);
	assert.equal(llmView.reuse.hits, 0);
});

test("thinking level change misses the cache", async () => {
	const h = harness();
	h.registry.llm = chatModel(8192, true); // reasoning-capable: high ≠ off
	h.registry.replayLlm([boolToolMessage(true), boolToolMessage(false)]);
	const req: JudgeRequest = {
		state: { x: 1 },
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	};
	await h.service.judge(req);
	h.config.thinkingLevel = "high";
	const second = await h.service.judge(req);
	assert.equal(second.reuse.sent, 1);
	assert.equal(asBool(second.answers.q).probability, 0);
});

test("in-flight join: concurrent identical calls send one dispatch", async () => {
	const h = harness();
	let release: (() => void) | undefined;
	const gate = new Promise<void>((res) => {
		release = res;
	});
	// First call slow: hold the queue result until released.
	h.registry.replayLlm([]);
	const originalStream = h.registry.streamSimple.bind(h.registry);
	h.registry.streamSimple = ((
		_model: never,
		context: { messages: { content: string }[]; tools: Tool[] },
	) => {
		h.registry.llmCalls.push({
			userContent: String(context.messages[0].content),
			toolNames: context.tools.map((t) => t.name),
		});
		return {
			result: async () => {
				await gate;
				return boolToolMessage(true);
			},
		};
	}) as typeof h.registry.streamSimple;
	const req: JudgeRequest = {
		state: { x: 1 },
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	};
	const p1 = h.service.judge(req);
	const p2 = h.service.judge(req);
	await new Promise((r) => setTimeout(r, 10));
	release?.();
	const [r1, r2] = await Promise.all([p1, p2]);
	assert.equal(r1.stopReason, "stop");
	assert.equal(r2.stopReason, "stop");
	assert.equal(r2.reuse.joined, 1);
	assert.equal(h.registry.llmCalls.length, 1);
	h.registry.streamSimple = originalStream;
});

test("fresh token forces a new judgment; retries within the token reuse it", async () => {
	const h = harness();
	h.registry.replayLlm([boolToolMessage(true), boolToolMessage(false)]);
	const req: JudgeRequest = {
		state: { x: 1 },
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	};
	const first = await h.service.judge(req);
	assert.equal(first.reuse.sent, 1);
	const forced = await h.service.judge(req, { fresh: "review-1" });
	assert.equal(forced.reuse.sent, 1); // old cache ignored
	assert.equal(forced.reuse.hits, 0);
	assert.equal(asBool(forced.answers.q).probability, 0);
	const retry = await h.service.judge(req, { fresh: "review-1" });
	assert.equal(retry.reuse.sent, 0); // same token reuse
	assert.equal(retry.reuse.hits, 1);
	const other = await h.service.judge(req, { fresh: "review-2" });
	assert.equal(other.reuse.sent, 1);
});

// ---------------------------------------------------------------------------
// Capacity, splitting, evidence recovery
// ---------------------------------------------------------------------------

test("question batch overflow splits into smaller batches and merges by id", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.jevContextWindow = 400; // tiny: forces splits
	const questions: JudgeRequest["questions"] = {};
	for (let i = 0; i < 8; i++) {
		questions[`q${i}`] = {
			type: "bool",
			instructions: `question ${i} ${"detail ".repeat(20)}`,
			criteria: { true: "y", false: "n" },
		};
	}
	const answers: ClassifierResult["answers"] = {};
	for (let i = 0; i < 8; i++)
		answers[`q${i}`] = { type: "bool", probability: 0.9 } as never;
	h.registry.replayJev([jevResult(answers)]);
	const result = await h.service.judge({ state: { s: 1 }, questions });
	assert.equal(result.stopReason, "stop");
	// Multiple smaller dispatches, not one giant one.
	assert.ok(h.registry.jevCalls.length >= 2);
	assert.equal(Object.keys(result.answers).length, 8);
});

test("irreducible single-question overflow fails explicitly, envelope not resent", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.jevContextWindow = 100;
	h.registry.replayJev([
		{
			...jevResult({}),
			stopReason: "error",
			errorMessage: "context_length_exceeded: input too large",
		},
	]);
	const req: JudgeRequest = {
		state: { huge: "x".repeat(5000) },
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	};
	const result = await h.service.judge(req);
	assert.equal(result.stopReason, "error");
	assert.equal(result.contextOverflow, true);
	assert.deepEqual(result.answers, {});
	assert.ok(result.errorMessage);
	// Exactly one dispatch: the rejected exact envelope was never resent.
	assert.equal(h.registry.jevCalls.length, 1);
	assert.ok(result.capacity);
	assert.equal(result.inputDimensions?.length, 1);
	assert.ok(result.inputDimensions[0].stateBytes >= 5000);
	assert.ok(result.inputDimensions[0].questionBytes > 0);
	assert.ok(result.inputDimensions[0].longestQuestionBytes > 0);
	// A second identical call is still rejected without re-sending.
	const again = await h.service.judge(req);
	assert.equal(again.stopReason, "error");
	assert.equal(again.contextOverflow, true);
	assert.deepEqual(again.inputDimensions, []);
	assert.equal(h.registry.jevCalls.length, 1);
});

test("oversized single evidence record is processed through ordered Unicode-safe fragments", async () => {
	const h = harness();
	h.registry.llmContextWindow = 8000;
	// One record ~ 12k chars, two fragments of ~6k; with a low context window
	// the pipeline splits until each stage fits.
	const big = "🚀data ".repeat(1800); // surrogate pairs + ascii
	h.registry.replayLlm([boolToolMessage(true), boolToolMessage(true)]);
	const result = await h.service.judge({
		state: { fixed: 1 },
		questions: {
			q: {
				type: "bool",
				instructions: "read all evidence",
				criteria: { true: "y", false: "n" },
			},
		},
		evidence: [{ id: "big", text: big }],
	});
	assert.equal(result.stopReason, "stop");
	assert.ok(h.registry.llmCalls.length >= 2);
	// Fragments retain source identity and ABSOLUTE bounds under the internal
	// namespaced key (caller metadata is untouched — there is none here).
	const fragments = h.registry.llmCalls
		.map((c) => JSON.parse(c.userContent))
		.flatMap((payload) =>
			(
				payload.state.evidence as {
					id: string;
					fragmentBounds?: unknown;
				}[]
			).map((r) => r),
		)
		.filter(
			(r) => typeof r.fragmentBounds === "object" && r.fragmentBounds !== null,
		);
	assert.ok(fragments.length >= 2);
	const boundsOf = (r: { fragmentBounds?: unknown }) =>
		r.fragmentBounds as {
			of: string;
			start: number;
			end: number;
			total: number;
		};
	for (const fragment of fragments) {
		assert.equal(boundsOf(fragment).of, "big");
	}
	// Full coverage: fragments' ranges cover [0, total) contiguously.
	const sorted = fragments.map(boundsOf).sort((a, b) => a.start - b.start);
	assert.equal(sorted[0].start, 0);
	for (let i = 1; i < sorted.length; i++)
		assert.equal(sorted[i].start, sorted[i - 1].end);
	assert.equal(sorted.at(-1)?.end, sorted.at(-1)?.total);
});

test("late-stage failure returns no final answers though earlier stages cached", async () => {
	const h = harness();
	h.registry.llmContextWindow = 6000;
	// Two records: first stage answers, second stage fails.
	const okRecord = { id: "first", text: "first record ".repeat(100) };
	const failRecord = { id: "second", text: "second record ".repeat(600) };
	h.registry.replayLlm([
		boolToolMessage(true),
		{
			...llmMessage([]),
			stopReason: "error",
			errorMessage: "provider exploded",
		} as AssistantMessage,
	]);
	const result = await h.service.judge({
		state: { s: 1 },
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
		evidence: [okRecord, failRecord],
	});
	assert.equal(result.stopReason, "error");
	assert.deepEqual(result.answers, {});
	assert.match(result.errorMessage!, /provider exploded|answer/);
	// But the validated first stage was cached: a retry reuses it.
	h.registry.replayLlm([boolToolMessage(true)]);
	const retry = await h.service.judge({
		state: { s: 1 },
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
		evidence: [okRecord, failRecord],
	});
	// retry sends fewer dispatches than the first run (first stage is a hit)
	assert.ok(retry.reuse.sent < 3);
});

test("no-evidence fixed state cannot fit → explicit overflow, nothing cropped", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.jevContextWindow = 200;
	h.registry.replayJev([
		{
			...jevResult({}),
			stopReason: "error",
			errorMessage: "maximum context window is 200 tokens; requested 5000",
		},
	]);
	const result = await h.service.judge({
		state: { blob: "x".repeat(10000) },
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	});
	assert.equal(result.stopReason, "error");
	assert.equal(result.contextOverflow, true);
	assert.deepEqual(result.answers, {});
});

// ---------------------------------------------------------------------------
// Cancellation and generation isolation (task 4.7)
// ---------------------------------------------------------------------------

test("canceled waiter resolves aborted and persists no new judgments", async () => {
	const h = harness();
	const controller = new AbortController();
	const original = h.registry.streamSimple.bind(h.registry);
	h.registry.streamSimple = ((
		_model: never,
		context: Parameters<ServiceRegistry["streamSimple"]>[1],
		options?: Parameters<ServiceRegistry["streamSimple"]>[2],
	) => {
		h.registry.llmCalls.push({
			userContent: String(context.messages[0].content),
			toolNames: context.tools.map((t) => t.name),
		});
		return {
			result: () =>
				new Promise<AssistantMessage>((resolve, reject) => {
					const signal = options?.signal;
					if (!signal) return resolve(boolToolMessage(true));
					if (signal.aborted) return reject(new Error("aborted"));
					signal.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				}),
		};
	}) as typeof h.registry.streamSimple;
	const promise = h.service.judge(
		{
			state: {},
			questions: {
				q: {
					type: "bool",
					instructions: "?",
					criteria: { true: "y", false: "n" },
				},
			},
		},
		{ signal: controller.signal },
	);
	await new Promise((r) => setTimeout(r, 10));
	controller.abort();
	const result = await promise;
	assert.equal(result.stopReason, "aborted");
	assert.deepEqual(result.answers, {});
	// No judgment records persisted for the aborted request.
	assert.ok(!h.ledgerRecords.some((r) => r.kind === "judgment"));
	h.registry.streamSimple = original;
});

test("branch switch mid-flight: late result never persists into the new branch", async () => {
	const h = harness();
	let release: (() => void) | undefined;
	const gate = new Promise<void>((res) => {
		release = res;
	});
	h.registry.streamSimple = ((
		_model: never,
		context: Parameters<ServiceRegistry["streamSimple"]>[1],
	) => {
		h.registry.llmCalls.push({
			userContent: String(context.messages[0].content),
			toolNames: context.tools.map((t) => t.name),
		});
		return {
			result: async () => {
				await gate;
				return boolToolMessage(true);
			},
		};
	}) as typeof h.registry.streamSimple;
	const req: JudgeRequest = {
		state: {},
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	};
	const original = h.registry.streamSimple;
	const promise = h.service.judge(req);
	await new Promise((r) => setTimeout(r, 10));
	// Navigate branches while the request is in flight.
	h.service.refreshBranch();
	release?.();
	const result = await promise;
	// The whole work belonged to the abandoned generation.
	assert.equal(result.stopReason, "aborted");
	assert.deepEqual(result.answers, {});
	// The new branch contains no judgment from the late result.
	assert.ok(!h.ledgerRecords.some((r) => r.kind === "judgment"));
	h.registry.streamSimple = original;
});

// ---------------------------------------------------------------------------
// Ledger resume (tasks 6.1, 6.2)
// ---------------------------------------------------------------------------

test("two judge() calls across a simulated resume send exactly one backend request", async () => {
	const h = harness();
	h.registry.replayLlm([boolToolMessage(true)]);
	const req: JudgeRequest = {
		state: { resume: true },
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	};
	const first = await h.service.judge(req);
	assert.equal(first.reuse.sent, 1);
	assert.ok(h.ledgerRecords.some((r) => r.kind === "judgment"));
	// Simulate restart: rebuild branch entries from the ledger records.
	h.branchEntries.push(
		...h.ledgerRecords.map((data) => ({
			type: "custom",
			customType: LEDGER_TYPE,
			data,
		})),
	);
	h.service.refreshBranch();
	const resumed = await h.service.judge(req);
	assert.equal(resumed.reuse.sent, 0);
	assert.equal(resumed.reuse.hits, 1);
	assert.deepEqual(resumed.answers, first.answers);
	assert.equal(h.registry.llmCalls.length, 1); // exactly one backend request total
	// Stricter policy after resume reapplies without re-sending (LLM: nothing drops).
	const strict = await h.service.judge(req, { minConfidence: 0.99 });
	assert.equal(strict.reuse.sent, 0);
	assert.deepEqual(strict.dropped, []);
});

test("resume on jev cached data reapplies thresholds per caller", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.replayJev([
		jevResult({
			q: {
				type: "choice",
				choice: "ok",
				probabilities: { ok: 0.88, bad: 0.12 },
				confidence: 0.85,
			},
		}),
	]);
	const req: JudgeRequest = {
		state: { s: 1 },
		questions: {
			q: { type: "choice", instructions: "?", criteria: { ok: "y", bad: "n" } },
		},
	};
	await h.service.judge(req, { minConfidence: 0.8 });
	h.branchEntries.push(
		...h.ledgerRecords.map((data) => ({
			type: "custom",
			customType: LEDGER_TYPE,
			data,
		})),
	);
	h.service.refreshBranch();
	const restored = await h.service.judge(req, { minConfidence: 0.9 });
	assert.equal(restored.reuse.sent, 0);
	assert.deepEqual(restored.dropped, ["q"]); // 0.85 < 0.9 after restore
	assert.deepEqual(restored.answers, {});
});

test("branch without the persisted answer misses (branch isolation)", async () => {
	const h = harness();
	h.registry.replayLlm([boolToolMessage(true), boolToolMessage(true)]);
	const req: JudgeRequest = {
		state: { s: 1 },
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	};
	await h.service.judge(req);
	// Switch to a different branch WITHOUT restoring our entries.
	h.branchEntries.length = 0;
	h.service.refreshBranch();
	const other = await h.service.judge(req);
	assert.equal(other.reuse.sent, 1); // cache miss on the new branch
	assert.equal(other.reuse.hits, 0);
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("resolved provider keys are redacted from outgoing state and evidence", async () => {
	const h = harnessWithAuth("sk-super-secret");
	h.registry.replayLlm([boolToolMessage(true)]);
	const result = await h.service.judge({
		state: { note: "token is sk-super-secret here" },
		questions: {
			q: {
				type: "bool",
				instructions: "uses sk-super-secret",
				criteria: { true: "y", false: "n" },
			},
		},
		evidence: [{ id: "e", text: "leaked sk-super-secret" }],
	});
	assert.equal(result.stopReason, "stop");
	for (const call of h.registry.llmCalls) {
		assert.ok(
			!call.userContent.includes("sk-super-secret"),
			"secret reached the backend",
		);
	}
});

test("returned error messages never contain credentials", async () => {
	const h = harnessWithAuth("sk-topsecret");
	// Force an error whose provider text embeds the secret.
	h.registry.replayLlm([]);
	const originalStream = h.registry.streamSimple;
	h.registry.streamSimple = ((
		_model: never,
		context: { messages: { content: string }[]; tools: Tool[] },
	) => {
		h.registry.llmCalls.push({
			userContent: String(context.messages[0].content),
			toolNames: context.tools.map((t) => t.name),
		});
		return {
			result: async () =>
				({
					...llmMessage([]),
					stopReason: "error",
					errorMessage: "auth failed for key sk-topsecret",
				}) as AssistantMessage,
		};
	}) as typeof h.registry.streamSimple;
	const result = await h.service.judge({
		state: {},
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	});
	assert.equal(result.stopReason, "error");
	assert.ok(!result.errorMessage?.includes("sk-topsecret"));
	h.registry.streamSimple = originalStream;
});
test("diag accounting record per request, judgments only on success", async () => {
	const h = harness();
	h.registry.replayLlm([boolToolMessage(true)]);
	const req: JudgeRequest = {
		state: { s: 1 },
		questions: {
			q: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	};
	const ok = await h.service.judge(req);
	assert.equal(ok.stopReason, "stop");
	const judgments = h.ledgerRecords.filter((r) => r.kind === "judgment");
	const diags = h.ledgerRecords.filter((r) => r.kind === "diag");
	assert.equal(judgments.length, 1);
	assert.equal(diags.length, 1);
	assert.equal(diags[0].kind === "diag" ? diags[0].outcome : undefined, "stop");
	// Failure path records a diag with outcome error and no judgment.
	h.registry.replayLlm([]);
	h.registry.streamSimple = ((
		_m: never,
		ctx: Parameters<ServiceRegistry["streamSimple"]>[1],
	) => {
		h.registry.llmCalls.push({
			userContent: String((ctx.messages[0] as { content: string }).content),
			toolNames: ctx.tools.map((t) => t.name),
		});
		return {
			result: async () =>
				({
					...llmMessage([]),
					stopReason: "error",
					errorMessage: "boom",
				}) as AssistantMessage,
		};
	}) as typeof h.registry.streamSimple;
	const fail = await h.service.judge({
		state: { s: 2 },
		questions: {
			q2: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	});
	assert.equal(fail.stopReason, "error");
	const diags2 = h.ledgerRecords.filter((r) => r.kind === "diag");
	assert.equal(diags2.length, 2);
	assert.equal(
		diags2[1].kind === "diag" ? diags2[1].outcome : undefined,
		"error",
	);
	assert.equal(h.ledgerRecords.filter((r) => r.kind === "judgment").length, 1);
});

test("joined answer is threshold-checked for the joining caller", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	let release: (() => void) | undefined;
	const gate = new Promise<void>((res) => {
		release = res;
	});
	const original = h.registry.classify.bind(h.registry.classify);
	h.registry.classify = (async (
		model: AnyClassifierModel,
		context: {
			state: Record<string, unknown>;
			questions: Record<string, unknown>;
		},
	) => {
		h.registry.jevCalls.push({
			model: `${model.provider}/${model.id}`,
			state: context.state,
			questions: Object.keys(context.questions),
		});
		await gate;
		return jevResult({
			q: {
				type: "choice",
				choice: "ok",
				probabilities: { ok: 0.9, bad: 0.1 },
				confidence: 0.85,
			},
		});
	}) as typeof h.registry.classify;
	const req: JudgeRequest = {
		state: { s: 1 },
		questions: {
			q: { type: "choice", instructions: "?", criteria: { ok: "y", bad: "n" } },
		},
	};
	const lenient = h.service.judge(req, { minConfidence: 0.8 });
	const strict = h.service.judge(req, { minConfidence: 0.9 });
	await new Promise((r) => setTimeout(r, 10));
	release?.();
	const [a, b] = await Promise.all([lenient, strict]);
	assert.equal(a.stopReason, "stop");
	assert.equal(a.answers.q?.type, "choice");
	assert.equal(b.stopReason, "stop");
	assert.deepEqual(b.dropped, ["q"]); // 0.85 < 0.9 even though joined
	assert.equal(h.registry.jevCalls.length, 1);
	h.registry.classify = original;
});

test("timeoutMs deadline resolves error without retrying the request", async () => {
	const h = harness();
	const original = h.registry.streamSimple.bind(h.registry);
	let calls = 0;
	h.registry.streamSimple = ((
		_model: never,
		context: Parameters<ServiceRegistry["streamSimple"]>[1],
	) => {
		calls += 1;
		h.registry.llmCalls.push({
			userContent: String((context.messages[0] as { content: string }).content),
			toolNames: context.tools.map((t) => t.name),
		});
		return {
			// Hangs past the deadline; a late resolution must be dropped.
			result: () =>
				new Promise<AssistantMessage>(() => {
					/* never settles */
				}),
		};
	}) as typeof h.registry.streamSimple;
	const result = await h.service.judge(
		{
			state: {},
			questions: {
				q: {
					type: "bool",
					instructions: "?",
					criteria: { true: "y", false: "n" },
				},
			},
		},
		{ timeoutMs: 60 },
	);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /timed out after \d+ms/);
	assert.deepEqual(result.answers, {});
	assert.equal(calls, 1); // no retry
	h.registry.streamSimple = original;
});

// ---------------------------------------------------------------------------
// Native selection, pinned dispatch and identity freezing (tasks 4.1/4.2/
// 4.4/4.6/5.3/6.1/10.1 follow-up)
// ---------------------------------------------------------------------------

/** A compatible non-Jev native classifier (explicitly selectable). */
function nativeModel(): AnyClassifierModel {
	return {
		type: "classifier",
		id: "kev-2.1",
		provider: "typesafe",
		name: "kev",
		api: "typesafe-system-one",
		baseUrl: "https://unused.invalid",
		input: ["text"],
		contextWindow: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const BOOL_REQ: JudgeRequest = {
	state: { x: 1 },
	questions: {
		q: { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } },
	},
};

test("explicit classifierModel dispatches that exact non-Jev model, not default Jev", async () => {
	const h = harness({ mode: "auto" });
	h.registry.available = [jevModel(), nativeModel()];
	h.config.classifierModel = "typesafe/kev-2.1";
	h.config.classifierProvider = "typesafe";
	h.config.classifierModelId = "kev-2.1";
	h.registry.replayJev([
		jevResult({ q: { type: "bool", probability: 0.9 } }, "typesafe/kev-2.1"),
	]);
	const result = await h.service.judge(BOOL_REQ);
	assert.equal(result.backend, "classifier");
	assert.equal(result.model, "typesafe/kev-2.1");
	assert.equal(h.registry.jevCalls[0]?.model, "typesafe/kev-2.1");
	assert.equal(result.answers.q?.type, "bool");
});

test("missing explicit classifierModel never substitutes another native model", async () => {
	// auto + missing explicit + other native available → LLM fallback.
	const h = harness({ mode: "auto" });
	h.registry.available = [jevModel()];
	h.config.classifierModel = "typesafe/kev-9.9";
	h.config.classifierProvider = "typesafe";
	h.config.classifierModelId = "kev-9.9";
	h.registry.replayLlm([boolToolMessage(true)]);
	const auto = await h.service.judge(BOOL_REQ);
	assert.equal(auto.backend, "llm");
	assert.equal(h.registry.jevCalls.length, 0); // no native dispatch at all
	// Forced classifier mode with the same missing selection → error, no LLM.
	const h2 = harness({ mode: "classifier" });
	h2.registry.available = [jevModel()];
	h2.config.classifierModel = "typesafe/kev-9.9";
	h2.config.classifierProvider = "typesafe";
	h2.config.classifierModelId = "kev-9.9";
	h2.registry.replayLlm([boolToolMessage(true)]);
	const forced = await h2.service.judge(BOOL_REQ);
	assert.equal(forced.stopReason, "error");
	assert.match(forced.errorMessage!, /typesafe\/kev-9.9 is not available/);
	assert.equal(h2.registry.llmCalls.length, 0);
	assert.equal(h2.registry.jevCalls.length, 0);
});

test("selected native model survives a registry change mid-request (pinned dispatch)", async () => {
	const h = harness({ mode: "auto" });
	h.registry.available = [jevModel()];
	// Eight questions with a tiny context window force question subdivision;
	// the registry catalog changes between stage dispatches.
	h.registry.jevContextWindow = 400;
	const questions: JudgeRequest["questions"] = {};
	for (let i = 0; i < 4; i++) {
		questions[`q${i}`] = {
			type: "bool",
			instructions: `question ${i} ${"detail ".repeat(20)}`,
			criteria: { true: "y", false: "n" },
		};
	}
	const answers: ClassifierResult["answers"] = {};
	for (let i = 0; i < 4; i++)
		answers[`q${i}`] = { type: "bool", probability: 0.9 } as never;
	h.registry.replayJev([jevResult(answers)]);
	const original = h.registry.classify.bind(h.registry);
	let dispatches = 0;
	h.registry.classify = (async (
		model: AnyClassifierModel,
		context: Parameters<ServiceRegistry["classify"]>[1],
	) => {
		dispatches += 1;
		// After the first dispatch the catalog "changes": only a different
		// model remains available. Pinned dispatch must keep using jev-1.13.
		h.registry.available = [nativeModel()];
		return original(model, context);
	}) as typeof h.registry.classify;
	const result = await h.service.judge({ state: { s: 1 }, questions });
	assert.equal(result.stopReason, "stop");
	assert.ok(dispatches >= 2);
	for (const call of h.registry.jevCalls) {
		assert.equal(call.model, "typesafe/jev-1.13");
	}
	assert.equal(result.model, "typesafe/jev-1.13");
	// Every ledger judgment keeps the originally selected identity.
	for (const record of h.ledgerRecords) {
		if (record.kind === "judgment") {
			assert.equal(record.model, "typesafe/jev-1.13");
			assert.equal(record.backend, "classifier");
		}
	}
	h.registry.classify = original;
});

test("thinking mutation mid-flight does not change the dispatched level", async () => {
	const h = harness();
	h.registry.llm = chatModel(8192, true); // reasoning-capable
	let seenReasoning: unknown[] = [];
	const original = h.registry.streamSimple.bind(h.registry);
	let calls = 0;
	h.registry.streamSimple = ((
		model: never,
		context: Parameters<ServiceRegistry["streamSimple"]>[1],
		options?: Parameters<ServiceRegistry["streamSimple"]>[2],
	) => {
		calls += 1;
		seenReasoning.push(options?.reasoning);
		// Mutate the live config AFTER the request started: dispatch must use
		// the level frozen at request start, not a reread.
		if (calls === 1) h.config.thinkingLevel = "high";
		return original(model, context, options);
	}) as typeof h.registry.streamSimple;
	h.registry.replayLlm([boolToolMessage(true), boolToolMessage(true)]);
	const twoQuestions: JudgeRequest = {
		state: { x: 1 },
		questions: {
			q1: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
			q2: {
				type: "bool",
				instructions: "?",
				criteria: { true: "y", false: "n" },
			},
		},
	};
	const result = await h.service.judge(twoQuestions);
	assert.equal(result.stopReason, "stop");
	assert.equal(calls, 2);
	assert.deepEqual(seenReasoning, [undefined, undefined]); // off frozen at start
	// A later request picks up the mutated level (identity misses).
	seenReasoning = [];
	h.registry.replayLlm([boolToolMessage(true), boolToolMessage(true)]);
	await h.service.judge(twoQuestions);
	assert.deepEqual(seenReasoning, ["high", "high"]);
	h.registry.streamSimple = original;
});

test("auto-llm prefers the configured LLM without native discovery", async () => {
	const h = harness({ mode: "auto-llm" });
	h.registry.authKeys.set("fake", "test-key");
	h.registry.getAvailableOfType = async () => {
		throw new Error("unused native discovery must not run");
	};
	h.registry.replayLlm([boolToolMessage(true)]);
	const result = await h.service.judge(BOOL_REQ);
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
	assert.equal(result.backend, "llm");
	assert.equal(result.model, "fake/fake-model");
	assert.equal(h.registry.llmCalls.length, 1);
});

test("forced classifier dispatch failure never falls back to the LLM", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.replayJev([]);
	h.registry.replayLlm([boolToolMessage(true)]);
	h.registry.classify = (async () => {
		throw new Error("synthetic native transport failure");
	}) as typeof h.registry.classify;
	const result = await h.service.judge(BOOL_REQ);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /synthetic native transport failure/);
	assert.equal(h.registry.llmCalls.length, 0); // no LLM substitution
});

test("auto native dispatch failure permits exactly one LLM attempt", async () => {
	const h = harness({ mode: "auto" });
	h.registry.available = [jevModel(), { ...jevModel(), id: "jev-other" }];
	const nativeCalls: string[] = [];
	h.registry.classify = (async (model) => {
		nativeCalls.push(model.id);
		throw new Error("synthetic native transport failure");
	}) as typeof h.registry.classify;
	h.registry.replayLlm([boolToolMessage(false)]);
	const result = await h.service.judge(BOOL_REQ);
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
	assert.equal(result.backend, "llm");
	assert.equal(result.model, "fake/fake-model");
	assert.equal(asBool(result.answers.q).probability, 0); // valid false
	assert.equal(result.errorMessage, undefined); // no stale primary error
	assert.equal(nativeCalls.length, 1); // no other native model substituted
	assert.equal(h.registry.llmCalls.length, 1);
});

test("discovery sync throw resolves structured error, never rejects", async () => {
	const h = harness({ mode: "auto" });
	h.registry.available = [jevModel()];
	const original = h.registry.getAvailableOfType.bind(h.registry);
	h.registry.getAvailableOfType = (() => {
		throw new Error("registry exploded");
	}) as unknown as typeof h.registry.getAvailableOfType;
	const result = await h.service.judge(BOOL_REQ);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /discovery failed/);
	h.registry.getAvailableOfType = original;
});

test("discovery async rejection resolves structured error, never rejects", async () => {
	const h = harness({ mode: "auto" });
	h.registry.available = [jevModel()];
	const original = h.registry.getAvailableOfType.bind(h.registry);
	h.registry.getAvailableOfType = (async () => {
		throw new Error("auth store down");
	}) as unknown as typeof h.registry.getAvailableOfType;
	const result = await h.service.judge(BOOL_REQ);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /discovery failed/);
	h.registry.getAvailableOfType = original;
});

test("hanging discovery is bounded by the caller deadline", async () => {
	const h = harness({ mode: "auto" });
	h.registry.available = [jevModel()];
	const original = h.registry.getAvailableOfType.bind(h.registry);
	h.registry.getAvailableOfType = (() =>
		new Promise<readonly AnyClassifierModel[]>(() => {
			/* never settles */
		})) as typeof h.registry.getAvailableOfType;
	const result = await h.service.judge(BOOL_REQ, { timeoutMs: 80 });
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /selection timed out after 80ms/);
	assert.deepEqual(result.answers, {});
	h.registry.getAvailableOfType = original;
});

test("caller abort during hanging discovery resolves aborted", async () => {
	const h = harness({ mode: "auto" });
	h.registry.available = [jevModel()];
	const original = h.registry.getAvailableOfType.bind(h.registry);
	h.registry.getAvailableOfType = (() =>
		new Promise<readonly AnyClassifierModel[]>(() => {
			/* never settles */
		})) as typeof h.registry.getAvailableOfType;
	const controller = new AbortController();
	const promise = h.service.judge(BOOL_REQ, { signal: controller.signal });
	await new Promise((r) => setTimeout(r, 10));
	controller.abort();
	const result = await promise;
	assert.equal(result.stopReason, "aborted");
	h.registry.getAvailableOfType = original;
});

test("recursive fragment splits preserve original bounds and ALL caller metadata", async () => {
	// Direct pipeline-seam proof first: a record that already carries caller
	// metadata.fragment must not lose it, and recursive splits must keep
	// absolute source bounds.
	const { FRAGMENT_MIN_CHARS, splitPiece } = await import("../src/pipeline.ts");
	// ~4x the minimum so subdivision recurses at least once.
	const text =
		"𝕏".repeat(FRAGMENT_MIN_CHARS * 2) + "b".repeat(FRAGMENT_MIN_CHARS * 2);
	const callerMetadata = {
		tags: ["primary"],
		origin: "caller",
		fragment: { note: "caller-owned marker", seq: 7 },
	};
	const record = { id: "src-1", text, metadata: callerMetadata };
	let pieces: import("../src/pipeline.ts").FramedEvidence[][] = [[{ record }]];
	// Recursively split single-record pieces down to irreducible fragments.
	let depth = 0;
	while (depth < 12) {
		depth += 1;
		const next: typeof pieces = [];
		let split = false;
		for (const piece of pieces) {
			const halves = splitPiece(piece);
			if (halves && piece.length === 1) {
				next.push(halves[0], halves[1]);
				split = true;
			} else {
				next.push(piece);
			}
		}
		pieces = next;
		if (!split) break;
	}
	const fragments = pieces.flat();
	assert.ok(
		fragments.length >= 4,
		`expected deep fragments, got ${fragments.length}`,
	);
	// Caller metadata survives on EVERY fragment, including metadata.fragment.
	for (const fragment of fragments) {
		const meta = fragment.record.metadata as Record<string, unknown>;
		assert.deepEqual(meta.tags, ["primary"]);
		assert.equal(meta.origin, "caller");
		assert.deepEqual(meta.fragment, {
			note: "caller-owned marker",
			seq: 7,
		});
	}
	// Text is complete and in order.
	assert.equal(fragments.map((f) => f.record.text).join(""), text);
	// Recovery bounds live in the frame, OUTSIDE caller metadata, absolute.
	const bounds = fragments.map((f) => f.bounds);
	for (const b of bounds) {
		assert.ok(b, "missing internal bounds");
		assert.equal(b!.of, "src-1");
		assert.equal(b!.total, text.length);
	}
	assert.equal(bounds[0]!.start, 0);
	assert.equal(bounds.at(-1)!.end, text.length);
	for (let i = 1; i < bounds.length; i++) {
		assert.equal(bounds[i]!.start, bounds[i - 1]!.end);
	}
	// Every fragment is well-formed; lone surrogates make encoding fail.
	for (const f of fragments) {
		assert.doesNotThrow(() => encodeURIComponent(f.record.text));
	}
});

test("service-level fragmentation preserves caller metadata through stages", async () => {
	const h = harness();
	h.registry.llmContextWindow = 8000;
	const text = "🚀data ".repeat(1400);
	h.registry.replayLlm([
		boolToolMessage(true),
		boolToolMessage(true),
		boolToolMessage(true),
		boolToolMessage(true),
	]);
	const result = await h.service.judge({
		state: { fixed: 1 },
		questions: {
			q: {
				type: "bool",
				instructions: "read all evidence",
				criteria: { true: "y", false: "n" },
			},
		},
		evidence: [
			{ id: "big", text, metadata: { fragment: { caller: true }, keep: "me" } },
		],
	});
	assert.equal(result.stopReason, "stop");
	// Every dispatched stage kept the caller metadata verbatim.
	for (const call of h.registry.llmCalls) {
		const payload = JSON.parse(call.userContent);
		const evidence = payload.state.evidence as {
			metadata?: Record<string, unknown>;
		}[];
		for (const record of evidence) {
			assert.deepEqual(record.metadata?.fragment, { caller: true });
			assert.equal(record.metadata?.keep, "me");
		}
	}
});

test("selected native model switch causes a cache miss and new identity", async () => {
	const h = harness({ mode: "auto" });
	h.registry.available = [jevModel(), nativeModel()];
	h.registry.replayJev([
		jevResult({ q: { type: "bool", probability: 0.9 } }),
		jevResult({ q: { type: "bool", probability: 0.4 } }, "typesafe/kev-2.1"),
	]);
	const first = await h.service.judge(BOOL_REQ);
	assert.equal(first.model, "typesafe/jev-1.13");
	// Switch the explicit selection to another available native model.
	h.config.classifierModel = "typesafe/kev-2.1";
	h.config.classifierProvider = "typesafe";
	h.config.classifierModelId = "kev-2.1";
	const second = await h.service.judge(BOOL_REQ);
	assert.equal(second.model, "typesafe/kev-2.1");
	assert.equal(second.reuse.sent, 1); // miss: no reuse of the Jev judgment
	assert.equal(second.reuse.hits, 0);
	assert.equal(second.answers.q?.type, "bool");
	const judgments = h.ledgerRecords.filter((r) => r.kind === "judgment");
	assert.equal(judgments.length, 2);
	assert.equal(
		judgments[0].kind === "judgment" ? judgments[0].model : "",
		"typesafe/jev-1.13",
	);
	assert.equal(
		judgments[1].kind === "judgment" ? judgments[1].model : "",
		"typesafe/kev-2.1",
	);
});

test("old jev-tagged ledger entries are stale and ignored on restore", async () => {
	const h = harness({ mode: "auto" });
	h.registry.available = [jevModel()];
	// Produce one valid classifier-tagged judgment.
	h.registry.replayJev([
		jevResult({ q: { type: "bool", probability: 0.9 } }),
		jevResult({ q: { type: "bool", probability: 0.2 } }),
	]);
	await h.service.judge(BOOL_REQ);
	const live = h.ledgerRecords.filter((r) => r.kind === "judgment");
	assert.equal(live.length, 1);
	// Forge a legacy prototype entry: same answer fields but backend "jev".
	const legacyEntry = {
		type: "custom",
		customType: "llm-as-jev-ledger",
		data: { ...live[0], backend: "jev" },
	};
	// Simulate a branch that contains ONLY the legacy-tagged entry.
	const legacyOnly = harness({ mode: "auto" });
	legacyOnly.registry.available = [jevModel()];
	legacyOnly.registry.replayJev([
		jevResult({ q: { type: "bool", probability: 0.5 } }),
	]);
	legacyOnly.branchEntries.push(legacyEntry);
	legacyOnly.service.refreshBranch();
	const restored = await legacyOnly.service.judge(BOOL_REQ);
	// The stale jev-tagged judgment is NOT reused: a fresh dispatch happened.
	assert.equal(restored.reuse.sent, 1);
	assert.equal(restored.reuse.hits, 0);
	assert.equal(restored.answers.q?.type, "bool");
	// And the legacy entry was not rewritten to the new tag.
	const again = legacyOnly.branchEntries.filter(
		(e) => (e as { type?: string }).type === "custom",
	);
	assert.equal(again.length, 1);
	assert.equal(
		(again[0] as { data?: { backend?: string } }).data?.backend,
		"jev",
	);
});

test("arbitrary own JSON ids/labels survive cache, policy and ledger", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	const special = "__proto__";
	h.registry.replayJev([
		jevResult({
			[special]: {
				type: "choice",
				choice: special,
				probabilities: { [special]: 0.9, safe: 0.1 },
				confidence: 0.85,
			},
		}),
		jevResult(
			{
				[special]: {
					type: "choice",
					choice: special,
					probabilities: { [special]: 0.9, safe: 0.1 },
					confidence: 0.85,
				},
			},
			"typesafe/jev-1.13",
		),
	]);
	const req: JudgeRequest = {
		state: { s: 1 },
		questions: {
			[special]: {
				type: "choice",
				instructions: "?",
				criteria: { [special]: "sp", safe: "sf" },
			},
		},
	};
	const first = await h.service.judge(req, { minConfidence: 0.8 });
	assert.equal(first.stopReason, "stop");
	const answer = first.answers[special];
	assert.ok(answer);
	assert.equal(answer.type, "choice");
	assert.equal(
		Object.hasOwn(answer as never as Record<string, unknown>, "type"),
		true,
	);
	// Stricter caller drops it without re-sending.
	const strict = await h.service.judge(req, { minConfidence: 0.9 });
	assert.deepEqual(strict.dropped, [special]);
	assert.equal(h.registry.jevCalls.length, 1);
	// Ledger record retains the special id under its own key digest.
	const judgments = h.ledgerRecords.filter((r) => r.kind === "judgment");
	assert.equal(judgments.length, 1);
});

// ---------------------------------------------------------------------------
// Evidence metadata total preservation + internal bounds OUTSIDE caller
// metadata (parent repro follow-up)
// ---------------------------------------------------------------------------

test("caller metadata with the same-named internal key is never touched and bounds are not inferred from it", async () => {
	const h = harness();
	h.registry.llmContextWindow = 8000;
	// Exactly the parent repro shape: a caller-supplied key that collides
	// with any reserved internal name, carrying forged-looking bounds.
	const text = "x".repeat(16000);
	const forged = {
		__llmAsJevFragment: {
			of: "caller-marker",
			start: 50,
			end: 4050,
			total: 9000,
		},
		fragment: { of: "caller-marker", start: 50, end: 4050, total: 9000 },
		keep: "caller-data",
	};
	h.registry.replayLlm([
		boolToolMessage(true),
		boolToolMessage(true),
		boolToolMessage(true),
		boolToolMessage(true),
		boolToolMessage(true),
		boolToolMessage(true),
	]);
	const result = await h.service.judge({
		state: { fixed: 1 },
		questions: {
			q: {
				type: "bool",
				instructions: "read all evidence",
				criteria: { true: "y", false: "n" },
			},
		},
		evidence: [{ id: "actual-source", text, metadata: forged }],
	});
	assert.equal(result.stopReason, "stop");
	assert.ok(h.registry.llmCalls.length >= 2, "expected fragmentation");
	const seen: {
		id: string;
		metadata: Record<string, unknown>;
		bounds: unknown;
	}[] = [];
	for (const call of h.registry.llmCalls) {
		const payload = JSON.parse(call.userContent);
		const evidence = payload.state.evidence as {
			id: string;
			metadata?: Record<string, unknown>;
			fragmentBounds?: unknown;
		}[];
		for (const record of evidence) {
			seen.push({
				id: record.id,
				metadata: record.metadata ?? {},
				bounds: record.fragmentBounds,
			});
		}
	}
	// Caller metadata is preserved VERBATIM on every dispatched fragment —
	// including the colliding and forged keys, byte-for-byte.
	for (const s of seen) {
		assert.deepEqual(s.metadata.__llmAsJevFragment, {
			of: "caller-marker",
			start: 50,
			end: 4050,
			total: 9000,
		});
		assert.deepEqual(s.metadata.fragment, {
			of: "caller-marker",
			start: 50,
			end: 4050,
			total: 9000,
		});
		assert.equal(s.metadata.keep, "caller-data");
	}
	// Genuine recovery bounds live OUTSIDE metadata, in a separate
	// model-facing field, and describe the ACTUAL source, not the forgery.
	const bounded = seen.filter((s) => s.bounds !== undefined);
	assert.ok(bounded.length >= 2, "expected bounded fragments");
	for (const s of bounded) {
		const b = s.bounds as {
			of: string;
			start: number;
			end: number;
			total: number;
		};
		assert.equal(b.of, "actual-source"); // never "caller-marker"
		assert.equal(b.total, 16000); // actual text length, not 9000
		assert.ok(b.start >= 0 && b.end <= 16000 && b.start < b.end);
	}
	// Contiguous absolute coverage [0, total) across dispatched fragments.
	const sorted = bounded
		.map((s) => s.bounds as { start: number; end: number })
		.sort((a, b) => a.start - b.start);
	assert.equal(sorted[0].start, 0);
	for (let i = 1; i < sorted.length; i++)
		assert.equal(sorted[i].start, sorted[i - 1].end);
	const last = sorted.at(-1)!;
	assert.equal(last.end, 16000);
	// Every fragment text is a slice of the ORIGINAL text.
	for (const call of h.registry.llmCalls) {
		const payload = JSON.parse(call.userContent);
		for (const record of payload.state.evidence as { text: string }[]) {
			assert.ok(text.includes(record.text) || record.text.length === 0);
		}
	}
});

test("forged bounds in caller metadata cannot hijack fragment ids", async () => {
	// Direct pipeline-seam proof: splitPiece-level forged metadata must not
	// influence ids, bounds, or text attribution.
	const { frameEvidence, splitPiece } = await import("../src/pipeline.ts");
	const text = "y".repeat(4000);
	const record = {
		id: "real",
		text,
		metadata: {
			__llmAsJevFragment: { of: "fake", start: 1, end: 2, total: 3 },
			fragment: { of: "fake", start: 1, end: 2, total: 3 },
		},
	};
	const halves = splitPiece(frameEvidence([record]));
	assert.ok(halves);
	type Frame = {
		record: { id: string; text: string; metadata?: Record<string, unknown> };
		bounds?: { of: string; start: number; end: number; total: number };
	};
	const walk = (pieces: unknown[]): Frame[] =>
		pieces.map((piece) => piece as Frame);
	const all = [...walk(halves![0]), ...walk(halves![1])];
	for (const f of all) {
		// Ids derive from the REAL source id, not the forged `of`.
		assert.ok(f.record.id.startsWith("real#") || f.record.id === "real");
		// Caller metadata survives untouched, including the same-named key.
		assert.deepEqual(f.record.metadata?.__llmAsJevFragment, {
			of: "fake",
			start: 1,
			end: 2,
			total: 3,
		});
		assert.deepEqual(f.record.metadata?.fragment, {
			of: "fake",
			start: 1,
			end: 2,
			total: 3,
		});
		// Genuine bounds (frame field, not metadata) describe the real record.
		assert.ok(f.bounds);
		assert.equal(f.bounds.of, "real");
		assert.equal(f.bounds.total, 4000);
	}
	// Recursive split keeps original bounds absolute and metadata untouched.
	const deeper = splitPiece(halves![0]);
	if (deeper) {
		for (const half of deeper) {
			for (const f of walk(half)) {
				assert.ok(f.bounds);
				assert.equal(f.bounds.of, "real");
				assert.equal(f.bounds.total, 4000);
				assert.ok(f.bounds.start >= 0 && f.bounds.end <= 4000);
				assert.deepEqual(f.record.metadata?.__llmAsJevFragment, {
					of: "fake",
					start: 1,
					end: 2,
					total: 3,
				});
			}
		}
	}
});

test("complete final stage only; special own JSON keys through cache and stages", async () => {
	const h = harness();
	h.registry.llmContextWindow = 8000;
	const special = "__proto__";
	const text = "z".repeat(4000);
	h.registry.replayLlm([choiceToolMessage(special)]);
	const result = await h.service.judge({
		state: { fixed: 1 },
		questions: {
			[special]: {
				type: "choice",
				instructions: "?",
				criteria: { [special]: "sp", safe: "sf" },
			},
		},
		evidence: [{ id: special, text, metadata: { [special]: "own" } }],
	});
	assert.equal(result.stopReason, "stop");
	// Only the COMPLETE final stage is returned (single question, one answer).
	assert.ok(result.answers[special]);
	// Special id survived as own key in dispatched evidence.
	for (const call of h.registry.llmCalls) {
		const payload = JSON.parse(call.userContent);
		for (const record of payload.state.evidence as {
			id: string;
			metadata?: Record<string, unknown>;
		}[]) {
			if (record.id.includes("#")) continue; // fragments have suffixed ids
			assert.equal(record.id, special);
			assert.equal(record.metadata?.[special], "own");
			assert.ok(Object.hasOwn(record.metadata ?? {}, special));
		}
	}
	// Re-judging the same request is a full cache hit (stage reuse).
	const again = await h.service.judge({
		state: { fixed: 1 },
		questions: {
			[special]: {
				type: "choice",
				instructions: "?",
				criteria: { [special]: "sp", safe: "sf" },
			},
		},
		evidence: [{ id: special, text, metadata: { [special]: "own" } }],
	});
	assert.equal(again.stopReason, "stop");
	assert.equal(again.reuse.sent, 0);
	assert.equal(again.reuse.hits, 1);
});

// ---------------------------------------------------------------------------
// F1/F2/F5/F10 review repairs: native answer admission, whole-call liveness
// boundary, selected-provider redaction, usable-availability.
// ---------------------------------------------------------------------------

/** Minimal hand-rolled registry for liveness probes (uncooperative hosts). */
function probeRegistry(
	overrides: Partial<ServiceRegistry> = {},
): ServiceRegistry {
	const jev = jevModel();
	return {
		getProviders: () => [],
		getAuth: async () => undefined,
		getModel: () => undefined,
		getAvailableOfType: async () => [jev],
		classify: async () => {
			throw new Error("no scripted result");
		},
		streamSimple: () => {
			throw new Error("no scripted llm");
		},
		...overrides,
	} as ServiceRegistry;
}

function classifierConfig(): JudgmentConfig {
	return {
		mode: "classifier",
		thinkingLevel: "off",
		timeoutMs: 5000,
		classifierModel: "typesafe/jev-1.13",
		classifierProvider: "typesafe",
		classifierModelId: "jev-1.13",
	};
}

const BOOL_Q = {
	type: "bool" as const,
	instructions: "?",
	criteria: { true: "y", false: "n" },
};

// --- F2: native answer admission -----------------------------------------

test("F2: malformed native fields rejected, not cached/persisted/dropped", async () => {
	const h = harness(classifierConfig());
	h.registry.available = [jevModel()];
	h.registry.replayJev([
		{
			...jevResult({}),
			answers: {
				q: { type: "bool", probability: 7, extra: "raw-provider-note" },
			} as never,
		},
	]);
	const r = await h.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ minConfidence: 0.99 },
	);
	assert.equal(r.stopReason, "error");
	assert.deepEqual(r.answers, {});
	// No judgment persisted; no provider extras in ledger.
	const judgments = h.ledgerRecords.filter((x) => x.kind === "judgment");
	assert.equal(judgments.length, 0);
	assert.ok(!JSON.stringify(h.ledgerRecords).includes("raw-provider-note"));
});

test("F2: missing answer for special id yields error, never inherited constructor", async () => {
	const h = harness(classifierConfig());
	h.registry.available = [jevModel()];
	h.registry.replayJev([{ ...jevResult({}), answers: {} as never }]);
	const r = await h.service.judge({
		state: {},
		questions: { constructor: BOOL_Q },
	});
	assert.equal(r.stopReason, "error");
	assert.equal(Object.hasOwn(r.answers, "constructor"), false);
	assert.deepEqual(r.answers, {});
});

test("F2: wrong type/label/score rejected; legal own keys survive", async () => {
	const h = harness(classifierConfig());
	h.registry.available = [jevModel()];
	h.registry.replayJev([
		{
			...jevResult({}),
			answers: {
				// Wrong type for a bool question.
				q: { type: "choice", choice: "x", probabilities: {}, confidence: 1 },
			} as never,
		},
	]);
	const wrongType = await h.service.judge({
		state: {},
		questions: { q: BOOL_Q },
	});
	assert.equal(wrongType.stopReason, "error");

	// Unknown choice label rejected.
	h.registry.replayJev([
		{
			...jevResult({}),
			answers: {
				c: {
					type: "choice",
					choice: "nope",
					probabilities: { nope: 1 },
					confidence: 1,
				},
			} as never,
		},
	]);
	const badLabel = await h.service.judge({
		state: {},
		questions: {
			c: { type: "choice", instructions: "?", criteria: { ok: "y", bad: "n" } },
		},
	});
	assert.equal(badLabel.stopReason, "error");

	// Out-of-range score rejected.
	h.registry.replayJev([
		{
			...jevResult({}),
			answers: { s: { type: "score", score: 9, confidence: 1 } } as never,
		},
	]);
	const badScore = await h.service.judge({
		state: {},
		questions: {
			s: { type: "score", instructions: "?", criteria: ["a", "b", "c"] },
		},
	});
	assert.equal(badScore.stopReason, "error");

	// Missing probabilities on a choice answer rejected.
	h.registry.replayJev([
		{
			...jevResult({}),
			answers: {
				c: { type: "choice", choice: "ok", confidence: 1 } as never,
			} as never,
		},
	]);
	const noProbs = await h.service.judge({
		state: {},
		questions: {
			c: { type: "choice", instructions: "?", criteria: { ok: "y", bad: "n" } },
		},
	});
	assert.equal(noProbs.stopReason, "error");

	// Legal own special key still works end to end. Object literals cannot
	// carry `__proto__` as an own key; build with defineProperty.
	const specialAnswers: Record<string, unknown> = {};
	Object.defineProperty(specialAnswers, "__proto__", {
		value: {
			type: "choice",
			choice: "__proto__",
			probabilities: (() => {
				const probabilities: Record<string, number> = {};
				Object.defineProperty(probabilities, "__proto__", {
					value: 0.9,
					enumerable: true,
					writable: true,
					configurable: true,
				});
				probabilities.safe = 0.1;
				return probabilities;
			})(),
			confidence: 0.9,
		},
		enumerable: true,
		writable: true,
		configurable: true,
	});
	h.registry.replayJev([
		{
			...jevResult({}),
			answers: specialAnswers as never,
		},
	]);
	const specialQuestions: Record<string, unknown> = {};
	Object.defineProperty(specialQuestions, "__proto__", {
		value: {
			type: "choice",
			instructions: "?",
			criteria: (() => {
				const criteria: Record<string, string> = {};
				Object.defineProperty(criteria, "__proto__", {
					value: "sp",
					enumerable: true,
					writable: true,
					configurable: true,
				});
				criteria.safe = "sf";
				return criteria;
			})(),
		},
		enumerable: true,
		writable: true,
		configurable: true,
	});
	const special = await h.service.judge({
		state: {},
		questions: specialQuestions as never,
	});
	assert.equal(special.stopReason, "stop");
	assert.ok(Object.hasOwn(special.answers, "__proto__"));
});

test("slow native auth and rotated keys are redacted before dispatch", async () => {
	const h = harness({ mode: "classifier", timeoutMs: 500 });
	h.registry.available = [jevModel()];
	let key = "synthetic-rotating-key-A";
	h.registry.getAuth = async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
		return { auth: { apiKey: key } };
	};
	const seen: string[] = [];
	h.registry.classify = (async (_model, context) => {
		seen.push(JSON.stringify(context));
		throw new Error(`refused ${key}`);
	}) as typeof h.registry.classify;
	for (const next of ["synthetic-rotating-key-A", "synthetic-rotating-key-B"]) {
		key = next;
		const result = await h.service.judge({
			state: { token: key },
			questions: { q: BOOL_Q },
		});
		assert.equal(result.stopReason, "error");
		assert.equal(seen.at(-1)?.includes(key), false);
		assert.equal(result.errorMessage?.includes(key), false);
		assert.ok(result.errorMessage?.includes("[REDACTED]"));
	}
});

test("native fractional scores retain the adapter's reported value", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.replayJev([
		jevResult({ q: { type: "score", score: 0.75, confidence: 0.8 } }),
	]);
	const request: JudgeRequest = {
		state: {},
		questions: {
			q: { type: "score", instructions: "rate", criteria: ["low", "high"] },
		},
	};
	const first = await h.service.judge(request, { minConfidence: 0.7 });
	assert.equal(first.stopReason, "stop");
	assert.deepEqual(first.answers.q, {
		type: "score",
		score: 0.75,
		confidence: 0.8,
	});
	const stricter = await h.service.judge(request, { minConfidence: 0.9 });
	assert.equal(stricter.reuse.hits, 1);
	assert.deepEqual(stricter.answers, {});
	assert.deepEqual(stricter.dropped, ["q"]);
});

test("F2: sanitized contract-shaped answers strip provider extras", async () => {
	const h = harness(classifierConfig());
	h.registry.available = [jevModel()];
	h.registry.replayJev([
		{
			...jevResult({}),
			answers: {
				q: { type: "bool", probability: 0.9, providerExtra: { deep: "x" } },
			} as never,
		},
	]);
	const r = await h.service.judge({ state: {}, questions: { q: BOOL_Q } });
	assert.equal(r.stopReason, "stop");
	assert.deepEqual(Object.keys(r.answers.q as object), ["type", "probability"]);
	// Ledger record carries the sanitized shape only.
	const judgments = h.ledgerRecords.filter((x) => x.kind === "judgment");
	assert.equal(judgments.length, 1);
	assert.ok(!JSON.stringify(judgments).includes("providerExtra"));
});

test("F2: restored raw answers revalidated against current question", async () => {
	const h = harness(classifierConfig());
	h.registry.available = [jevModel()];
	// Persist a valid judgment first.
	h.registry.replayJev([jevResult({ q: { type: "bool", probability: 0.9 } })]);
	const first = await h.service.judge({ state: {}, questions: { q: BOOL_Q } });
	assert.equal(first.stopReason, "stop");
	// Forge a ledger restore whose answer no longer matches the question type.
	const poisoned = harness(classifierConfig());
	poisoned.registry.available = [jevModel()];
	poisoned.registry.replayJev([
		jevResult({ q: { type: "bool", probability: 0.5 } }),
	]);
	poisoned.branchEntries.push(
		...h.ledgerRecords.map((data) => ({
			type: "custom",
			customType: LEDGER_TYPE,
			data,
		})),
	);
	// The restored key matches the ORIGINAL question; a changed question
	// definition misses. Instead poison with a mismatched answer under a
	// matching key by reusing the same request but a corrupted branch entry.
	const key = h.ledgerRecords.filter(
		(x): x is Extract<LedgerRecord, { kind: "judgment" }> =>
			x.kind === "judgment",
	)[0];
	poisoned.branchEntries.length = 0;
	poisoned.branchEntries.push({
		type: "custom",
		customType: LEDGER_TYPE,
		data: {
			kind: "judgment",
			key: key.key,
			answer: { type: "score", score: 42, confidence: 1 },
			backend: "classifier",
			model: "typesafe/jev-1.13",
			thinkingLevel: "none",
		},
	});
	poisoned.service.refreshBranch();
	const r = await poisoned.service.judge({
		state: {},
		questions: { q: BOOL_Q },
	});
	// The corrupted restored answer is NOT used: fresh dispatch happened.
	assert.equal(r.reuse.sent, 1);
	assert.equal(r.reuse.hits, 0);
});

// --- F5: whole-call liveness boundary ------------------------------------

test("F5: hung auth cannot hold an already-aborted short-deadline call", async () => {
	const registry = probeRegistry({
		getProviders: () => [{ id: "hung" }],
		getAuth: () => new Promise(() => {}),
	});
	const config = classifierConfig();
	const ledgerRecords: LedgerRecord[] = [];
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: { append: (_t, d) => ledgerRecords.push(d), branch: () => [] },
	});
	const controller = new AbortController();
	controller.abort();
	const settled = await Promise.race([
		service
			.judge(
				{ state: {}, questions: { q: BOOL_Q } },
				{ timeoutMs: 10, signal: controller.signal },
			)
			.then((r) => ({ stopReason: r.stopReason })),
		new Promise((r) => setTimeout(() => r({ stillPendingAfterMs: 70 }), 70)),
	]);
	assert.ok(!("stillPendingAfterMs" in (settled as object)));
	assert.equal((settled as { stopReason: string }).stopReason, "aborted");
});

test("F5: configured timeoutMs applies when caller omits override", async () => {
	const registry = probeRegistry({ classify: () => new Promise(() => {}) });
	const config = { ...classifierConfig(), timeoutMs: 25 };
	const ledgerRecords: LedgerRecord[] = [];
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: { append: (_t, d) => ledgerRecords.push(d), branch: () => [] },
	});
	const settled = await Promise.race([
		service
			.judge({ state: {}, questions: { q: BOOL_Q } })
			.then((r) => ({ stopReason: r.stopReason, err: r.errorMessage })),
		new Promise((r) => setTimeout(() => r({ stillPendingAfterMs: 80 }), 80)),
	]);
	assert.ok(!("stillPendingAfterMs" in (settled as object)));
	assert.equal((settled as { stopReason: string }).stopReason, "error");
	assert.match(
		(settled as { err?: string }).err ?? "",
		/timed out after 2\dms/,
	);
});

test("F5: joined caller settles under its own deadline and abort", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let calls = 0;
	const registry = probeRegistry({
		classify: async () => {
			calls += 1;
			await gate;
			return jevResult({ q: { type: "bool", probability: 0.9 } });
		},
	});
	const config = classifierConfig();
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: { append: undefined, branch: () => [] },
	});
	const req = { state: {}, questions: { q: BOOL_Q } };
	const first = service.judge(req);
	await new Promise((r) => setTimeout(r, 5));
	const controller = new AbortController();
	const joined = service.judge(req, {
		timeoutMs: 10,
		signal: controller.signal,
	});
	await new Promise((r) => setTimeout(r, 5));
	controller.abort();
	const early = await Promise.race([
		joined.then((r) => ({ settled: r.stopReason, answers: r.answers })),
		new Promise((r) => setTimeout(() => r({ stillPending: true }), 50)),
	]);
	assert.ok(!("stillPending" in (early as object)));
	// Deadline (10ms) fires before the abort (15ms): either structured
	// outcome is correct; the caller must settle with empty answers.
	const settledEarly = early as { settled: string; answers: unknown };
	assert.ok(
		settledEarly.settled === "aborted" || settledEarly.settled === "error",
	);
	assert.deepEqual(settledEarly.answers, {});
	release?.();
	const owner = await first;
	assert.equal(owner.stopReason, "stop");
	assert.equal(calls, 1); // the owner's request was never duplicated/canceled
});

test("F5: cyclic evidence metadata resolves structured error, never rejects", async () => {
	const h = harness();
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	let observed: unknown;
	try {
		observed = await h.service.judge({
			state: {},
			questions: { q: BOOL_Q },
			evidence: [{ id: "a", text: "a", metadata: cyclic as never }],
		});
	} catch (error) {
		observed = { rejected: String(error) };
	}
	assert.ok(!("rejected" in (observed as object)));
	assert.equal((observed as JudgeResult).stopReason, "error");
});

test("F5: fractional timeout resolves structured error, never rejects", async () => {
	const registry = probeRegistry({
		getModel: () => chatModel(),
		streamSimple: () => ({
			result: async () =>
				({
					...llmMessage([toolCall({ value: true })]),
				}) as AssistantMessage,
		}),
	});
	const config: JudgmentConfig = {
		mode: "llm",
		thinkingLevel: "off",
		timeoutMs: 5000,
		model: "fake/fake-model",
		provider: "fake",
		modelId: "fake-model",
	};
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: { append: undefined, branch: () => [] },
	});
	let observed: unknown;
	try {
		observed = await service.judge(
			{ state: {}, questions: { q: BOOL_Q } },
			{ timeoutMs: 100.5 },
		);
	} catch (error) {
		observed = { rejected: String(error) };
	}
	assert.ok(!("rejected" in (observed as object)));
	assert.equal((observed as JudgeResult).stopReason, "error");
	assert.match((observed as JudgeResult).errorMessage ?? "", /timeoutMs/);
});

test("F5: non-integer / nonfinite / zero timeouts are invalid, not crashy", async () => {
	const h = harness();
	for (const bad of [0, -5, Number.POSITIVE_INFINITY, Number.NaN]) {
		const r = await h.service.judge(
			{ state: {}, questions: { q: BOOL_Q } },
			{ timeoutMs: bad },
		);
		assert.equal(r.stopReason, "error", `timeoutMs=${bad}`);
	}
});

test("F5: aborted outcomes carry a safe diagnostic message", async () => {
	const h = harness();
	const controller = new AbortController();
	controller.abort(); // pre-aborted: resolves aborted WITH a message
	const r = await h.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ signal: controller.signal },
	);
	assert.equal(r.stopReason, "aborted");
	assert.ok(typeof r.errorMessage === "string" && r.errorMessage.length > 0);

	// Mid-flight abort also resolves aborted with a safe message and no answers.
	let release: (() => void) | undefined;
	const gate = new Promise<void>((res) => {
		release = res;
	});
	const h2 = harness({ mode: "classifier" });
	h2.registry.available = [jevModel()];
	h2.registry.classify = (async () => {
		await gate;
		return jevResult({ q: { type: "bool", probability: 0.9 } });
	}) as typeof h2.registry.classify;
	const controller2 = new AbortController();
	const pending = h2.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ signal: controller2.signal },
	);
	await new Promise((r2) => setTimeout(r2, 5));
	controller2.abort();
	const r2 = await pending;
	release?.();
	assert.equal(r2.stopReason, "aborted");
	assert.deepEqual(r2.answers, {});
	assert.ok(typeof r2.errorMessage === "string" && r2.errorMessage.length > 0);
});

// --- F1: selected-provider redaction --------------------------------------

test("F1: selected native provider key resolved and redacted even when not in getProviders", async () => {
	const jev = jevModel();
	const asked: string[] = [];
	const KEY = "synthetic-fixture-key-only";
	let payload: unknown;
	const registry = probeRegistry({
		getProviders: () => [], // chat-only inventory omits the native provider
		getAuth: async (providerId) => {
			asked.push(providerId);
			return providerId === "typesafe" ? { auth: { apiKey: KEY } } : undefined;
		},
		getModel: () => chatModel(),
		classify: async (_m, context) => {
			payload = context;
			return {
				...jevResult({}),
				stopReason: "error",
				errorMessage: "provider refused synthetic-fixture-key-only",
			};
		},
	});
	const config = classifierConfig();
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: { append: undefined, branch: () => [] },
	});
	const r = await service.judge({
		state: { note: "synthetic-fixture-key-only" },
		questions: { q: BOOL_Q },
	});
	assert.ok(asked.includes("typesafe"), `auth asked: ${asked.join(",")}`);
	assert.ok(
		!JSON.stringify(payload).includes(KEY),
		"key reached the backend payload",
	);
	assert.ok(!r.errorMessage?.includes(KEY), "key leaked in returned error");
});

test("F1: selected chat provider key redacted on llm path", async () => {
	const KEY = "chat-secret-key";
	const asked: string[] = [];
	let payload: unknown;
	const registry = probeRegistry({
		getProviders: () => [],
		getAuth: async (providerId) => {
			asked.push(providerId);
			return providerId === "fake" ? { auth: { apiKey: KEY } } : undefined;
		},
		getModel: () => chatModel(),
		streamSimple: (_m, context) => {
			payload = context;
			return {
				result: async () =>
					({
						...llmMessage([]),
						stopReason: "error",
						errorMessage: "stream failed with chat-secret-key",
					}) as AssistantMessage,
			};
		},
	});
	const config: JudgmentConfig = {
		mode: "llm",
		thinkingLevel: "off",
		timeoutMs: 5000,
		model: "fake/fake-model",
		provider: "fake",
		modelId: "fake-model",
	};
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: { append: undefined, branch: () => [] },
	});
	const r = await service.judge({
		state: { note: "chat-secret-key" },
		questions: { q: BOOL_Q },
	});
	assert.ok(asked.includes("fake"));
	assert.ok(!JSON.stringify(payload).includes(KEY));
	assert.ok(!r.errorMessage?.includes(KEY));
});

// --- F10: usable availability ---------------------------------------------

test("F10: uncredentialed configured chat is not available", async () => {
	const registry = probeRegistry({
		getModel: () => chatModel(), // catalog existence only
		getAuth: async () => undefined, // no credentials
	});
	const config: JudgmentConfig = {
		mode: "llm",
		thinkingLevel: "off",
		timeoutMs: 5000,
		model: "fake/fake-model",
		provider: "fake",
		modelId: "fake-model",
	};
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: { append: undefined, branch: () => [] },
	});
	const availability = await service.availability();
	assert.equal(availability.llm, undefined);
});

test("F10: credentialed configured chat IS available", async () => {
	const registry = probeRegistry({
		getModel: () => chatModel(),
		getAuth: async (p) =>
			p === "fake" ? { auth: { apiKey: "k" } } : undefined,
	});
	const config: JudgmentConfig = {
		mode: "llm",
		thinkingLevel: "off",
		timeoutMs: 5000,
		model: "fake/fake-model",
		provider: "fake",
		modelId: "fake-model",
	};
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: { append: undefined, branch: () => [] },
	});
	const availability = await service.availability();
	assert.equal(availability.llm, "fake/fake-model");
});

test("F10: unknown configured chat is not available, no hang on auth", async () => {
	const registry = probeRegistry({
		getModel: () => undefined, // absent from catalog
		getAuth: async () => {
			throw new Error("auth store down");
		},
	});
	const config: JudgmentConfig = {
		mode: "llm",
		thinkingLevel: "off",
		timeoutMs: 5000,
		model: "fake/gone",
		provider: "fake",
		modelId: "gone",
	};
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: { append: undefined, branch: () => [] },
	});
	const observed = await Promise.race([
		service.availability().then((a) => ({ a })),
		new Promise((r) => setTimeout(() => r({ hung: true }), 200)),
	]);
	assert.ok(!("hung" in (observed as object)));
	assert.equal((observed as { a: { llm?: string } }).a.llm, undefined);
});

test("F10: availability bounds a hanging auth check", async () => {
	const registry = probeRegistry({
		getModel: () => chatModel(),
		getAuth: () => new Promise(() => {}),
	});
	const config: JudgmentConfig = {
		mode: "llm",
		thinkingLevel: "off",
		timeoutMs: 30,
		model: "fake/fake-model",
		provider: "fake",
		modelId: "fake-model",
	};
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: { append: undefined, branch: () => [] },
	});
	const observed = await Promise.race([
		service.availability().then((a) => ({ a })),
		new Promise((r) => setTimeout(() => r({ hung: true }), 150)),
	]);
	assert.ok(!("hung" in (observed as object)));
	assert.equal((observed as { a: { llm?: string } }).a.llm, undefined);
});

// ---------------------------------------------------------------------------
// F3/F4/F6/F7 review repairs: final-only policy view, request-scoped cache
// ownership, exact SHA-256 identity, failed-batch pending settlement.
// ---------------------------------------------------------------------------

const COLLISION_A = "hofeiq1ohswst";
const COLLISION_B = "1q19tvf1jhhfcm"; // both digested 98c3d877 under 32-bit FNV

// --- F6 -------------------------------------------------------------------

test("F6: recorded 32-bit collision pair produces distinct identities", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.replayJev([
		jevResult({ q: { type: "bool", probability: 1 } }),
		jevResult({ q: { type: "bool", probability: 0 } }),
	]);
	const first = await h.service.judge({
		state: { s: COLLISION_A },
		questions: { q: BOOL_Q },
	});
	const second = await h.service.judge({
		state: { s: COLLISION_B },
		questions: { q: BOOL_Q },
	});
	assert.equal(first.stopReason, "stop");
	assert.equal(second.stopReason, "stop");
	// The second state MUST dispatch: no cross-state reuse.
	assert.equal(second.reuse.sent, 1);
	assert.equal(second.reuse.hits, 0);
	assert.equal(h.registry.jevCalls.length, 2);
	assert.equal(asBool(first.answers.q).probability, 1);
	assert.equal(asBool(second.answers.q).probability, 0);
});

test("F6: partial-stage judgment is never reused as full coverage", async () => {
	const seen: { final: boolean; count: number }[] = [];
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.classify = (async (_m, context) => {
		const evidence = context.state.evidence as unknown[];
		seen.push({
			final: (context.state.progress as { final: boolean }).final,
			count: evidence.length,
		});
		if (evidence.length > 1) {
			return {
				...jevResult({}),
				stopReason: "error",
				errorMessage: "context_length_exceeded",
			} as never;
		}
		return jevResult({
			q: { type: "bool", probability: 1 },
		}) as never;
	}) as typeof h.registry.classify;
	const first = await h.service.judge({
		state: {},
		questions: { q: BOOL_Q },
		evidence: [
			{ id: "a", text: "a" },
			{ id: "b", text: "b" },
		],
	});
	assert.equal(first.stopReason, "stop");
	const before = seen.length;
	// Standalone [a] is a DIFFERENT (root-complete) context: must dispatch.
	const second = await h.service.judge({
		state: {},
		questions: { q: BOOL_Q },
		evidence: [{ id: "a", text: "a" }],
	});
	assert.equal(second.reuse.sent, 1);
	assert.equal(second.reuse.hits, 0);
	assert.equal(seen.length, before + 1);
	assert.equal(seen.at(-1)?.final, true);
});

test("F6: reordered JSON state canonicalizes to the same identity", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.replayJev([jevResult({ q: { type: "bool", probability: 1 } })]);
	const first = await h.service.judge({
		state: { a: 1, b: { c: 2, d: 3 } },
		questions: { q: BOOL_Q },
	});
	const second = await h.service.judge({
		state: { b: { d: 3, c: 2 }, a: 1 },
		questions: { q: BOOL_Q },
	});
	assert.equal(first.stopReason, "stop");
	// Equivalent key order = same canonical identity = cache hit, no dispatch.
	assert.equal(second.reuse.hits, 1);
	assert.equal(second.reuse.sent, 0);
	assert.equal(h.registry.jevCalls.length, 1);
});

test("F6: fresh new-review never joins older ordinary pending work", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let calls = 0;
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.classify = (async () => {
		calls += 1;
		await gate;
		return jevResult({ q: { type: "bool", probability: 0.9 } });
	}) as typeof h.registry.classify;
	const ordinary = h.service.judge({ state: {}, questions: { q: BOOL_Q } });
	await new Promise((r) => setTimeout(r, 5));
	const forced = h.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ fresh: "new-review" },
	);
	await new Promise((r) => setTimeout(r, 5));
	release?.();
	await ordinary;
	const forcedResult = await forced;
	// The forced review dispatched its OWN evaluation (no join of ordinary).
	assert.equal(calls, 2);
	assert.equal(forcedResult.reuse.joined, 0);
	assert.equal(forcedResult.reuse.sent, 1);
});

test("F6: distinct fresh tokens never reuse each other's work", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.replayJev([
		jevResult({ q: { type: "bool", probability: 0.9 } }),
		jevResult({ q: { type: "bool", probability: 0.8 } }),
		jevResult({ q: { type: "bool", probability: 0.7 } }),
	]);
	const t1 = await h.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ fresh: "review-1" },
	);
	const t2 = await h.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ fresh: "review-2" },
	);
	const t1again = await h.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ fresh: "review-1" },
	);
	assert.equal(t1.reuse.sent, 1);
	assert.equal(t2.reuse.sent, 1); // distinct token: fresh dispatch
	assert.equal(t1again.reuse.sent, 0); // same token: reuse
	assert.equal(t1again.reuse.hits, 1);
	assert.equal(asBool(t1again.answers.q).probability, 0.9);
});

test("F6: restored fresh membership only reuses its own token's work", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.replayJev([jevResult({ q: { type: "bool", probability: 0.9 } })]);
	await h.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ fresh: "tok-A" },
	);
	// Simulate resume with the ledger rows on the branch.
	h.branchEntries.push(
		...h.ledgerRecords.map((data) => ({
			type: "custom",
			customType: LEDGER_TYPE,
			data,
		})),
	);
	h.service.refreshBranch();
	const sameTok = await h.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ fresh: "tok-A" },
	);
	assert.equal(sameTok.reuse.sent, 0); // restored membership reused
	assert.equal(sameTok.reuse.hits, 1);
	const otherTok = await h.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ fresh: "tok-B" },
	);
	assert.equal(otherTok.reuse.sent, 1); // different token: dispatch
});

// --- F3 -------------------------------------------------------------------

test("F3: accept→drop stage sequence yields final-stage view only", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.jevContextWindow = 100; // force evidence subdivision
	h.registry.classify = (async (_m, context) => {
		const evidence = context.state.evidence as { id: string }[];
		const isFinal = (context.state.progress as { final: boolean }).final;
		if (!isFinal) {
			return jevResult({ q: { type: "bool", probability: 0.99 } }) as never;
		}
		// Final stage answers by its own record.
		const last = evidence.at(-1)!.id;
		return jevResult({
			q: { type: "bool", probability: last === "second" ? 0.5 : 0.99 },
		}) as never;
	}) as typeof h.registry.classify;
	const r = await h.service.judge(
		{
			state: {},
			questions: { q: BOOL_Q },
			evidence: [
				{ id: "first", text: "f".repeat(2000) },
				{ id: "second", text: "s".repeat(2000) },
			],
		},
		{ minConfidence: 0.8 },
	);
	assert.equal(r.stopReason, "stop");
	// Final stage answered 0.5 < 0.8: dropped ONLY, never accepted.
	assert.deepEqual(r.dropped, ["q"]);
	assert.deepEqual(r.answers, {});
});

test("F3: drop→accept stage sequence yields final-stage view only", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.jevContextWindow = 100;
	h.registry.classify = (async (_m, context) => {
		const isFinal = (context.state.progress as { final: boolean }).final;
		if (!isFinal) {
			return jevResult({ q: { type: "bool", probability: 0.5 } }) as never;
		}
		return jevResult({ q: { type: "bool", probability: 0.99 } }) as never;
	}) as typeof h.registry.classify;
	const r = await h.service.judge(
		{
			state: {},
			questions: { q: BOOL_Q },
			evidence: [
				{ id: "first", text: "f".repeat(2000) },
				{ id: "second", text: "s".repeat(2000) },
			],
		},
		{ minConfidence: 0.8 },
	);
	assert.equal(r.stopReason, "stop");
	// Earlier drop must NOT persist: final 0.99 accepted.
	assert.deepEqual(r.dropped, []);
	assert.ok(r.answers.q);
});

test("F3: later-stage error returns no final answers", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.jevContextWindow = 100;
	h.registry.classify = (async (_m, context) => {
		const isFinal = (context.state.progress as { final: boolean }).final;
		if (!isFinal) {
			return jevResult({ q: { type: "bool", probability: 0.99 } }) as never;
		}
		return {
			...jevResult({}),
			stopReason: "error",
			errorMessage: "provider exploded on final stage",
		} as never;
	}) as typeof h.registry.classify;
	const r = await h.service.judge(
		{
			state: {},
			questions: { q: BOOL_Q },
			evidence: [
				{ id: "first", text: "f".repeat(2000) },
				{ id: "second", text: "s".repeat(2000) },
			],
		},
		{ minConfidence: 0.8 },
	);
	assert.equal(r.stopReason, "error");
	assert.deepEqual(r.answers, {});
});

// --- F4 -------------------------------------------------------------------

test("F4: released stale branch completion cannot contaminate the new branch cache", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.classify = (async () => {
		await gate;
		return jevResult({ q: { type: "bool", probability: 0.9 } });
	}) as typeof h.registry.classify;
	const old = h.service.judge({ state: {}, questions: { q: BOOL_Q } });
	await new Promise((r) => setTimeout(r, 5));
	const beforeSwitchRows = h.ledgerRecords.length;
	h.branchEntries.length = 0; // new branch has nothing
	h.service.refreshBranch();
	release?.();
	const oldResult = await old;
	assert.equal(oldResult.stopReason, "aborted");
	assert.ok(oldResult.errorMessage);
	assert.equal(h.ledgerRecords.length, beforeSwitchRows);
	// The NEW branch must dispatch fresh: no stale cache contamination.
	const next = await h.service.judge({ state: {}, questions: { q: BOOL_Q } });
	assert.equal(next.reuse.sent, 1);
	assert.equal(next.reuse.hits, 0);
	const newRows = h.ledgerRecords.slice(beforeSwitchRows);
	assert.equal(newRows.filter((row) => row.kind === "judgment").length, 1);
});

test("F4: abort after a completed early stage persists no judgments", async () => {
	let enteredFinal = false;
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.jevContextWindow = 100;
	const controller = new AbortController();
	h.registry.classify = (async (_m, context) => {
		const evidence = context.state.evidence as { id: string }[];
		const isFinal = (context.state.progress as { final: boolean }).final;
		if (!isFinal) {
			return jevResult({ q: { type: "bool", probability: 0.9 } }) as never;
		}
		enteredFinal = true;
		// Final stage hangs until aborted.
		await new Promise<never>(() => {});
		return undefined as never;
	}) as typeof h.registry.classify;
	const pending = h.service.judge(
		{
			state: {},
			questions: { q: BOOL_Q },
			evidence: [
				{ id: "first", text: "f".repeat(2000) },
				{ id: "second", text: "s".repeat(2000) },
			],
		},
		{ signal: controller.signal },
	);
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(enteredFinal, "fixture did not reach the final stage");
	controller.abort();
	const r = await pending;
	assert.equal(r.stopReason, "aborted");
	// NO judgments persisted for the aborted request, early stage included.
	const judgments = h.ledgerRecords.filter((x) => x.kind === "judgment");
	assert.equal(judgments.length, 0);
	let firstStageDispatches = 0;
	h.registry.classify = (async (_m, context) => {
		if ((context.state.evidence as unknown[]).length > 1)
			return {
				...jevResult({}),
				stopReason: "error",
				errorMessage: "context_length_exceeded",
			};
		if (!(context.state.progress as { final: boolean }).final)
			firstStageDispatches++;
		return jevResult({ q: { type: "bool", probability: 0.9 } });
	}) as typeof h.registry.classify;
	const retried = await h.service.judge({
		state: {},
		questions: { q: BOOL_Q },
		evidence: [
			{ id: "first", text: "f".repeat(2000) },
			{ id: "second", text: "s".repeat(2000) },
		],
	});
	assert.equal(retried.stopReason, "stop");
	assert.ok(
		firstStageDispatches > 0,
		"aborted work must not leave a reusable partial answer",
	);
	assert.equal(retried.reuse.hits, 0);
});

test("F4: canceled waiter does not cancel an unrelated caller's work", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.classify = (async () => {
		await gate;
		return jevResult({ q: { type: "bool", probability: 0.9 } });
	}) as typeof h.registry.classify;
	const owner = h.service.judge({ state: {}, questions: { q: BOOL_Q } });
	await new Promise((r) => setTimeout(r, 5));
	const controller = new AbortController();
	const waiter = h.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ signal: controller.signal },
	);
	await new Promise((r) => setTimeout(r, 5));
	controller.abort();
	const waiterResult = await waiter;
	assert.equal(waiterResult.stopReason, "aborted");
	release?.();
	const ownerResult = await owner;
	// The owner completed successfully despite the waiter's cancel.
	assert.equal(ownerResult.stopReason, "stop");
	assert.ok(ownerResult.answers.q);
});

// --- F7 -------------------------------------------------------------------

test("F7: reported two-question overflow sends both smaller batches", async () => {
	const seen: { keys: string[] }[] = [];
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.classify = (async (_m, context) => {
		const keys = Object.keys(context.questions);
		seen.push({ keys });
		if (keys.length > 1) {
			return {
				...jevResult({}),
				stopReason: "error",
				errorMessage: "context_length_exceeded",
			} as never;
		}
		return jevResult({
			[keys[0]]: { type: "bool", probability: 0.9 },
		}) as never;
	}) as typeof h.registry.classify;
	const r = await h.service.judge({
		state: {},
		questions: { one: BOOL_Q, two: BOOL_Q },
	});
	assert.equal(r.stopReason, "stop");
	assert.ok(r.answers.one);
	assert.ok(r.answers.two);
	// The full batch was sent once, then BOTH singletons — never an
	// unchanged resend, and no failed-batch join.
	const batches = seen.map((s) => s.keys.sort().join(","));
	assert.ok(batches.includes("one,two"));
	assert.ok(batches.includes("one"));
	assert.ok(batches.includes("two"));
	assert.equal(batches.filter((b) => b === "one,two").length, 1);
	assert.equal(r.reuse.joined, 0);
});

test("F7: reported eight-question overflow recovers all answers", async () => {
	const h = harness({ mode: "classifier" });
	h.registry.available = [jevModel()];
	h.registry.classify = (async (_m, context) => {
		const keys = Object.keys(context.questions);
		if (keys.length > 2) {
			return {
				...jevResult({}),
				stopReason: "error",
				errorMessage: "context_length_exceeded",
			} as never;
		}
		return jevResult(
			Object.fromEntries(
				keys.map((id) => [id, { type: "bool", probability: 0.9 }]),
			),
		) as never;
	}) as typeof h.registry.classify;
	const questions: Record<string, typeof BOOL_Q> = {};
	for (let i = 0; i < 8; i++) questions[`q${i}`] = BOOL_Q;
	const r = await h.service.judge({ state: {}, questions });
	assert.equal(r.stopReason, "stop");
	assert.equal(Object.keys(r.answers).length, 8);
	assert.deepEqual(r.dropped, []);
});

// --- F12: real Unicode assertions (replaces || true tautology) -----------

test("discovery after an external save keeps the admitted configuration", async () => {
	const registry = new FakeRegistry();
	registry.available = ["x", "y"].map((id) => ({ ...jevModel(), id }));
	registry.authKeys.set("typesafe", "fixture-key");
	registry.replayJev([
		jevResult({ green: { type: "bool", probability: 0.9 } }),
	]);
	let current = baseConfig({
		mode: "classifier",
		classifierModel: "typesafe/x",
		classifierProvider: "typesafe",
		classifierModelId: "x",
	});
	let reads = 0;
	let entered!: () => void;
	const admission = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const auth = registry.getAuth.bind(registry);
	registry.getAuth = async (id) => {
		entered();
		await barrier;
		return auth(id);
	};
	const service = createJudgmentService({
		registry,
		config: () => {
			reads += 1;
			return current;
		},
		ledger: { append: undefined, branch: () => [] },
	});
	const pending = service.judge({ state: {}, questions: { green: BOOL_Q } });
	await admission;
	current = {
		...current,
		classifierModel: "typesafe/y",
		classifierModelId: "y",
	};
	release();
	const result = await pending;
	assert.equal(result.model, "typesafe/x");
	assert.equal(reads, 1, "one admission read, no helper rereads");
	assert.equal(result.stopReason, "stop");
});

test("unexpected failure retains the selected native identity after a save", async () => {
	const registry = new FakeRegistry();
	registry.available = [{ ...jevModel(), id: "x" }];
	let current = baseConfig({
		mode: "classifier",
		classifierModel: "typesafe/x",
		classifierProvider: "typesafe",
		classifierModelId: "x",
	});
	let probes = 0;
	registry.getProviders = () => {
		if (++probes === 2) {
			current = { ...current, model: "fake/y", modelId: "y" };
			throw new Error("fixture metadata failure");
		}
		return [];
	};
	const service = createJudgmentService({
		registry,
		config: () => current,
		ledger: { append: undefined, branch: () => [] },
	});
	const result = await service.judge({
		state: {},
		questions: { green: BOOL_Q },
	});
	assert.equal(result.stopReason, "error");
	assert.equal(result.backend, "classifier");
	assert.equal(result.model, "typesafe/x");
	assert.match(result.errorMessage ?? "", /fixture metadata failure/);
});

test("F12: fragment texts are well-formed Unicode with exact coverage", async () => {
	const { FRAGMENT_MIN_CHARS, frameEvidence, splitPiece } = await import(
		"../src/pipeline.ts"
	);
	const text =
		"𝕏".repeat(FRAGMENT_MIN_CHARS * 2) + "🚀".repeat(FRAGMENT_MIN_CHARS);
	let pieces = frameEvidence([{ id: "u", text }]);
	for (let depth = 0; depth < 24; depth++) {
		let changed = false;
		pieces = pieces.flatMap((p) => {
			const halves = splitPiece([p]);
			if (halves) {
				changed = true;
				return halves.flat();
			}
			return [p];
		});
		if (!changed) break;
	}
	// Every fragment is well-formed Unicode (no lone surrogates):
	// a lone surrogate anywhere makes encodeURIComponent throw.
	const wellFormed = (t: string): boolean => {
		try {
			encodeURIComponent(t);
			return true;
		} catch {
			return false;
		}
	};
	for (const p of pieces) {
		assert.ok(wellFormed(p.record.text), "fragment text not well-formed");
	}
	// Exact ordered reassembly.
	assert.equal(pieces.map((p) => p.record.text).join(""), text);
	// Contiguous absolute coverage.
	const bounds = pieces.map((p) => p.bounds!).filter(Boolean);
	assert.ok(bounds.length >= 2);
	assert.equal(bounds[0].start, 0);
	for (let i = 1; i < bounds.length; i++)
		assert.equal(bounds[i].start, bounds[i - 1].end);
	assert.equal(bounds.at(-1)!.end, text.length);
	// Each fragment is the exact slice of its bounds.
	for (const p of pieces) {
		if (p.bounds)
			assert.equal(p.record.text, text.slice(p.bounds.start, p.bounds.end));
	}
});

// --- Backend-specific timeout semantics (timeout slice) --------------------
// LLM: caller timeoutMs is a transport-inactivity window per provider
// request (including the bounded first-response wait), never a whole-call
// countdown across questions/stages. Native classifier: one absolute
// logical-call deadline, not reset across internal stages.

test("LLM call outlives the old whole-call deadline when transport stays active", async () => {
	const h = harness();
	// Drip raw response bytes every 15ms for ~60ms while the adapter waits on
	// the body: activity (bytes) is what resets the inactivity clock. The
	// scripted transport stands in for globalThis.fetch — never a real URL.
	const encoder = new TextEncoder();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (sent >= 4) {
					controller.close();
					return;
				}
				await new Promise((r) => setTimeout(r, 15));
				sent += 1;
				controller.enqueue(encoder.encode(`data: chunk-${sent}\n\n`));
			},
		});
		return new Response(body, { status: 200 });
	}) as typeof globalThis.fetch;
	const original = h.registry.streamSimple.bind(h.registry);
	h.registry.streamSimple = ((model, context, options) => {
		const call = original(model, context, options);
		return {
			result: async () => {
				const body = await options!.fetch!("https://fake.invalid/sse", {
					signal: options?.signal,
				});
				const reader = body.body!.getReader();
				while (!(await reader.read()).done) {}
				return call.result();
			},
		};
	}) as typeof h.registry.streamSimple;
	h.registry.replayLlm([boolToolMessage(true)]);
	const started = Date.now();
	const result = await h.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ timeoutMs: 30 },
	);
	const elapsed = Date.now() - started;
	assert.equal(result.stopReason, "stop");
	assert.equal(result.answers.q?.type, "bool");
	assert.ok(
		elapsed > 30,
		`expected total duration to exceed 30ms idle window, took ${elapsed}ms`,
	);
	assert.equal(h.registry.llmCalls.length, 1);
	h.registry.streamSimple = original;
	globalThis.fetch = originalFetch;
});

test("LLM caller abort resolves aborted during an in-flight stream", async () => {
	const h = harness();
	const original = h.registry.streamSimple.bind(h.registry);
	h.registry.streamSimple = ((model, context, options) => {
		const call = original(model, context, options);
		void call;
		return {
			result: () =>
				new Promise<AssistantMessage>((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => resolve(llmMessage([])),
						{ once: true },
					);
					// Deliberately never resolves on its own: the caller signal is
					// the only path out, like an adapter honoring its signal.
				}),
		};
	}) as typeof h.registry.streamSimple;
	const controller = new AbortController();
	const pending = h.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ signal: controller.signal },
	);
	await new Promise((r) => setTimeout(r, 15));
	controller.abort();
	const result = await Promise.race([
		pending,
		new Promise<JudgeResult>((_, reject) =>
			setTimeout(() => reject(new Error("abort did not settle")), 500),
		),
	]);
	assert.equal(result.stopReason, "aborted");
	assert.deepEqual(result.answers, {});
	h.registry.streamSimple = original;
});

test("LLM inactivity window still bounds a stalled stream through the service", async () => {
	const h = harness();
	const original = h.registry.streamSimple.bind(h.registry);
	h.registry.streamSimple = ((model, context, options) => {
		const call = original(model, context, options);
		return {
			result: async () => {
				// Registry ignores the signal itself but the injected fetch
				// honors it: the plugin's inactivity abort releases the stall.
				const body = await options!.fetch!("https://fake.invalid/sse", {
					signal: options?.signal,
				});
				const reader = body.body!.getReader();
				await reader.read(); // never returns a byte
				return call.result();
			},
		};
	}) as typeof h.registry.streamSimple;
	// The transport never produces a byte and is released only by the
	// request's own abort (the plugin's inactivity signal).
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_url, init) =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					init?.signal?.addEventListener("abort", () => controller.close(), {
						once: true,
					});
				},
			}),
			{ status: 200 },
		)) as typeof globalThis.fetch;
	h.registry.replayLlm([boolToolMessage(true)]);
	const result = await h.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ timeoutMs: 40 },
	);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /timed out/i);
	assert.deepEqual(result.answers, {});
	h.registry.streamSimple = original;
	globalThis.fetch = originalFetch;
});

test("LLM callers with different inactivity windows dispatch instead of joining", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const h = harness();
	const original = h.registry.streamSimple.bind(h.registry);
	h.registry.streamSimple = ((model, context, options) => {
		const call = original(model, context, options);
		return {
			result: async () => {
				await gate; // first call parks here so the second finds it pending
				return call.result();
			},
		};
	}) as typeof h.registry.streamSimple;
	h.registry.replayLlm([boolToolMessage(true), boolToolMessage(true)]);
	const first = h.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ timeoutMs: 5000 },
	);
	await new Promise((r) => setTimeout(r, 10));
	const second = h.service.judge(
		{ state: {}, questions: { q: BOOL_Q } },
		{ timeoutMs: 40 },
	);
	await new Promise((r) => setTimeout(r, 30));
	release?.();
	const [a, b] = await Promise.all([first, second]);
	assert.equal(a.stopReason, "stop");
	assert.equal(b.stopReason, "stop");
	// Distinct inactivity windows must not share one owner clock.
	assert.equal(h.registry.llmCalls.length, 2);
	assert.equal(a.reuse.joined, 0);
	assert.equal(b.reuse.joined, 0);
	h.registry.streamSimple = original;
});

test("LLM callers with the same inactivity window still join", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const h = harness();
	const original = h.registry.streamSimple.bind(h.registry);
	h.registry.streamSimple = ((model, context, options) => {
		const call = original(model, context, options);
		return {
			result: async () => {
				await gate;
				return call.result();
			},
		};
	}) as typeof h.registry.streamSimple;
	h.registry.replayLlm([boolToolMessage(true)]);
	const req = { state: {}, questions: { q: BOOL_Q } };
	const first = h.service.judge(req, { timeoutMs: 5000 });
	await new Promise((r) => setTimeout(r, 10));
	const second = h.service.judge(req, { timeoutMs: 5000 });
	// Release only after the joiner has had time to reach the pending
	// lookup while the owner is still in flight.
	await new Promise((r) => setTimeout(r, 30));
	release?.();
	const [a, b] = await Promise.all([first, second]);
	assert.equal(a.stopReason, "stop");
	assert.equal(b.stopReason, "stop");
	assert.equal(h.registry.llmCalls.length, 1);
	assert.equal(a.reuse.joined + b.reuse.joined, 1);
	h.registry.streamSimple = original;
});
