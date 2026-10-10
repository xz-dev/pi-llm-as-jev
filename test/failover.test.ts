/**
 * Automatic one-switch failover (add-auto-llm-fallback): fixed route order,
 * lazy candidate resolution, eligible vs terminal failures, per-attempt
 * timeout windows, result isolation and retired-attempt fencing. Uses a
 * scripted registry; every dispatch is counted per backend.
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
} from "@earendil-works/pi-ai";
import type { JudgeRequest, ReviewOptions } from "../client/judgment-client.ts";
import type { JudgmentConfig, JudgmentMode } from "../src/config.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { createJudgmentService, type ServiceRegistry } from "../src/service.ts";

type AnyModel = Model<Api>;
type AnyClassifierModel = ClassifierModel<ClassifierApi>;
type Context = Parameters<ServiceRegistry["classify"]>[1];
type ClassifyOptions = Parameters<ServiceRegistry["classify"]>[2];
type StreamOptions = Parameters<ServiceRegistry["streamSimple"]>[2];

const SECRET = "sk-synthetic-failover-secret-0123";
const Q = {
	type: "bool" as const,
	instructions: "?",
	criteria: { true: "y", false: "n" },
};
const REQ: JudgeRequest = { state: { x: 1 }, questions: { q: Q } };

const chat: AnyModel = {
	id: "chat",
	provider: "llmco",
	api: "openai-completions",
	baseUrl: "https://llm.invalid",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 100000,
	maxTokens: 1024,
} as AnyModel;
const jev: AnyClassifierModel = {
	type: "classifier",
	id: "jev-1.13",
	provider: "typesafe",
	name: "jev",
	api: "typesafe-system-one",
	baseUrl: "https://native.invalid",
	input: ["text"],
	contextWindow: 100000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = <T>() => new Promise<T>(() => {});

function nativeOk(probability = 0.9): ClassifierResult {
	return {
		api: jev.api,
		provider: jev.provider,
		model: jev.id,
		answers: { q: { type: "bool", probability } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
function nativeFail(message = "native 503"): ClassifierResult {
	return {
		...nativeOk(),
		answers: {},
		stopReason: "error",
		errorMessage: message,
	};
}
function llmAnswer(value: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "c1", name: "answer", arguments: { value } },
		],
		api: "openai-completions",
		provider: "llmco",
		model: "chat",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}
function llmError(message: string): AssistantMessage {
	return {
		...llmAnswer(true),
		content: [],
		stopReason: "error",
		errorMessage: message,
	};
}

interface Script {
	discover?: () => Promise<readonly AnyClassifierModel[]>;
	classify?: (
		context: Context,
		options: ClassifyOptions,
	) => Promise<ClassifierResult>;
	llm?: (options: StreamOptions) => Promise<AssistantMessage>;
	auth?: (id: string) => Promise<{ auth: { apiKey: string } } | undefined>;
	llmConfigured?: boolean;
}

function harness(
	mode: JudgmentMode,
	script: Script = {},
	extra: Partial<JudgmentConfig> = {},
	onDiag?: (row: LedgerRecord) => void,
) {
	const calls = { discover: 0, native: 0, llm: 0, auth: [] as string[] };
	const nativeTimeouts: (number | undefined)[] = [];
	const rows: LedgerRecord[] = [];
	const registry: ServiceRegistry = {
		getProviders: () => [{ id: "llmco" }, { id: "typesafe" }],
		getAuth: async (id: string) => {
			calls.auth.push(id);
			return script.auth
				? script.auth(id)
				: { auth: { apiKey: id === "llmco" ? SECRET : `${id}-key` } };
		},
		getModel: (provider: string, id: string) =>
			script.llmConfigured !== false &&
			provider === chat.provider &&
			id === chat.id
				? chat
				: undefined,
		getAvailableOfType: async () => {
			calls.discover++;
			return script.discover ? script.discover() : [jev];
		},
		classify: async (
			_model: AnyClassifierModel,
			context: Context,
			options: ClassifyOptions,
		) => {
			calls.native++;
			nativeTimeouts.push(options?.timeoutMs);
			return script.classify ? script.classify(context, options) : nativeOk();
		},
		streamSimple: (_model: never, _context: never, options?: StreamOptions) => {
			calls.llm++;
			return {
				result: () =>
					script.llm ? script.llm(options) : Promise.resolve(llmAnswer(true)),
			};
		},
	} as unknown as ServiceRegistry;
	const config: JudgmentConfig = {
		mode,
		thinkingLevel: "off",
		model: "llmco/chat",
		provider: "llmco",
		modelId: "chat",
		...extra,
	};
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: {
			append: (_t, row) => {
				rows.push(row);
				if (row.kind === "diag") onDiag?.(row);
			},
			branch: () => [],
		},
	});
	return { service, calls, nativeTimeouts, rows, config };
}

const judgments = (rows: LedgerRecord[]) =>
	rows.filter((row) => row.kind === "judgment") as Extract<
		LedgerRecord,
		{ kind: "judgment" }
	>[];

// ---------------------------------------------------------------------------
// 1.3 Route order, lazy resolution and the one switch
// ---------------------------------------------------------------------------

test("auto: classifier first success never touches the LLM", async () => {
	const h = harness("auto");
	const r = await h.service.judge(REQ);
	assert.equal(r.stopReason, "stop");
	assert.equal(r.backend, "classifier");
	assert.deepEqual([h.calls.native, h.calls.llm], [1, 0]);
});

test("auto-llm: LLM first success never discovers or dispatches native", async () => {
	const h = harness("auto-llm");
	const r = await h.service.judge(REQ);
	assert.equal(r.stopReason, "stop");
	assert.equal(r.backend, "llm");
	assert.equal(r.model, "llmco/chat");
	assert.deepEqual([h.calls.discover, h.calls.native, h.calls.llm], [0, 0, 1]);
});

test("auto: missing native candidate uses the LLM", async () => {
	const h = harness("auto", { discover: async () => [] });
	const r = await h.service.judge(REQ);
	assert.equal(r.backend, "llm");
	assert.equal(r.stopReason, "stop");
	assert.deepEqual([h.calls.native, h.calls.llm], [0, 1]);
});

test("auto-llm: unconfigured LLM uses the default native candidate", async () => {
	const h = harness("auto-llm", { llmConfigured: false });
	const r = await h.service.judge(REQ);
	assert.equal(r.backend, "classifier");
	assert.equal(r.model, "typesafe/jev-1.13");
	assert.deepEqual([h.calls.native, h.calls.llm], [1, 0]);
});

test("auto: explicit missing classifier never substitutes another native model", async () => {
	const h = harness(
		"auto",
		{},
		{
			classifierModel: "typesafe/absent",
			classifierProvider: "typesafe",
			classifierModelId: "absent",
		},
	);
	const r = await h.service.judge(REQ);
	assert.equal(r.backend, "llm");
	assert.deepEqual([h.calls.native, h.calls.llm], [0, 1]);
});

for (const [name, discover] of [
	[
		"sync throw",
		() => {
			throw new Error("registry exploded");
		},
	],
	["rejection", async () => Promise.reject(new Error("auth store down"))],
] as const)
	test(`auto: native discovery ${name} fails over to the LLM`, async () => {
		const h = harness("auto", {
			discover: discover as () => Promise<readonly AnyClassifierModel[]>,
		});
		const r = await h.service.judge(REQ);
		assert.equal(r.stopReason, "stop", r.errorMessage ?? "");
		assert.equal(r.backend, "llm");
		assert.equal(r.errorMessage, undefined);
		assert.deepEqual([h.calls.native, h.calls.llm], [0, 1]);
	});

test("auto: native runtime failure gives exactly one LLM attempt", async () => {
	const h = harness("auto", { classify: async () => nativeFail() });
	const r = await h.service.judge(REQ);
	assert.equal(r.stopReason, "stop");
	assert.equal(r.backend, "llm");
	assert.equal(r.errorMessage, undefined);
	assert.deepEqual([h.calls.native, h.calls.llm], [1, 1]);
});

test("auto-llm: LLM provider failure gives exactly one native attempt", async () => {
	const h = harness("auto-llm", { llm: async () => llmError("HTTP 502") });
	const r = await h.service.judge(REQ);
	assert.equal(r.stopReason, "stop");
	assert.equal(r.backend, "classifier");
	assert.equal(r.model, "typesafe/jev-1.13");
	assert.deepEqual([h.calls.native, h.calls.llm], [1, 1]);
});

test("auto-llm: invalid LLM output after its one repair fails over", async () => {
	const h = harness("auto-llm", {
		llm: async () => ({ ...llmAnswer(true), content: [] }),
	});
	const r = await h.service.judge(REQ);
	assert.equal(r.backend, "classifier");
	assert.equal(r.stopReason, "stop");
	assert.deepEqual([h.calls.llm, h.calls.native], [2, 1]); // repair kept
});

for (const mode of ["auto", "auto-llm"] as const)
	test(`${mode}: both attempts failing yields one bounded redacted summary`, async () => {
		const body = `<html>${"x".repeat(2000)} leaked ${SECRET}</html>`;
		const h = harness(mode, {
			classify: async () => nativeFail(body),
			llm: async () => llmError(`provider said ${SECRET} ${body}`),
		});
		const r = await h.service.judge(REQ);
		assert.equal(r.stopReason, "error");
		assert.deepEqual(r.answers, {});
		assert.deepEqual([h.calls.native, h.calls.llm], [1, 1]); // no cycle
		const message = r.errorMessage ?? "";
		assert.match(message, /both automatic backend attempts failed/);
		assert.match(message, /classifier/);
		assert.match(message, /llm/);
		assert.equal(message.includes(SECRET), false);
		assert.equal(message.includes("<html>"), false);
		assert.ok(message.length < 800, `bounded: ${message.length}`);
		// Terminal attempt identity.
		assert.equal(r.backend, mode === "auto" ? "llm" : "classifier");
	});

test("auto-llm: both candidates unavailable explains both", async () => {
	const h = harness("auto-llm", {
		llmConfigured: false,
		discover: async () => [],
	});
	const r = await h.service.judge(REQ);
	assert.equal(r.stopReason, "error");
	assert.match(r.errorMessage ?? "", /no LLM model is configured/);
	assert.match(r.errorMessage ?? "", /native classifier/);
	assert.deepEqual([h.calls.native, h.calls.llm], [0, 0]);
});

test("next operation restores the configured priority", async () => {
	let fail = true;
	const h = harness("auto", {
		classify: async () => (fail ? nativeFail() : nativeOk()),
	});
	assert.equal((await h.service.judge(REQ)).backend, "llm");
	fail = false;
	const next = await h.service.judge({ state: { x: 2 }, questions: { q: Q } });
	assert.equal(next.backend, "classifier");
	assert.equal(h.config.mode, "auto"); // never persisted
});

// ---------------------------------------------------------------------------
// 1.4 Terminal outcomes never dispatch the alternate
// ---------------------------------------------------------------------------

test("valid false and all-dropped results are successes, not failover", async () => {
	const neg = harness("auto", { classify: async () => nativeOk(0.01) });
	const r1 = await neg.service.judge(REQ);
	assert.equal(r1.backend, "classifier");
	assert.equal(neg.calls.llm, 0);
	const dropped = harness("auto", { classify: async () => nativeOk(0.55) });
	const r2 = await dropped.service.judge(REQ, { minConfidence: 0.99 });
	assert.equal(r2.stopReason, "stop");
	assert.deepEqual(r2.dropped, ["q"]);
	assert.equal(dropped.calls.llm, 0);
	const llmNeg = harness("auto-llm", { llm: async () => llmAnswer(false) });
	assert.equal((await llmNeg.service.judge(REQ)).backend, "llm");
	assert.equal(llmNeg.calls.native, 0);
});

test("invalid request or policy never selects an alternate", async () => {
	for (const mode of ["auto", "auto-llm"] as const) {
		const h = harness(mode);
		const bad = await h.service.judge({ state: {}, questions: {} } as never);
		assert.equal(bad.stopReason, "error");
		assert.match(bad.errorMessage ?? "", /invalid request/);
		const policy = await h.service.judge(REQ, { minConfidence: 7 });
		assert.match(policy.errorMessage ?? "", /invalid request/);
		assert.deepEqual([h.calls.native, h.calls.llm], [0, 0]);
	}
});

test("forced modes never switch backend", async () => {
	const c = harness("classifier", { classify: async () => nativeFail() });
	assert.equal((await c.service.judge(REQ)).stopReason, "error");
	assert.equal(c.calls.llm, 0);
	const l = harness("llm", { llm: async () => llmError("HTTP 502") });
	assert.equal((await l.service.judge(REQ)).stopReason, "error");
	assert.equal(l.calls.discover + l.calls.native, 0);
});

test("caller abort during the preferred attempt is terminal", async () => {
	const controller = new AbortController();
	const h = harness("auto", {
		classify: (_c, options) =>
			new Promise((resolve) => {
				options?.signal?.addEventListener("abort", () =>
					resolve({ ...nativeFail(), stopReason: "aborted" }),
				);
				controller.abort();
			}),
	});
	const r = await h.service.judge(REQ, { signal: controller.signal });
	assert.equal(r.stopReason, "aborted");
	assert.equal(h.calls.llm, 0);
	assert.equal(judgments(h.rows).length, 0);
});

test("cancellation observed between attempts prevents alternate dispatch", async () => {
	const controller = new AbortController();
	const h = harness(
		"auto",
		{ classify: async () => nativeFail() },
		{},
		// finish() writes the failed attempt's diag record right before the
		// operation loop decides on failover: cancel exactly there.
		(row) => {
			if ((row as { backend?: string }).backend === "classifier")
				controller.abort();
		},
	);
	const r = await h.service.judge(REQ, { signal: controller.signal });
	assert.equal(r.stopReason, "aborted");
	assert.equal(h.calls.llm, 0);
});

test("pre-aborted signal dispatches nothing", async () => {
	const controller = new AbortController();
	controller.abort();
	const h = harness("auto-llm");
	const r = await h.service.judge(REQ, { signal: controller.signal });
	assert.equal(r.stopReason, "aborted");
	assert.deepEqual([h.calls.native, h.calls.llm, h.calls.discover], [0, 0, 0]);
});

test("session navigation during the preferred attempt is terminal", async () => {
	let service!: ReturnType<typeof harness>["service"];
	const h = harness("auto", {
		classify: async () => {
			service.refreshBranch();
			return nativeFail();
		},
	});
	service = h.service;
	const r = await h.service.judge(REQ);
	assert.equal(r.stopReason, "aborted");
	assert.equal(h.calls.llm, 0);
});

test("local callback fault in review is terminal, not failover", async () => {
	const h = harness("auto");
	const r = await h.service.review(
		{ ...REQ, evidence: [{ id: "e", text: "t" }] },
		{
			projectionRevision: "r1",
			projectStage: () => {
				throw new Error("business projection bug");
			},
		} as ReviewOptions,
	);
	assert.equal(r.stopReason, "error");
	assert.deepEqual([h.calls.native, h.calls.llm], [0, 0]);
});

// ---------------------------------------------------------------------------
// 2.1 Fresh per-attempt timeout windows
// ---------------------------------------------------------------------------

test("auto: hung native discovery times out and the LLM gets a fresh window", async () => {
	const h = harness("auto", { discover: () => never() });
	const started = Date.now();
	const r = await h.service.judge(REQ, { timeoutMs: 60 });
	assert.equal(r.stopReason, "stop", r.errorMessage ?? "");
	assert.equal(r.backend, "llm");
	assert.ok(Date.now() - started >= 55);
	assert.equal(h.calls.llm, 1);
});

test("auto: native deadline expiry gives the LLM its own inactivity window", async () => {
	let llmSignal: AbortSignal | undefined;
	const h = harness("auto", {
		classify: () => never(),
		llm: async (options) => {
			llmSignal = options?.signal;
			await sleep(90); // longer than the native's 60ms total, healthy for idle
			return llmAnswer(true);
		},
	});
	const r = await h.service.judge(REQ, { timeoutMs: 120 });
	// LLM did not inherit the exhausted native deadline.
	assert.equal(r.stopReason, "stop", r.errorMessage ?? "");
	assert.equal(r.backend, "llm");
	assert.equal(llmSignal?.aborted, false);
});

test("auto-llm: stalled LLM fails over to one fresh absolute native deadline", async () => {
	const h = harness("auto-llm", {
		llm: (options) =>
			new Promise((_resolve, reject) =>
				options?.signal?.addEventListener("abort", () =>
					reject(new Error("aborted")),
				),
			),
	});
	const r = await h.service.judge(REQ, { timeoutMs: 50 });
	assert.equal(r.stopReason, "stop", r.errorMessage ?? "");
	assert.equal(r.backend, "classifier");
	assert.equal(h.calls.native, 1);
	const native = h.nativeTimeouts[0] ?? 0;
	assert.ok(native > 30 && native <= 50, `fresh native window: ${native}`);
});

test("defaults belong to each backend after failover", async () => {
	const h = harness("auto-llm", { llm: async () => llmError("HTTP 500") });
	await h.service.judge(REQ);
	const native = h.nativeTimeouts[0] ?? 0;
	assert.ok(native > 59_000 && native <= 60_000, `native default: ${native}`);
});

test("auto-llm: continuously active LLM stream outlasts timeoutMs without failover", async () => {
	const h = harness("auto-llm", {
		llm: async (options) => {
			for (let i = 0; i < 7; i++) {
				await sleep(20); // total ~140ms >> the 60ms window
				options?.onProviderStreamEvent?.(
					{ type: "message_delta", delta: "x" },
					chat,
				);
			}
			return llmAnswer(true);
		},
	});
	const r = await h.service.judge(REQ, { timeoutMs: 60 });
	assert.equal(r.stopReason, "stop", r.errorMessage ?? "");
	assert.equal(r.backend, "llm");
	assert.deepEqual([h.calls.discover, h.calls.native], [0, 0]);
});

test("forced timeout stays terminal and is not restarted", async () => {
	const h = harness("classifier", { classify: () => never() });
	const r = await h.service.judge(REQ, { timeoutMs: 40 });
	assert.equal(r.stopReason, "error");
	assert.match(r.errorMessage ?? "", /timed out/);
	assert.deepEqual([h.calls.native, h.calls.llm], [1, 0]);
});

test("auto-llm: hung native-provider auth bounds both attempts, no leaks", async () => {
	const h = harness("auto-llm", {
		auth: async (id) =>
			id === "typesafe" ? never() : { auth: { apiKey: SECRET } },
		llm: async () => llmError("HTTP 500"),
	});
	const r = await h.service.judge(REQ, { timeoutMs: 80 });
	// Both waits stay bounded and the summary never leaks the resolved key.
	// NOTE: with a HEALTHY LLM the preferred attempt still awaits every
	// listed provider (known-key readiness) and can time out in setup;
	// that redaction-vs-liveness trade-off is reported to the owner, not
	// silently encoded here.
	assert.equal(r.stopReason, "error");
	assert.match(r.errorMessage ?? "", /both automatic backend attempts failed/);
	assert.equal(r.errorMessage?.includes(SECRET), false);
});

test("auto: hung irrelevant LLM auth does not consume the native attempt twice", async () => {
	const h = harness("auto", {
		auth: async (id) => (id === "llmco" ? never() : undefined),
		classify: async () => nativeFail(),
	});
	const started = Date.now();
	const r = await h.service.judge(REQ, { timeoutMs: 60 });
	assert.ok(Date.now() - started < 400, "every wait stays bounded");
	assert.equal(r.stopReason, "error");
	assert.equal(h.calls.llm, 0); // its own auth never settled: no dispatch
});

// ---------------------------------------------------------------------------
// 2.2 Retired attempts are fenced
// ---------------------------------------------------------------------------

test("a late preferred result cannot publish or replace the alternate result", async () => {
	let releaseNative!: (r: ClassifierResult) => void;
	let nativeSignal: AbortSignal | undefined;
	let gated = true;
	const h = harness("auto", {
		classify: (_c, options) => {
			nativeSignal = options?.signal;
			if (!gated) return Promise.resolve(nativeOk());
			return new Promise((resolve) => {
				releaseNative = resolve;
			});
		},
		llm: async () => llmAnswer(false),
	});
	const r = await h.service.judge(REQ, { timeoutMs: 40 });
	assert.equal(r.backend, "llm");
	assert.equal(r.stopReason, "stop");
	assert.equal(nativeSignal?.aborted, true);
	releaseNative(nativeOk(0.99));
	await sleep(10);
	const rows = judgments(h.rows);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].backend, "llm");
	// Same service, native identity: the late result cached nothing, so the
	// classifier dispatches fresh instead of hitting a poisoned entry.
	gated = false;
	h.config.mode = "classifier";
	const next = await h.service.judge(REQ);
	assert.equal(next.backend, "classifier");
	assert.equal(next.reuse.hits, 0);
	assert.equal(h.calls.native, 2);
});

// ---------------------------------------------------------------------------
// 2.3 Full logical restart, own capacity/policy, identity-exact reuse
// ---------------------------------------------------------------------------

test("partial primary answers are not spliced into the alternate result", async () => {
	const h = harness("auto", {
		classify: async (context) =>
			Object.keys(context.questions).length > 1
				? nativeFail("context_length_exceeded")
				: Object.hasOwn(context.questions, "a")
					? {
							...nativeOk(),
							answers: { a: { type: "bool", probability: 0.9 } },
						}
					: nativeFail("native 500"),
		llm: async () => llmAnswer(false),
	});
	const r = await h.service.judge({ state: {}, questions: { a: Q, b: Q } });
	assert.equal(r.stopReason, "stop", r.errorMessage ?? "");
	assert.equal(r.backend, "llm");
	assert.deepEqual(Object.keys(r.answers).sort(), ["a", "b"]);
	for (const id of ["a", "b"])
		assert.equal((r.answers[id] as { probability: number }).probability, 0);
	assert.equal(r.capacity?.backend, "llm");
	assert.equal(h.calls.llm, 2); // complete logical request: both questions
});

test("confidence policy follows the answering backend", async () => {
	const toLlm = harness("auto", { classify: async () => nativeFail() });
	const r1 = await toLlm.service.judge(REQ, { minConfidence: 0.99 });
	assert.equal(r1.backend, "llm");
	assert.deepEqual(r1.dropped, []);
	const toNative = harness("auto-llm", {
		llm: async () => llmError("HTTP 500"),
		classify: async () => nativeOk(0.6),
	});
	const r2 = await toNative.service.judge(REQ, { minConfidence: 0.99 });
	assert.equal(r2.backend, "classifier");
	assert.deepEqual(r2.dropped, ["q"]);
});

test("alternate reuses its own cached judgment but never the primary's", async () => {
	let nativeUp = true;
	const h = harness("auto", {
		classify: async () => (nativeUp ? nativeOk() : nativeFail()),
	});
	await h.service.judge(REQ); // native judgment cached
	h.config.mode = "llm";
	await h.service.judge(REQ); // llm judgment cached under its identity
	h.config.mode = "auto";
	nativeUp = false;
	const fresh = { state: { x: 9 }, questions: { q: Q } };
	await h.service.judge(fresh); // native fails, LLM answers (1 LLM call)
	const llmBefore = h.calls.llm;
	// Same exact request: native identity now cached? No: failed attempt left
	// nothing; the classifier is redispatched and fails, the LLM cache hits.
	const r = await h.service.judge(fresh);
	assert.equal(r.backend, "llm");
	assert.equal(r.reuse.hits, 1);
	assert.equal(h.calls.llm, llmBefore);
	assert.equal(
		judgments(h.rows).filter((j) => j.backend === "classifier").length,
		1,
	);
});

test("a settings save during failover keeps the admitted alternate", async () => {
	const h = harness("auto", {
		classify: async () => {
			h.config.provider = "other";
			h.config.modelId = "elsewhere";
			h.config.mode = "classifier";
			return nativeFail();
		},
	});
	const r = await h.service.judge(REQ);
	assert.equal(r.backend, "llm");
	assert.equal(r.model, "llmco/chat");
});

test("larger alternate capacity is used instead of the primary's limit", async () => {
	const h = harness(
		"auto",
		{ classify: async () => nativeFail("context_length_exceeded") },
		{ contextLimits: { "typesafe/jev-1.13": { request: 10 } } },
	);
	const r = await h.service.judge(REQ);
	assert.equal(r.backend, "llm");
	assert.equal(r.capacity?.limits.contextWindow, 100000);
});

test("smaller alternate that cannot fit ends with a structured error", async () => {
	const h = harness("auto-llm", {
		llm: async () => llmError("HTTP 500"),
		classify: async () => nativeFail("context_length_exceeded"),
	});
	const r = await h.service.judge(REQ);
	assert.equal(r.stopReason, "error");
	assert.deepEqual(r.answers, {});
	assert.match(r.errorMessage ?? "", /context overflow/);
	assert.deepEqual([h.calls.llm, h.calls.native], [1, 1]); // never cycles back
});

/** Native review fixture: observable fetch through Pi's public option. */
function observableNative(fail: () => boolean) {
	const counts = { native: 0, llm: 0 };
	const rows: LedgerRecord[] = [];
	const nativeFetch: typeof globalThis.fetch = async (_url, init) => {
		const ctx = JSON.parse(String(init?.body));
		return fail()
			? Response.json({ error: { code: "server_error" } }, { status: 503 })
			: Response.json({
					answers: Object.fromEntries(
						Object.keys(ctx.questions).map((id) => [
							id,
							{ type: "noul", noul: 0.9 },
						]),
					),
				});
	};
	const registry = {
		getProviders: () => [],
		getAuth: async () => undefined,
		getModel: (p: string, id: string) =>
			p === chat.provider && id === chat.id ? chat : undefined,
		getAvailableOfType: async () => [jev],
		classify: async (
			_m: unknown,
			context: Context,
			options: ClassifyOptions,
		) => {
			counts.native++;
			const http = await (options?.fetch ?? nativeFetch)(
				"https://native.invalid/systemone",
				{
					method: "POST",
					body: JSON.stringify(context),
					signal: options?.signal,
				},
			);
			if (!http.ok) return { ...nativeFail("server_error"), answers: {} };
			await http.json();
			return nativeOk();
		},
		streamSimple: () => {
			counts.llm++;
			return { result: async () => llmAnswer(true) };
		},
	} as unknown as ServiceRegistry;
	const config: JudgmentConfig = {
		mode: "auto",
		thinkingLevel: "off",
		model: "llmco/chat",
		provider: "llmco",
		modelId: "chat",
	};
	const service = createJudgmentService({
		registry,
		nativeFetch,
		config: () => config,
		ledger: { append: (_t, row) => rows.push(row), branch: () => [] },
	});
	return { service, counts, rows };
}

test("review: checkpoint-seeded review ends with resubmit error, no alternate", async () => {
	let failing = false;
	const h = observableNative(() => failing);
	const request: JudgeRequest = {
		...REQ,
		evidence: [{ id: "e1", text: "first findings" }],
	};
	const first = await h.service.review(request);
	assert.equal(first.stopReason, "stop", first.errorMessage ?? "");
	const seed = first.progress.stages.at(-1)?.checkpoint;
	assert.ok(seed && first.progress.stages.at(-1)?.durable);
	failing = true;
	const seeded = await h.service.review(
		{ ...REQ, evidence: [{ id: "e2", text: "new findings" }] },
		{ checkpoint: seed },
	);
	assert.equal(seeded.stopReason, "error");
	assert.deepEqual(seeded.answers, {});
	assert.match(
		seeded.errorMessage ?? "",
		/checkpoint-seeded review cannot fail over: resubmit the complete input without checkpoint/,
	);
	assert.equal(h.counts.llm, 0); // alternate never dispatched
	// The native failure itself is still in the review diagnostics.
	assert.ok(seeded.diagnostics.attemptCount >= 1);
});

test("review: failed native attempts stay in diagnostics after failover", async () => {
	const h = observableNative(() => true);
	const r = await h.service.review(REQ);
	// The fake LLM has no observable HTTP/SSE transport, so the alternate
	// fails honestly; both attempts are reported and nothing is spliced.
	assert.equal(h.counts.native, 1);
	assert.equal(h.counts.llm, 1);
	assert.equal(r.stopReason, "error");
	assert.deepEqual(r.answers, {});
	assert.ok(r.diagnostics.attemptCount >= 1);
	assert.equal(r.diagnostics.attempts[0]?.ordinal, 1); // native attempt retained
	assert.equal(r.diagnostics.observationCoverage, "unavailable");
	assert.match(r.errorMessage ?? "", /both automatic backend attempts failed/);
	assert.match(r.errorMessage ?? "", /native review/);
});

// ---------------------------------------------------------------------------
// 2.4 Joined waiters keep independent lifetimes
// ---------------------------------------------------------------------------

test("a cancelled owner does not cancel or abort a live joined caller", async () => {
	let firstNative = true;
	const ownerAbort = new AbortController();
	const h = harness("auto", {
		classify: (_c, options) => {
			if (!firstNative) return Promise.resolve(nativeOk());
			firstNative = false;
			return new Promise((resolve) =>
				options?.signal?.addEventListener("abort", () =>
					resolve({ ...nativeFail(), stopReason: "aborted" }),
				),
			);
		},
	});
	const owner = h.service.judge(REQ, { signal: ownerAbort.signal });
	await sleep(5);
	const joiner = h.service.judge(REQ);
	await sleep(5);
	ownerAbort.abort();
	assert.equal((await owner).stopReason, "aborted");
	const joined = await joiner;
	assert.equal(joined.stopReason, "stop", joined.errorMessage ?? "");
	// Joiner kept its failover eligibility: it switched to the LLM once.
	assert.equal(joined.backend, "llm");
	assert.equal(h.calls.llm, 1);
});

test("a cancelled joiner returns aborted without starting its alternate", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const h = harness("auto", {
		classify: async () => {
			await gate;
			return nativeOk();
		},
	});
	const owner = h.service.judge(REQ);
	await sleep(5);
	const joinAbort = new AbortController();
	const joiner = h.service.judge(REQ, { signal: joinAbort.signal });
	await sleep(5);
	joinAbort.abort();
	assert.equal((await joiner).stopReason, "aborted");
	release();
	const ownerResult = await owner;
	assert.equal(ownerResult.stopReason, "stop");
	assert.equal(ownerResult.backend, "classifier");
	assert.deepEqual([h.calls.native, h.calls.llm], [1, 0]);
});

// ---------------------------------------------------------------------------
// 2.5 Terminal-attempt assembly and review diagnostics across attempts
// ---------------------------------------------------------------------------

test("success after failover reports only the terminal attempt", async () => {
	const h = harness("auto", { classify: async () => nativeFail() });
	const r = await h.service.judge(REQ);
	assert.equal(r.backend, "llm");
	assert.equal(r.model, "llmco/chat");
	assert.equal(r.errorMessage, undefined);
	assert.equal(r.capacity?.backend, "llm");
	assert.equal(r.inputDimensions?.length, 1); // LLM dispatch only
	const diag = h.rows.filter((row) => row.kind === "diag");
	assert.deepEqual(
		diag.map((row) => (row as { backend: string }).backend),
		["classifier", "llm"],
	);
});
