/**
 * Focused first-slice regressions for the additive native review path
 * (`reviewVersion: 1` / `review()`), tasks 1.1/1.2/2.1/2.2/3.3 (slice):
 * two evidence stages succeed, the third fails; a same-branch reload
 * processes only unresolved work; a failed review returns empty final
 * answers; honest attempt diagnostics come from the adapter's actual
 * observation contract (start/end + result.observation), with per-field
 * missing usage kept unknown; durable stage checkpoints are acknowledged
 * only after validated answer writes; legacy `judge` stays unchanged.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
	ClassifierAnswer,
	JudgeRequest,
} from "../client/judgment-client.ts";
import { validateConfig } from "../src/config.ts";
import { LEDGER_TYPE, type LedgerRecord } from "../src/ledger.ts";
import { createJudgmentService, type ServiceRegistry } from "../src/service.ts";

type AnyClassifierModel = Parameters<ServiceRegistry["classify"]>[0];
type NativeResult = Awaited<ReturnType<ServiceRegistry["classify"]>>;

const q = {
	type: "bool" as const,
	instructions: "condition?",
	criteria: { true: "yes", false: "no" },
};
const model: AnyClassifierModel = {
	type: "classifier",
	provider: "native",
	id: "kev",
	name: "offline",
	api: "typesafe-system-one",
	baseUrl: "https://fixture.invalid",
	input: ["text"],
	contextWindow: 100000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const ans: ClassifierAnswer = { type: "bool", probability: 0.9 };

/** Shape mirroring the verified Pi observation contract (types.ts v1). */
interface ObservedNativeResult extends NativeResult {
	observation?: {
		version: 1;
		attempts: number;
		partialAnswers: Record<string, ClassifierAnswer>;
		unresolved: string[];
	};
}

interface AttemptEvent {
	version: 1;
	phase: "start" | "end";
	attempt: number;
	outcome?: "response" | "network" | "timeout" | "aborted";
	status?: number;
	model?: string;
	inputTokensPresent?: boolean;
	outputTokensPresent?: boolean;
	costUsdPresent?: boolean;
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
	errorCategory?: string;
	complete?: boolean;
	partialAnswers?: Record<string, ClassifierAnswer>;
	unresolved?: string[];
}

/**
 * Harness with a scriptable classify that emulates the patched Pi adapter:
 * forwards observe/onAttempt through a request-owned collector and returns
 * result.observation. `review()` must consume BOTH.
 */
function harness(setup: {
	classify: (
		model: AnyClassifierModel,
		context: {
			state: Record<string, unknown>;
			questions: Record<string, unknown>;
		},
		options: { onAttempt?: (event: AttemptEvent) => void; observe?: true },
	) => Promise<ObservedNativeResult>;
}) {
	const config = validateConfig({
		mode: "classifier",
		classifierModel: "native/kev",
		timeoutMs: 1000,
	}).config;
	const rows: LedgerRecord[] = [];
	const events: AttemptEvent[] = [];
	let branch: unknown[] = [];
	const registry: ServiceRegistry = {
		getAvailableOfType: async () => [model],
		getModel: () => undefined,
		getAuth: async () => undefined,
		getProviders: () => [],
		// The review path must pass observe/onAttempt through to the adapter
		// (options the structural registry type does not know about).
		classify: async (m, ctx, options) =>
			(await setup.classify(
				m as never,
				ctx as never,
				options as never,
			)) as never,
		streamSimple: () => {
			throw new Error("offline native fixture must not stream");
		},
	};
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: { append: (_t, row) => rows.push(row), branch: () => branch },
	});
	return {
		service,
		events,
		rows,
		setBranch: (entries: unknown[]) => {
			branch = entries;
		},
	};
}

const evidence = (id: string): { id: string; text: string } => ({
	id,
	text: `${id} recorded findings`,
});

const answered = (
	ids: string[],
	extra: Partial<ObservedNativeResult> = {},
): ObservedNativeResult => ({
	api: model.api,
	provider: model.provider,
	model: model.id,
	answers: Object.fromEntries(ids.map((id) => [id, ans])),
	stopReason: "stop",
	timestamp: Date.now(),
	observation: { version: 1, attempts: 1, partialAnswers: {}, unresolved: [] },
	...extra,
});

/** Build a three-stage request where the third stage fails once. */
function threeStageRequest(): JudgeRequest {
	return {
		state: { task: "parser" },
		questions: { q },
		evidence: [
			evidence("stage-one"),
			evidence("stage-two"),
			evidence("stage-three"),
		],
	};
}

test("review: discovery is separately visible and judge keeps version 1 behavior", async () => {
	const h = harness({
		classify: async (_m, ctx) => {
			const ids = Object.keys(ctx.questions);
			return answered(ids);
		},
	});
	const service = h.service as unknown as {
		version: number;
		reviewVersion?: number;
		judge: unknown;
		review: unknown;
	};
	assert.equal(service.version, 1);
	assert.equal(service.reviewVersion, 1);
	assert.equal(typeof service.judge, "function");
	assert.equal(typeof service.review, "function");
});

test("review: failed stage returns empty final answers, keeps durable committed stages, reload sends only unresolved", async () => {
	let failThird = true;
	const requests: string[][] = [];
	const h = harness({
		classify: async (_m, ctx, options) => {
			const ids = Object.keys(ctx.questions);
			const evidence =
				(ctx.state as { evidence?: { id: string }[] }).evidence ?? [];
			const idsSeen = evidence.map((e) => e.id);
			requests.push(idsSeen);
			if (idsSeen.length > 1) {
				options.onAttempt?.({ version: 1, phase: "start", attempt: 1 });
				options.onAttempt?.({
					version: 1,
					phase: "end",
					attempt: 1,
					outcome: "response",
					status: 400,
					errorCategory: "overflow",
				});
				return answered([], {
					stopReason: "error",
					errorMessage: "context_length_exceeded",
				});
			}
			const third = idsSeen.some((id) => id.startsWith("stage-three"));
			if (failThird && third) {
				options.onAttempt?.({ version: 1, phase: "start", attempt: 1 });
				options.onAttempt?.({
					version: 1,
					phase: "end",
					attempt: 1,
					outcome: "response",
					status: 400,
					inputTokensPresent: true,
					outputTokensPresent: false,
					costUsdPresent: false,
					inputTokens: 7,
					errorCategory: "validation",
					complete: false,
					partialAnswers: {},
					unresolved: ids,
				});
				return {
					api: model.api,
					provider: model.provider,
					model: model.id,
					answers: {},
					stopReason: "error" as const,
					errorMessage:
						'System One API error (400): {"error":{"code":"invalid_payload"}}',
					timestamp: Date.now(),
					observation: {
						version: 1,
						attempts: 1,
						partialAnswers: {},
						unresolved: ids,
					},
				};
			}
			options.onAttempt?.({ version: 1, phase: "start", attempt: 1 });
			options.onAttempt?.({
				version: 1,
				phase: "end",
				attempt: 1,
				outcome: "response",
				status: 200,
				inputTokensPresent: true,
				outputTokensPresent: true,
				costUsdPresent: false,
				inputTokens: 10,
				outputTokens: 2,
				complete: true,
				partialAnswers: Object.fromEntries(ids.map((id) => [id, ans])),
				unresolved: [],
			});
			return answered(ids);
		},
	});
	const first = await h.service.review(threeStageRequest());
	// Explicit provider overflow creates stages; the service must not impose record quotas.
	assert.equal(first.stopReason, "error");
	assert.deepEqual(first.answers, {});
	assert.ok(
		first.progress.stages.length >= 2,
		"two stages committed before the third failed",
	);
	assert.equal(first.progress.stages.at(-1)?.evidenceIds.at(-1), "stage-two");
	assert.equal(
		first.diagnostics.attempts.length,
		first.diagnostics.attemptCount,
	);
	assert.ok(first.diagnostics.attemptCount >= 3);

	// Reload: durable progress restored from the branch; only stage-three dispatches.
	h.setBranch(
		h.rows.map((data) => ({ type: "custom", customType: LEDGER_TYPE, data })),
	);
	h.service.refreshBranch();
	const before = requests.length;
	failThird = false;
	const resumed = await h.service.review(threeStageRequest());
	assert.equal(resumed.stopReason, "stop");
	assert.deepEqual(Object.keys(resumed.answers), ["q"]);
	const after = requests.slice(before);
	assert.equal(
		after.length,
		1,
		"only the unresolved stage dispatches after reload",
	);
	assert.ok(after[0].some((id) => id.startsWith("stage-three")));
	assert.ok(
		after.every(
			(list) =>
				!list.some(
					(id) => id.startsWith("stage-one") || id.startsWith("stage-two"),
				),
		),
	);
});

test("review: diagnostics report actual attempts with per-field known sums and missing counts", async () => {
	let calls = 0;
	const h = harness({
		classify: async (_m, ctx, options) => {
			calls++;
			const ids = Object.keys(ctx.questions);
			options.onAttempt?.({ version: 1, phase: "start", attempt: 1 });
			options.onAttempt?.({
				version: 1,
				phase: "end",
				attempt: 1,
				outcome: "response",
				status: 200,
				inputTokensPresent: true,
				outputTokensPresent: false,
				costUsdPresent: false,
				inputTokens: 10,
				complete: true,
				partialAnswers: Object.fromEntries(ids.map((id) => [id, ans])),
				unresolved: [],
			});
			return answered(ids);
		},
	});
	// Two questions in one batch distinguish question sends from transport attempts.
	const result = await h.service.review({
		state: {},
		questions: { q, second: q },
	});
	assert.equal(calls, 1);
	const usage = result.diagnostics.usage;
	assert.equal(usage.inputTokens.knownSum, 10);
	assert.equal(usage.inputTokens.missing, 0);
	assert.equal(
		usage.outputTokens.missing,
		1,
		"absent output stays unknown, not zero",
	);
	assert.equal(usage.outputTokens.knownSum, 0);
	assert.equal(usage.costUsd.missing, 1);
	// reuse.sent counts questions, never transport attempts.
	assert.equal(result.diagnostics.attemptCount, 1);
	assert.notEqual(result.reuse.sent, result.diagnostics.attemptCount);
});

test("review: adapter without observation support fails explicitly with no fake counts", async () => {
	const h = harness({
		classify: async (_m, ctx) => {
			const ids = Object.keys(ctx.questions);
			// Unpatched adapter: no observation, no onAttempt acknowledgement.
			const { observation: _drop, ...rest } = answered(ids);
			void _drop;
			return rest as ObservedNativeResult;
		},
	});
	const result = await h.service.review({ state: {}, questions: { q } });
	assert.equal(result.stopReason, "error");
	assert.deepEqual(result.answers, {});
	assert.match(result.errorMessage ?? "", /observation|capabilit/i);
	assert.equal(result.diagnostics.attemptCount, 0);
	assert.deepEqual(result.diagnostics.attempts, []);
	assert.equal(result.diagnostics.observationCoverage, "unavailable");
});

test("review: stage append failure is not acknowledged as durable progress", async () => {
	let appendFails = false;
	const config = validateConfig({
		mode: "classifier",
		classifierModel: "native/kev",
		timeoutMs: 1000,
	}).config;
	const rows: LedgerRecord[] = [];
	const registry: ServiceRegistry = {
		getAvailableOfType: async () => [model],
		getModel: () => undefined,
		getAuth: async () => undefined,
		getProviders: () => [],
		classify: async (_m, ctx, options) => {
			const ids = Object.keys(ctx.questions);
			const observer = (
				options as unknown as { onAttempt?: (e: AttemptEvent) => void }
			).onAttempt;
			observer?.({ version: 1, phase: "start", attempt: 1 });
			observer?.({
				version: 1,
				phase: "end",
				attempt: 1,
				outcome: "response",
				status: 200,
			});
			return answered(ids) as never;
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
	const service = createJudgmentService({
		registry,
		config: () => config,
		ledger: {
			append: (_t, row) => {
				if (appendFails && row.kind === "review-stage")
					throw new Error("append denied");
				rows.push(row);
			},
			branch: () => [],
		},
	});
	appendFails = true;
	const result = await service.review(threeStageRequest());
	// No stage may be published as durable when its checkpoint append failed.
	assert.ok(
		result.progress.stages.length > 0,
		"the completed stage is visible but volatile",
	);
	assert.ok(result.progress.stages.every((s) => s.durable !== true));
});

test("review: legacy judge keeps final-only answers and records no stage progress", async () => {
	let calls = 0;
	const h = harness({
		classify: async (_m, ctx) => {
			const frames = (ctx.state as { evidence?: unknown[] }).evidence ?? [];
			if (frames.length > 1)
				return answered([], {
					stopReason: "error",
					errorMessage: "context_length_exceeded",
				});
			calls++;
			const ids = Object.keys(ctx.questions);
			return answered(ids);
		},
	});
	const result = await h.service.judge(threeStageRequest());
	assert.equal(calls, 3, "judge runs its existing ordered stages");
	assert.equal(result.stopReason, "stop");
	assert.ok(!("progress" in result) || result.progress === undefined);
	assert.ok(!h.rows.some((r) => r.kind === "review-stage"));
});
