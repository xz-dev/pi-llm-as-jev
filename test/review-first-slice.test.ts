/**
 * Review lifecycle unit tests through a scripted public fetch/classify port.
 * These fixtures do not implement cache, subdivision or recovery. Actual Pi
 * transport evidence lives in the source-linked audit suites and host smoke.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { JudgeRequest } from "../client/judgment-client.ts";
import { validateConfig } from "../src/config.ts";
import { LEDGER_TYPE, type LedgerRecord } from "../src/ledger.ts";
import { createJudgmentService, type ServiceRegistry } from "../src/service.ts";

type AnyClassifierModel = Parameters<ServiceRegistry["classify"]>[0];
type NativeResult = Awaited<ReturnType<ServiceRegistry["classify"]>>;
type WireContext = {
	state: Record<string, unknown>;
	questions: Record<string, unknown>;
};
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
const answered = (ids: string[]): NativeResult => ({
	api: model.api,
	provider: model.provider,
	model: model.id,
	answers: Object.fromEntries(
		ids.map((id) => [id, { type: "bool" as const, probability: 0.9 }]),
	),
	stopReason: "stop",
	timestamp: Date.now(),
});
const response = (ids: string[], usage?: Record<string, number>) =>
	Response.json({
		answers: Object.fromEntries(
			ids.map((id) => [id, { type: "noul", noul: 0.9 }]),
		),
		...(usage ? { usage } : {}),
	});

function harness(setup: {
	reply?: (context: WireContext) => Response | Promise<Response>;
	ignoreFetch?: boolean;
	api?: AnyClassifierModel["api"];
	onAppend?: (row: LedgerRecord) => void;
}) {
	const config = validateConfig({
		mode: "classifier",
		classifierModel: "native/kev",
		timeoutMs: 1000,
	}).config;
	const rows: LedgerRecord[] = [];
	let branch: unknown[] = [];
	const nativeFetch: typeof globalThis.fetch = async (url, init) => {
		assert.equal(String(url), "https://fixture.invalid/systemone");
		return setup.reply?.(JSON.parse(String(init?.body))) ?? response([]);
	};
	const registry: ServiceRegistry = {
		getAvailableOfType: async () => [{ ...model, api: setup.api ?? model.api }],
		getModel: () => undefined,
		getAuth: async () => undefined,
		getProviders: () => [],
		classify: async (_model, context, options) => {
			assert.equal(Object.hasOwn(options ?? {}, "observe"), false);
			assert.equal(Object.hasOwn(options ?? {}, "onAttempt"), false);
			const ids = Object.keys(context.questions);
			if (setup.ignoreFetch)
				return {
					...answered(ids),
					observation: { version: 1, attempts: 0, partialAnswers: {} },
				} as NativeResult;
			const request = {
				...context,
				questions: Object.fromEntries(
					Object.entries(context.questions).map(([id, question]) => [
						id,
						question.type === "bool" ? { ...question, type: "noul" } : question,
					]),
				),
			};
			const http = await (options?.fetch ?? nativeFetch)(
				"https://fixture.invalid/systemone",
				{
					method: "POST",
					body: JSON.stringify(request),
					signal: options?.signal,
				},
			);
			if (!http.ok) {
				const body = JSON.parse(await http.text());
				return {
					...answered([]),
					stopReason: "error",
					errorMessage: String(body.error?.code ?? "provider error"),
				};
			}
			const body = await http.json();
			const complete = ids.every((id) => Object.hasOwn(body.answers ?? {}, id));
			return complete
				? answered(ids)
				: {
						...answered([]),
						stopReason: "error",
						errorMessage: "missing answer",
					};
		},
		streamSimple: () => {
			throw new Error("offline native fixture must not stream");
		},
	};
	const service = createJudgmentService({
		registry,
		nativeFetch,
		config: () => config,
		ledger: {
			append: (_type, row) => {
				setup.onAppend?.(row);
				rows.push(row);
			},
			branch: () => branch,
		},
	});
	return {
		service,
		rows,
		setBranch: (entries: unknown[]) => {
			branch = entries;
		},
	};
}

const evidence = (id: string) => ({ id, text: `${id} recorded findings` });
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
	const h = harness({ reply: (ctx) => response(Object.keys(ctx.questions)) });
	assert.equal(h.service.version, 1);
	assert.equal(h.service.reviewVersion, 1);
	assert.equal(typeof h.service.judge, "function");
	assert.equal(typeof h.service.review, "function");
});

test("review: failed stage returns empty final answers, keeps durable committed stages, reload sends only unresolved", async () => {
	let failThird = true;
	const requests: string[][] = [];
	const h = harness({
		reply: (ctx) => {
			const frames =
				(ctx.state as { evidence?: { id: string }[] }).evidence ?? [];
			const idsSeen = frames.map((e) => e.id);
			requests.push(idsSeen);
			if (idsSeen.length > 1)
				return Response.json(
					{ error: { code: "context_length_exceeded" } },
					{ status: 400 },
				);
			if (failThird && idsSeen.some((id) => id.startsWith("stage-three")))
				return Response.json(
					{ error: { code: "invalid_payload" }, usage: { input_tokens: 7 } },
					{ status: 400 },
				);
			return response(Object.keys(ctx.questions), {
				input_tokens: 10,
				output_tokens: 2,
			});
		},
	});
	const first = await h.service.review(threeStageRequest());
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
		reply: (ctx) => {
			calls++;
			return response(Object.keys(ctx.questions), { input_tokens: 10 });
		},
	});
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
	assert.equal(result.diagnostics.attemptCount, 1);
	assert.notEqual(result.reuse.sent, result.diagnostics.attemptCount);
});

for (const status of [200, 400]) {
	for (const envelope of [
		"direct-failed",
		"nested-failed",
		"failed-state",
		"running-state",
	]) {
		for (const input of [17, undefined]) {
			test(`review: Cloudflare ${envelope} HTTP ${status} retains metering (${input}) without answers or coverage`, async () => {
				let calls = 0;
				const h = harness({
					api: "cloudflare-workers-ai-system-one",
					reply: () => {
						calls++;
						const payload = {
							model: "jev-reported",
							answers: { q: { type: "noul", noul: 0.9 } },
							usage: { input_tokens: input, output_tokens: 0, cost: 0.004 },
						};
						return Response.json(
							{
								success:
									envelope === "failed-state" || envelope === "running-state",
								result:
									envelope === "direct-failed"
										? payload
										: {
												state:
													envelope === "running-state" ? "Running" : "Failed",
												result: payload,
											},
								errors: [{ code: "invalid_request" }],
							},
							{ status },
						);
					},
				});
				const request = { state: {}, questions: { q } };
				const result = await h.service.review(request);
				assert.equal(result.stopReason, "error");
				assert.deepEqual(result.answers, {});
				assert.deepEqual(result.unresolved, ["q"]);
				assert.deepEqual(result.progress.stages, []);
				assert.equal(result.diagnostics.attemptCount, 1);
				assert.deepEqual(result.diagnostics.usage.inputTokens, {
					knownSum: input ?? 0,
					missing: input === undefined ? 1 : 0,
				});
				assert.deepEqual(result.diagnostics.usage.outputTokens, {
					knownSum: 0,
					missing: 0,
				});
				assert.deepEqual(result.diagnostics.usage.costUsd, {
					knownSum: 0.004,
					missing: 0,
				});
				const row = h.rows.find(
					(row) => row.kind === "review-attempt" && row.attempt.phase === "end",
				);
				assert.ok(row?.kind === "review-attempt");
				assert.equal(row.attempt.model, "jev-reported");
				assert.equal(row.attempt.inputTokens, input);
				assert.equal(row.attempt.outputTokens, 0);
				assert.equal(row.attempt.costUsd, 0.004);
				assert.ok(!h.rows.some((row) => row.kind === "review-stage"));
				h.setBranch(
					h.rows.map((data) => ({
						type: "custom",
						customType: LEDGER_TYPE,
						data,
					})),
				);
				h.service.refreshBranch();
				const repeated = await h.service.review(request);
				assert.equal(repeated.reuse.hits, 0);
				assert.deepEqual(repeated.answers, {});
				assert.equal(
					calls,
					2,
					"failed-envelope answers cannot become cached raw judgments",
				);
			});
		}
	}
}

test("review: adapter ignoring public fetch fails explicitly with no fake counts", async () => {
	const h = harness({ ignoreFetch: true });
	const result = await h.service.review({ state: {}, questions: { q } });
	assert.equal(result.stopReason, "error");
	assert.deepEqual(result.answers, {});
	assert.match(result.errorMessage ?? "", /observable|fetch/i);
	assert.equal(result.diagnostics.attemptCount, 0);
	assert.deepEqual(result.diagnostics.attempts, []);
	assert.equal(result.diagnostics.observationCoverage, "unavailable");
});

test("review: stage append failure is not acknowledged as durable progress", async () => {
	const h = harness({
		reply: (ctx) => response(Object.keys(ctx.questions)),
		onAppend: (row) => {
			if (row.kind === "review-stage") throw new Error("append denied");
		},
	});
	const result = await h.service.review(threeStageRequest());
	assert.ok(
		result.progress.stages.length > 0,
		"the completed stage is visible but volatile",
	);
	assert.ok(result.progress.stages.every((stage) => stage.durable !== true));
});

test("review: legacy judge keeps final-only answers and records no stage progress", async () => {
	let calls = 0;
	const h = harness({
		reply: (ctx) => {
			const frames = (ctx.state as { evidence?: unknown[] }).evidence ?? [];
			if (frames.length > 1)
				return Response.json(
					{ error: { code: "context_length_exceeded" } },
					{ status: 400 },
				);
			calls++;
			return response(Object.keys(ctx.questions));
		},
	});
	const result = await h.service.judge(threeStageRequest());
	assert.equal(calls, 3, "judge runs its existing ordered stages");
	assert.equal(result.stopReason, "stop");
	assert.ok(!("progress" in result) || result.progress === undefined);
	assert.ok(!h.rows.some((row) => row.kind === "review-stage"));
});
