/**
 * Judgment service assembly (task 5.3, 4.6, 4.7). Owns backend selection
 * (auto|classifier|llm), the exact-match raw cache, capacity-aware question and
 * ordered-evidence subdivision with Unicode-safe fragments, Jev threshold
 * policy, known-key redaction, session-generation/cancellation isolation and
 * ledger persistence. `judge()` NEVER throws: every failure resolves through
 * `stopReason`/`errorMessage`.
 */

import { randomUUID } from "node:crypto";
import type {
	Api,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierQuestion,
	ClassifierResult,
	Model,
} from "@earendil-works/pi-ai";
import type {
	ClassifierAnswer,
	JsonObject,
	JsonValue,
	JudgeOptions,
	JudgeRequest,
	JudgeResult,
	JudgmentService,
	ReviewAttemptObservation,
	ReviewDiagnostics,
	ReviewOptions,
	ReviewResult,
	ReviewService,
	ReviewStageProgress,
	ReviewStageProjection,
	ThresholdRule,
	Usage,
} from "../client/judgment-client.ts";
import {
	classifyWithModel,
	type JevRegistry,
	type NativeSelection,
	resolveNativeClassifier,
} from "./backend-jev.js";
import {
	effectiveThinkingLevel,
	type LlmRegistry,
	llmClassify,
} from "./backend-llm.js";
import {
	freshEligible,
	freshTokenKey,
	judgmentKey,
	newCache,
	noteFresh,
	type PendingJudgment,
	pendingKey,
	type RawJudgmentCache,
	settlePending,
	trackPending,
} from "./cache.js";
import {
	type CapacityConstraint,
	type CapacityLimits,
	type CapacityProfile,
	channelKey,
	digest,
	LLM_ENVELOPE_OVERHEAD_BYTES,
	newCapacityProfile,
	observe as observeCapacity,
	overflowConstraint,
} from "./capacity.js";
import type { JudgmentConfig, JudgmentThinkingLevel } from "./config.js";
import {
	type LedgerRecord,
	type ReviewStageRecord,
	restoreLedger,
	writeLedger,
} from "./ledger.js";
import { observeLlmRegistry } from "./llm-observations.js";
import {
	type FramedEvidence,
	framedEvidenceBytes,
	frameEvidence,
	isContextOverflow,
	sizeOf,
	splitPiece,
	splitQuestions,
	toModelEvidence,
} from "./pipeline.js";
import { accepted, type ThresholdPolicy, validateAnswer } from "./policy.js";
import {
	type AuthResolvingRegistry,
	redactJson,
	redactString,
} from "./redaction.js";
import {
	collectAttempts,
	diagnostics,
	emptyDiagnostics,
} from "./review-observations.js";

type AnyModel = Model<Api>;
type AnyClassifierModel = ClassifierModel<ClassifierApi>;

/** Registry slice the service consumes (jev + llm + model lookup). */
export interface ServiceRegistry
	extends JevRegistry,
		LlmRegistry,
		AuthResolvingRegistry {
	getModel(provider: string, id: string): AnyModel | undefined;
	getAvailableOfType(
		type: "classifier",
		providerId?: string,
		options?: { signal?: AbortSignal },
	): Promise<readonly AnyClassifierModel[]>;
}

export interface LedgerHooks {
	/** Two-argument pi.appendEntry(customType, data). */
	append: ((type: string, data: LedgerRecord) => void) | undefined;
	/** Active-branch entries for restore (lifecycle navigation only). */
	branch: () => Iterable<unknown> | undefined;
}

export interface ServiceRuntime {
	registry: ServiceRegistry;
	config: () => JudgmentConfig;
	ledger: LedgerHooks;
	/** Optional embedding transport, forwarded through Pi's public native fetch option. */
	nativeFetch?: typeof globalThis.fetch;
	/** Fresh secrets snapshot; recomputed lazily by the lifecycle hook. */
	secrets?: () => readonly string[];
}

/** Error thrown internally for invalid requests; converted to a result, never surfaced. */
class InvalidRequestError extends Error {}
const DEADLINE_EXPIRED = Symbol("judgment deadline expired");

const resultShell = (
	backend: "classifier" | "llm",
	model: string,
): JudgeResult => ({
	answers: {},
	dropped: [],
	backend,
	model,
	stopReason: "stop",
	reuse: { hits: 0, joined: 0, sent: 0 },
});

const emptyUsage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function sumUsage(usages: Usage[]): Usage {
	const total = emptyUsage();
	for (const usage of usages) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		total.cost.input += usage.cost.input;
		total.cost.output += usage.cost.output;
		total.cost.cacheRead += usage.cost.cacheRead;
		total.cost.cacheWrite += usage.cost.cacheWrite;
		total.cost.total += usage.cost.total;
		if (usage.cacheWrite1h !== undefined)
			total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
		if (usage.reasoning !== undefined)
			total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	}
	return total;
}

/** Validate question definitions; returns a rejection message or undefined. */
function validateQuestion(id: string, q: unknown): string | undefined {
	if (q === null || typeof q !== "object")
		return `question "${id}" is not an object`;
	const question = q as Record<string, unknown>;
	if (question.type === "choice") {
		if (typeof question.instructions !== "string")
			return `choice question "${id}" lacks string instructions`;
		const criteria = question.criteria;
		if (
			criteria === null ||
			typeof criteria !== "object" ||
			Array.isArray(criteria)
		)
			return `choice question "${id}" lacks a criteria object`;
		const keys = Object.keys(criteria);
		if (keys.length === 0) return `choice question "${id}" has no criteria`;
		for (const value of Object.values(criteria as Record<string, unknown>))
			if (typeof value !== "string")
				return `choice question "${id}" has a non-string criterion description`;
		return undefined;
	}
	if (question.type === "score") {
		if (typeof question.instructions !== "string")
			return `score question "${id}" lacks string instructions`;
		if (!Array.isArray(question.criteria) || question.criteria.length === 0)
			return `score question "${id}" needs a non-empty criteria array`;
		for (const value of question.criteria)
			if (typeof value !== "string")
				return `score question "${id}" has a non-string criterion`;
		return undefined;
	}
	if (question.type === "bool") {
		if (typeof question.instructions !== "string")
			return `bool question "${id}" lacks string instructions`;
		const criteria = question.criteria as Record<string, unknown> | undefined;
		if (
			criteria === null ||
			typeof criteria !== "object" ||
			typeof criteria.true !== "string" ||
			typeof criteria.false !== "string"
		)
			return `bool question "${id}" lacks true/false criterion strings`;
		return undefined;
	}
	return `question "${id}" has unknown type ${JSON.stringify(question.type)}`;
}

/** Depth/width-bounded JSON check: rejects cyclic and non-JSON values. */
function assertJsonValue(value: unknown, path: string, depth = 0): void {
	if (depth > 64) throw new InvalidRequestError(`${path} is nested too deeply`);
	if (value === null || typeof value === "string") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new InvalidRequestError(`${path} contains a non-finite number`);
		return;
	}
	if (typeof value === "boolean") return;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++)
			assertJsonValue(value[i], `${path}[${i}]`, depth + 1);
		return;
	}
	if (typeof value === "object") {
		// hasOwn object identity set detects cycles without risking stack overflow.
		const seen = seenObjects.get(value);
		if (seen) throw new InvalidRequestError(`${path} contains a cyclic value`);
		seenObjects.set(value, true);
		try {
			for (const [key, v] of Object.entries(value))
				assertJsonValue(v, `${path}.${key}`, depth + 1);
		} finally {
			seenObjects.delete(value);
		}
		return;
	}
	throw new InvalidRequestError(`${path} contains a non-JSON value`);
}
const seenObjects = new WeakMap<object, true>();

function validateRequest(
	req: unknown,
	allowEmptyQuestions = false,
): JudgeRequest {
	if (req === null || typeof req !== "object" || Array.isArray(req))
		throw new InvalidRequestError("request is not an object");
	const request = req as Record<string, unknown>;
	const state = request.state;
	if (state === null || typeof state !== "object" || Array.isArray(state))
		throw new InvalidRequestError("state is not a JSON object");
	assertJsonValue(state, "state");
	const questions = request.questions as Record<string, unknown>;
	if (
		questions === null ||
		typeof questions !== "object" ||
		Array.isArray(questions)
	)
		throw new InvalidRequestError("questions is not an object");
	const questionIds = Object.keys(questions);
	if (questionIds.length === 0 && !allowEmptyQuestions)
		throw new InvalidRequestError("questions is empty");
	for (const id of questionIds) {
		const problem = validateQuestion(id, questions[id]);
		if (problem) throw new InvalidRequestError(problem);
	}
	const evidence = request.evidence;
	if (evidence !== undefined) {
		if (!Array.isArray(evidence))
			throw new InvalidRequestError("evidence is not an array");
		const seen = new Set<string>();
		for (const record of evidence) {
			if (record === null || typeof record !== "object")
				throw new InvalidRequestError("evidence record is not an object");
			const r = record as Record<string, unknown>;
			if (typeof r.id !== "string" || r.id.length === 0)
				throw new InvalidRequestError(
					"evidence record lacks a non-empty string id",
				);
			if (seen.has(r.id))
				throw new InvalidRequestError(`duplicate evidence id "${r.id}"`);
			seen.add(r.id);
			if (typeof r.text !== "string")
				throw new InvalidRequestError(
					`evidence record "${r.id}" lacks string text`,
				);
			if (
				r.metadata !== undefined &&
				(r.metadata === null ||
					typeof r.metadata !== "object" ||
					Array.isArray(r.metadata))
			)
				throw new InvalidRequestError(
					`evidence record "${r.id}" metadata is not an object`,
				);
			// F5: cyclic / non-JSON metadata is a structured invalid request,
			// never a downstream crash.
			if (r.metadata !== undefined)
				assertJsonValue(r.metadata, `evidence[${r.id}].metadata`);
		}
	}
	return request as unknown as JudgeRequest;
}

function validatePolicy(opts: JudgeOptions): void {
	if (opts.minConfidence !== undefined) {
		const value = opts.minConfidence;
		if (
			typeof value !== "number" ||
			!Number.isFinite(value) ||
			value < 0 ||
			value > 1
		)
			throw new InvalidRequestError(
				"minConfidence must be a finite number in [0,1]",
			);
	}
	if (opts.thresholds !== undefined) {
		if (opts.thresholds === null || typeof opts.thresholds !== "object")
			throw new InvalidRequestError("thresholds is not an object");
		for (const [id, rule] of Object.entries(opts.thresholds)) {
			if (rule === null || typeof rule !== "object")
				throw new InvalidRequestError(
					`threshold rule for "${id}" is not an object`,
				);
			const minimum = (rule as Record<string, unknown>).minimum;
			if (
				typeof minimum !== "number" ||
				!Number.isFinite(minimum) ||
				minimum < 0 ||
				minimum > 1
			)
				throw new InvalidRequestError(
					`threshold rule for "${id}" has a non-finite minimum outside [0,1]`,
				);
			if ((rule as Record<string, unknown>).metric === "choiceProbability") {
				const choice = (rule as Record<string, unknown>).choice;
				if (typeof choice !== "string")
					throw new InvalidRequestError(
						`choiceProbability rule for "${id}" lacks a choice label`,
					);
			} else if ((rule as Record<string, unknown>).metric !== "confidence") {
				throw new InvalidRequestError(
					`threshold rule for "${id}" has unknown metric`,
				);
			}
		}
	}
	if (opts.timeoutMs !== undefined) {
		if (
			typeof opts.timeoutMs !== "number" ||
			!Number.isFinite(opts.timeoutMs) ||
			opts.timeoutMs <= 0 ||
			!Number.isInteger(opts.timeoutMs)
		)
			throw new InvalidRequestError(
				"timeoutMs must be a positive finite integer (milliseconds)",
			);
	}
}

/** A named-choice rule must name an existing choice of that question. */
function crossValidateThresholds(
	questions: Record<string, ClassifierQuestion>,
	thresholds: Record<string, ThresholdRule> | undefined,
): void {
	if (!thresholds) return;
	for (const [id, rule] of Object.entries(thresholds)) {
		if (rule.metric === "choiceProbability") {
			if (!Object.hasOwn(questions, id) || questions[id].type !== "choice")
				throw new InvalidRequestError(
					`choiceProbability rule for "${id}" requires an existing choice question`,
				);
			const question = questions[id];
			if (!Object.hasOwn(question.criteria, rule.choice))
				throw new InvalidRequestError(
					`choiceProbability rule for "${id}" names unknown choice "${rule.choice}"`,
				);
		}
	}
}

/**
 * Race backend selection (lookup + discovery) against the caller deadline
 * and abort signal so discovery can never hang the public boundary. A late
 * registry resolution after timeout/abort is dropped. Caller abort wins over
 * deadline only when the deadline has not already fired.
 */
async function guardSelection<T>(
	promise: Promise<T>,
	deadline: number | null,
	signal: AbortSignal | undefined,
): Promise<{ value: T } | { timeout: true } | { aborted: true }> {
	// The caller already started this work while evaluating the argument.
	// Keep rejection handling even when the wall-clock fast path wins.
	void promise.catch(() => {});
	const deadlineHit = () =>
		(deadline !== null && Date.now() >= deadline) ||
		signal?.reason === DEADLINE_EXPIRED;
	if (deadlineHit()) return { timeout: true };
	if (signal?.aborted) return { aborted: true };
	if (deadline === null && !signal) return { value: await promise };
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return (await Promise.race([
			promise.then((value) =>
				deadlineHit()
					? ({ timeout: true } as const)
					: signal?.aborted
						? ({ aborted: true } as const)
						: ({ value } as const),
			),
			new Promise<{ timeout: true } | { aborted: true }>((resolve) => {
				if (deadline !== null) {
					timer = setTimeout(
						() => resolve({ timeout: true }),
						Math.max(0, deadline - Date.now()),
					);
				}
				if (signal) {
					if (signal.aborted) {
						resolve(deadlineHit() ? { timeout: true } : { aborted: true });
					} else {
						onAbort = () =>
							resolve(deadlineHit() ? { timeout: true } : { aborted: true });
						signal.addEventListener("abort", onAbort, { once: true });
					}
				}
			}),
		])) as { value: T } | { timeout: true } | { aborted: true };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (onAbort !== undefined && signal) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

/**
 * Bound one wait by an optional ABSOLUTE deadline and abort signal without
 * canceling the underlying work: a hung registry/auth/discovery promise can
 * never hold the public boundary (F5). Resolves `undefined` on timeout or
 * abort; rejections propagate to the caller's catch boundary.
 */
async function bounded<T>(
	promise: Promise<T>,
	deadline: number | null | undefined,
	signal: AbortSignal | undefined,
): Promise<T | undefined> {
	void promise.catch(() => {});
	if (
		signal?.aborted ||
		(typeof deadline === "number" && Date.now() >= deadline)
	)
		return undefined;
	const ms =
		typeof deadline === "number" ? Math.ceil(deadline - Date.now()) : null;
	if (ms === null && !signal) return await promise;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		const raced = (await Promise.race([
			promise.then((value) => ({ value }) as const),
			new Promise<{ dropped: true }>((resolve) => {
				if (ms !== null)
					timer = setTimeout(() => resolve({ dropped: true }), ms);
				if (signal) {
					if (signal.aborted) resolve({ dropped: true });
					else {
						onAbort = () => resolve({ dropped: true });
						signal.addEventListener("abort", onAbort, { once: true });
					}
				}
			}),
		])) as { value: T } | { dropped: true };
		return "value" in raced ? raced.value : undefined;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (onAbort !== undefined && signal)
			signal.removeEventListener("abort", onAbort);
	}
}

// ---------------------------------------------------------------------------
// Service instance
// ---------------------------------------------------------------------------

/**
 * Request-owned review state (reviewVersion 1). The attempt collector is
 * owned by this captured generation: a late adapter event after the request
 * settled, or after a branch switch, is dropped and never written onto a
 * newer branch. Observer callbacks are isolated - they cannot throw into,
 * hang or mutate the review's result.
 */
interface ReviewFlight {
	options: ReviewOptions;
	unresolved: Set<string>;
	/** Observed transport attempts, in observation order. */
	attempts: ReviewAttemptObservation[];
	/** Operation id for attempt identities. */
	operationId: string;
	/** Closed at settlement: late adapter events cannot mutate returned diagnostics. */
	settled: boolean;
	/** False once any dispatch returned without the observation contract. */
	observationSupported: boolean;
	/** Durable completed-stage progress views for the result. */
	progress: ReviewStageProgress[];
	presplits: number;
	rejectedReuses: number;
	channel?: string;
}

interface InFlight {
	generation: number;
	timeoutMs?: number;
	/**
	 * Review-mode extensions (reviewVersion 1). Undefined for legacy judge:
	 * no observation collection, no early durable stage commits.
	 */
	review?: ReviewFlight;
	/** Cache instance captured at request start (F4): all writes go through
	 * this reference and are additionally generation-checked, so a stale
	 * completion can never touch a newer branch's live cache. */
	cacheRef: RawJudgmentCache;
	/**
	 * Request-owned judgment commits (F4): buffered per stage and flushed to
	 * the ledger only when the request's overall outcome is known — never on
	 * abort, and only while the request still owns the current generation.
	 */
	bufferedJudgments: {
		key: string;
		answer: ClassifierAnswer;
		backend: "classifier" | "llm";
		model: string;
		thinkingLevel: string;
		fresh?: string;
	}[];
}

export interface CreatedService extends ReviewService {
	/** Internal status view: reuse its already-admitted settings snapshot. */
	availabilityFor(
		config: JudgmentConfig,
	): Promise<{ classifier?: string; llm?: string }>;
	/** Lifecycle/config hook for src/index.ts (documented internal API). */
	refreshBranch(): void;
	/** Swap runtime config (7.2 re-registration path) without version bump. */
	updateConfig(config: JudgmentConfig): void;
}

export function createJudgmentService(runtime: ServiceRuntime): CreatedService {
	let generation = 0;
	let cache: RawJudgmentCache = newCache(generation);
	/** Durable review-stage checkpoints restored from the active branch. */
	let reviewCheckpoints: ReviewStageRecord[] = [];
	const durableAnswers = new Map<string, string>();
	/** Instance nonce prevents attempt-id collisions across reloads or clock rollback. */
	const reviewInstance = randomUUID();
	let reviewSerial = 0;
	const capacity = new Map<string, CapacityProfile>();
	const active = new Set<AbortController>();
	let secrets: readonly string[] = [];

	/**
	 * Resolve known provider keys through Pi only. The SELECTED native and
	 * chat providers are always included (F1): a chat-only inventory like
	 * `getAll()`/`getProviders()` can omit classifier-only built-ins, so
	 * selection-derived ids are resolved explicitly. Every resolution is
	 * individually bounded (F5): a hanging `getAuth` cannot hang readiness.
	 */
	async function refreshSecrets(
		selected: readonly string[] = [],
		deadline?: number | null,
		signal?: AbortSignal,
	): Promise<void> {
		const ids = new Set<string>();
		for (const provider of runtime.registry.getProviders?.() ?? [])
			ids.add(provider.id);
		for (const id of selected) ids.add(id);
		const collected: string[] = [];
		await Promise.all(
			[...ids].map(async (id) => {
				try {
					const auth = await bounded(
						runtime.registry.getAuth(id),
						deadline,
						signal,
					);
					const key = auth?.auth?.apiKey;
					if (typeof key === "string" && key.length > 0) collected.push(key);
				} catch {
					// Auth resolution failure never breaks judgment; skip provider.
				}
			}),
		);
		secrets = [...new Set([...secrets, ...collected])];
	}

	/** Lifecycle navigation: new cache from the active branch only. */
	function refreshBranch(): void {
		for (const controller of active) controller.abort();
		generation += 1;
		cache = newCache(generation);
		capacity.clear();
		reviewCheckpoints = [];
		durableAnswers.clear();
		const branch = runtime.ledger.branch();
		if (branch) {
			const restored = restoreLedger(branch);
			for (const [key, answer] of restored.answers) {
				cache.answers.set(key, answer);
				durableAnswers.set(key, digest(answer));
			}
			for (const [token, keys] of restored.fresh) cache.fresh.set(token, keys);
			for (const envelope of restored.rejected) cache.rejected.add(envelope);
			for (const [channel, attempts] of restored.capacity) {
				const profile = capacity.get(channel) ?? newCapacityProfile();
				for (const attempt of attempts)
					observeCapacity(profile, {
						outcome: attempt.outcome,
						inputTokens: attempt.inputTokens,
						stateBytes: attempt.stateBytes,
						questionBytes: attempt.questionBytes,
						longestQuestionBytes: attempt.longestQuestionBytes,
					});
				capacity.set(channel, profile);
			}
			reviewCheckpoints = restored.reviewStages;
		}
	}

	function updateConfig(config: JudgmentConfig): void {
		// Model/level changes alter identity keys; stale identity cannot be
		// re-discovered under the first model's name, so the cache just misses.
		void config;
	}

	function channelProfile(
		backend: "classifier" | "llm",
		model: string,
		transport?: string,
	): CapacityProfile {
		const key = channelKey(backend, transport ?? model);
		let profile = capacity.get(key);
		if (!profile) {
			profile = newCapacityProfile();
			capacity.set(key, profile);
		}
		return profile;
	}

	async function resolveBackend(
		config: JudgmentConfig,
		signal: AbortSignal | undefined,
	): Promise<
		| { backend: "classifier"; model: AnyClassifierModel }
		| { backend: "llm"; model: AnyModel }
		| { error: string }
	> {
		const { mode } = config;
		if (mode === "llm") {
			const llm = llmChatModel(config);
			return llm
				? { backend: "llm", model: llm }
				: {
						error:
							"mode is llm but no LLM model is configured (llm-as-jev.json: model)",
					};
		}
		// Native candidate: explicit selection honored exactly, else default
		// Jev discovery. resolveNativeClassifier never substitutes another
		// native model for a missing/unavailable explicit selection.
		const native = await resolveNativeClassifier(
			runtime.registry,
			nativeSelection(config),
			{ signal },
		);
		if ("model" in native) {
			return { backend: "classifier", model: native.model };
		}
		// Candidate unavailable. Forced classifier mode errors; auto may fall
		// back to the LLM (unavailability only — dispatch failures never do).
		if (mode === "classifier") return { error: native.error };
		const llm = llmChatModel(config);
		return llm
			? { backend: "llm", model: llm }
			: {
					error:
						"no selected/default native classifier is available and no LLM model is configured (llm-as-jev.json: model)",
				};
	}

	/** Explicit-or-default native selection derived from config slots. */
	function nativeSelection(config: JudgmentConfig): NativeSelection {
		return {
			classifierModel: config.classifierModel,
			classifierProvider: config.classifierProvider,
			classifierModelId: config.classifierModelId,
		};
	}

	function llmChatModel(config: JudgmentConfig): AnyModel | undefined {
		if (!config.provider || !config.modelId) return undefined;
		return runtime.registry.getModel(config.provider, config.modelId);
	}

	function modelIdentity(
		backend: "classifier" | "llm",
		model: AnyClassifierModel | AnyModel,
	): string {
		return backend === "classifier"
			? `${(model as AnyClassifierModel).provider}/${(model as AnyClassifierModel).id}`
			: `${(model as AnyModel).provider}/${(model as AnyModel).id}`;
	}

	function contextLimits(
		model: AnyClassifierModel | AnyModel,
		config: JudgmentConfig,
		review = false,
	): CapacityLimits | undefined {
		const ref = `${model.provider}/${model.id}`;
		if (config.contextLimits && Object.hasOwn(config.contextLimits, ref))
			return { ...config.contextLimits[ref] };
		if (review && /^jev(?:-|$)/.test(model.id.replace(/^typesafe\//, ""))) {
			const base = model.baseUrl.replace(/\/+$/, "");
			if (
				model.api === "typesafe-system-one" &&
				[
					"https://api.typesafe.ai/v1",
					"https://api.typesafe.ai/v1/systemone",
				].includes(base)
			)
				return { request: 64000, stateAndLongestQuestion: 32000 };
			if (
				(model.api === "typesafe-system-one" ||
					model.api === "openrouter-system-one") &&
				[
					"https://openrouter.ai/api/v1",
					"https://openrouter.ai/api/v1/systemone",
				].includes(base)
			)
				return { request: 32000, stateAndLongestQuestion: 32000 };
		}
		const window = model.contextWindow;
		return typeof window === "number" && window > 0
			? { contextWindow: window }
			: undefined;
	}

	const service: CreatedService = {
		version: 1,
		reviewVersion: 1,
		refreshBranch,
		updateConfig,

		async review(rawReq, rawOpts): Promise<ReviewResult> {
			const controller = new AbortController();
			active.add(controller);
			try {
				const signal = rawOpts?.signal
					? AbortSignal.any([rawOpts.signal, controller.signal])
					: controller.signal;
				const review: ReviewFlight = {
					options: rawOpts ?? {},
					unresolved: new Set(),
					attempts: [],
					operationId: `review-${reviewInstance}-${++reviewSerial}`,
					settled: false,
					observationSupported: true,
					progress: [],
					presplits: 0,
					rejectedReuses: 0,
				};
				const result = await judgeInner(
					rawReq,
					{ ...rawOpts, signal },
					{
						generation,
						cacheRef: cache,
						bufferedJudgments: [],
						review,
					},
				);
				review.settled = true;
				return {
					...result,
					progress: { stages: [...review.progress] },
					diagnostics: {
						...diagnostics(review.attempts, review.observationSupported),
						presplits: review.presplits,
						rejectedReuses: review.rejectedReuses,
						...(review.channel ? { channel: review.channel } : {}),
					},
					unresolved: [...review.unresolved],
				};
			} catch (error) {
				return {
					...resultShell("llm", ""),
					stopReason: "error",
					errorMessage: redactString(
						error instanceof Error ? error.message : String(error),
						secrets,
					),
					progress: { stages: [] },
					diagnostics: emptyDiagnostics(),
					unresolved: [],
				};
			} finally {
				active.delete(controller);
			}
		},

		availability: () =>
			service.availabilityFor(structuredClone(runtime.config())),

		async availabilityFor(
			config,
		): Promise<{ classifier?: string; llm?: string }> {
			const out: { classifier?: string; llm?: string } = {};
			// Bounded budget so a hanging auth/discovery cannot hang the caller.
			const budget =
				typeof config.timeoutMs === "number" &&
				Number.isFinite(config.timeoutMs) &&
				config.timeoutMs > 0
					? config.timeoutMs
					: undefined;
			const deadline = budget !== undefined ? Date.now() + budget : null;
			try {
				const native = await bounded(
					resolveNativeClassifier(runtime.registry, nativeSelection(config)),
					deadline,
					undefined,
				);
				if (native && "model" in native)
					out.classifier = `${native.model.provider}/${native.model.id}`;
			} catch {
				/* availability is best-effort */
			}
			// F10: `llm` reports a USABLE configured chat candidate — catalog
			// existence alone is not usability. Credentials are confirmed via
			// Pi auth resolution (bounded); unknown/uncredentialed models are
			// unavailable and the main-session model is never a fallback.
			const llm = llmChatModel(config);
			if (llm && config.provider) {
				try {
					const auth = await bounded(
						runtime.registry.getAuth(config.provider),
						deadline,
						undefined,
					);
					if (auth?.auth?.apiKey) out.llm = `${llm.provider}/${llm.id}`;
				} catch {
					/* unresolvable auth means unavailable */
				}
			}
			return out;
		},

		async judge(rawReq, rawOpts): Promise<JudgeResult> {
			const controller = new AbortController();
			active.add(controller);
			try {
				const signal = rawOpts?.signal
					? AbortSignal.any([rawOpts.signal, controller.signal])
					: controller.signal;
				return await judgeInner(
					rawReq,
					{ ...rawOpts, signal },
					{
						generation,
						cacheRef: cache,
						bufferedJudgments: [],
					},
				);
			} catch (error) {
				return {
					...resultShell("llm", ""),
					stopReason: "error",
					errorMessage: redactString(
						error instanceof Error ? error.message : String(error),
						secrets,
					),
				};
			} finally {
				active.delete(controller);
			}
		},
	};

	function ledger(record: LedgerRecord): void {
		writeLedger(runtime.ledger.append, record);
	}

	/** Record only an admitted or explicitly overflowing active-branch attempt. */
	function recordCapacity(
		flight: InFlight,
		profile: CapacityProfile,
		channel: string,
		attempt: Extract<LedgerRecord, { kind: "capacity" }>["attempt"],
	): void {
		if (!ownsLiveCache(flight)) return;
		const { inputTokens, ...sizes } = attempt;
		const validated = {
			...sizes,
			...(typeof inputTokens === "number" &&
			Number.isFinite(inputTokens) &&
			inputTokens >= 0
				? { inputTokens }
				: {}),
		};
		observeCapacity(profile, validated);
		ledger({ kind: "capacity", channel, attempt: validated });
	}

	/**
	 * Buffer a request-owned judgment commit (F4). Ledger rows are flushed
	 * only when the overall outcome is known and the request still owns the
	 * current generation/cache — an aborted request persists nothing, while
	 * a non-abort later failure may retain completed validated stages.
	 */
	function persistJudgment(
		flight: InFlight,
		key: string,
		answer: ClassifierAnswer,
		backend: "classifier" | "llm",
		model: string,
		thinkingLevel: string,
		fresh?: string,
	): void {
		flight.bufferedJudgments.push({
			key,
			answer,
			backend,
			model,
			thinkingLevel,
			fresh,
		});
	}

	/** Whether this request still owns the current live cache (F4). */
	function ownsLiveCache(flight: InFlight): boolean {
		return flight.generation === generation && cache === flight.cacheRef;
	}

	/** Flush buffered judgment commits for a finished request (F4). */
	function flushJudgments(flight: InFlight): void {
		if (!ownsLiveCache(flight)) return;
		for (const entry of flight.bufferedJudgments) {
			// Publish cache and ledger together only after a non-aborted outcome.
			flight.cacheRef.answers.set(entry.key, entry.answer);
			if (entry.fresh !== undefined) {
				flight.cacheRef.answers.set(
					pendingKey(flight.cacheRef, entry.fresh, entry.key),
					entry.answer,
				);
				noteFresh(flight.cacheRef, entry.fresh, entry.key);
			}
			const durable = writeLedger(runtime.ledger.append, {
				kind: "judgment",
				key: entry.key,
				answer: entry.answer,
				backend: entry.backend,
				model: entry.model,
				thinkingLevel: entry.thinkingLevel,
				...(entry.fresh !== undefined
					? { freshToken: freshTokenKey(entry.fresh) }
					: {}),
			});
			if (durable && ownsLiveCache(flight)) {
				durableAnswers.set(entry.key, digest(entry.answer));
				durableAnswers.set(
					pendingKey(flight.cacheRef, entry.fresh, entry.key),
					digest(entry.answer),
				);
			}
		}
		flight.bufferedJudgments.length = 0;
	}

	/** One absolute deadline, distinguished from caller or branch cancellation. */
	function requestInterruption(
		flight: InFlight,
		deadline: number | null,
		signal: AbortSignal | undefined,
	): { stopReason: "error" | "aborted"; errorMessage: string } | undefined {
		if (!ownsLiveCache(flight))
			return {
				stopReason: "aborted",
				errorMessage: "request aborted by session navigation",
			};
		if (
			(deadline !== null && Date.now() >= deadline) ||
			signal?.reason === DEADLINE_EXPIRED
		)
			return {
				stopReason: "error",
				errorMessage: `request timed out after ${flight.timeoutMs}ms`,
			};
		if (signal?.aborted)
			return {
				stopReason: "aborted",
				errorMessage: "request aborted by caller signal",
			};
		return undefined;
	}

	async function judgeInner(
		rawReq: unknown,
		rawOpts: JudgeOptions | undefined,
		flight: InFlight,
	): Promise<JudgeResult | ReviewResult> {
		// F5: effective timeout — caller override wins, else the configured one.
		const config = structuredClone(runtime.config());
		const requestedTimeout = rawOpts?.timeoutMs ?? config.timeoutMs;
		const deadline =
			typeof requestedTimeout === "number" &&
			Number.isFinite(requestedTimeout) &&
			requestedTimeout > 0
				? Date.now() + requestedTimeout
				: null;
		let signal = rawOpts?.signal;
		const deadlineController = new AbortController();
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		let selected: { backend: "classifier" | "llm"; model: string } | undefined;
		const interrupted = (): JudgeResult | undefined => {
			const stopped = requestInterruption(flight, deadline, signal);
			return stopped
				? {
						...resultShell(
							selected?.backend ?? "llm",
							selected?.model ?? config.model ?? "",
						),
						...stopped,
					}
				: undefined;
		};

		// Whole-call boundary: validation, redaction readiness, selection,
		// recovery and joins all settle under the caller's deadline/abort or a
		// structured error — never a rejected promise.
		try {
			if (
				!Number.isInteger(requestedTimeout) ||
				requestedTimeout <= 0 ||
				requestedTimeout > 2_147_483_647
			) {
				throw new InvalidRequestError(
					"timeoutMs must be a positive finite integer (milliseconds) within the timer range",
				);
			}
			flight.timeoutMs = requestedTimeout;
			deadlineTimer = setTimeout(
				() => deadlineController.abort(DEADLINE_EXPIRED),
				requestedTimeout,
			);
			signal = signal
				? AbortSignal.any([signal, deadlineController.signal])
				: deadlineController.signal;
			const beforeReadiness = interrupted();
			if (beforeReadiness) return beforeReadiness;
			// Redaction readiness is bounded by THIS call's deadline/abort (F5);
			// selected providers are always included (F1).
			const selectedProviders = [
				...(config.provider ? [config.provider] : []),
				...(config.classifierProvider ? [config.classifierProvider] : []),
			];
			const refreshed = refreshSecrets(selectedProviders, deadline, signal);
			await bounded(refreshed, deadline, signal);
			const afterReadiness = interrupted();
			if (afterReadiness) return afterReadiness;

			const opts: JudgeOptions = { ...rawOpts, signal, timeoutMs: undefined };
			// Keep an explicit integer caller override for the stages; the
			// effective deadline object above already spans everything.
			if (
				rawOpts?.timeoutMs !== undefined &&
				Number.isInteger(rawOpts.timeoutMs)
			)
				opts.timeoutMs = rawOpts.timeoutMs;
			else if (rawOpts?.timeoutMs !== undefined)
				throw new InvalidRequestError(
					"timeoutMs must be a positive finite integer (milliseconds)",
				);

			let request: JudgeRequest;
			let policy: ThresholdPolicy;
			try {
				request = validateRequest(rawReq);
				validatePolicy(opts);
				crossValidateThresholds(request.questions, opts.thresholds);
				policy = {
					default: opts.minConfidence,
					perQuestion: opts.thresholds ?? {},
				};
			} catch (error) {
				// Never throws at the public boundary.
				const message =
					error instanceof InvalidRequestError
						? error.message
						: error instanceof Error
							? error.message
							: String(error);
				return {
					...resultShell("llm", config.model ?? ""),
					stopReason: "error",
					errorMessage: redactString(`invalid request: ${message}`, secrets),
				};
			}

			const beforeSelection = interrupted();
			if (beforeSelection) return beforeSelection;

			// Selection lives inside the whole-request catch/deadline boundary so
			// a discovery throw, rejection or hang can never violate
			// never-throws or the caller deadline.
			let resolved: Awaited<ReturnType<typeof resolveBackend>>;
			try {
				const raced = await guardSelection(
					resolveBackend(config, signal),
					deadline,
					signal,
				);
				if ("timeout" in raced) {
					deadlineController.abort(DEADLINE_EXPIRED);
					return {
						...resultShell("llm", config.model ?? ""),
						stopReason: "error",
						errorMessage: redactString(
							`native classifier selection timed out after ${requestedTimeout}ms`,
							secrets,
						),
					};
				}
				if ("aborted" in raced) return abortedResult(config);
				resolved = raced.value;
			} catch (error) {
				if (signal?.aborted) return abortedResult(config);
				return {
					...resultShell("llm", config.model ?? ""),
					stopReason: "error",
					errorMessage: redactString(
						`native classifier discovery failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
						secrets,
					),
				};
			}
			if ("error" in resolved) {
				return {
					...resultShell(
						config.mode === "classifier" ? "classifier" : "llm",
						config.model ?? "",
					),
					stopReason: "error",
					errorMessage: redactString(resolved.error, secrets),
				};
			}

			// Freeze the actual backend, model and effective thinking for EVERY
			// dispatch, cache identity and ledger entry of this request. LLM
			// thinking is computed once from the model + configured level; later
			// config mutation mid-flight cannot change a dispatch.
			const { backend, model } = resolved;
			const modelId = modelIdentity(backend, model);
			selected = { backend, model: modelId };
			const thinkingLevel =
				backend === "llm"
					? effectiveThinkingLevel(model as AnyModel, config.thinkingLevel)
					: "none";
			const limits = contextLimits(model, config, !!flight.review);
			const profile = channelProfile(
				backend,
				modelId,
				flight.review ? digest({ model }) : undefined,
			);
			const overhead = backend === "llm" ? LLM_ENVELOPE_OVERHEAD_BYTES : 0;

			// F1: the SELECTED backend's provider is always part of known keys —
			// including a native provider discovered by default (a chat-only
			// inventory like getAll()/getProviders() can omit classifier-only
			// built-ins). Bounded by the remaining request budget; never an
			// env/endpoint fallback.
			const selectedBackendProvider = model.provider;
			{
				const refreshed = refreshSecrets(
					[...selectedProviders, selectedBackendProvider],
					deadline,
					signal,
				);
				await bounded(refreshed, deadline, signal);
			}
			const beforeStages = interrupted();
			if (beforeStages) return beforeStages;

			const redacted = redactJson(request, secrets) as JudgeRequest;
			const result = await runStages(
				redacted,
				opts,
				policy,
				backend,
				model,
				modelId,
				thinkingLevel,
				limits,
				profile,
				overhead,
				flight,
				deadline,
			);

			if (flight.generation !== generation) {
				// Whole work aborted by a lifecycle switch: no late result.
				return { ...result, answers: {}, dropped: [], stopReason: "aborted" };
			}
			return result;
		} catch (error) {
			// Absolute backstop: any residual throw resolves structurally.
			const message = error instanceof Error ? error.message : String(error);

			const stopped = interrupted();
			if (stopped) return stopped;
			return {
				...resultShell(
					selected?.backend ?? "llm",
					selected?.model ?? config.model ?? "",
				),
				stopReason: "error",
				errorMessage: redactString(message, secrets),
			};
		} finally {
			// A synchronous registry phase may exhaust the deadline before its
			// timer gets an event-loop turn. Cancel before clearing that timer.
			if (deadline !== null && Date.now() >= deadline)
				deadlineController.abort(DEADLINE_EXPIRED);
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		}
	}

	/** Aborted shell with a safe diagnostic message (F5). */
	function abortedResult(config: JudgmentConfig): JudgeResult {
		return {
			...resultShell("llm", config.model ?? ""),
			stopReason: "aborted",
			errorMessage: "request aborted by caller signal",
		};
	}

	/**
	 * One backend dispatch over a question batch at one stage. The native
	 * path uses PINNED dispatch (`classifyWithModel`) with the frozen model
	 * resolved at selection time — a registry/catalog change mid-request can
	 * never substitute a different model. The LLM path receives the frozen
	 * effective thinking level, not a reread of runtime config.
	 */
	async function dispatch(
		backend: "classifier" | "llm",
		model: AnyClassifierModel | AnyModel,
		context: ClassifierContext,
		opts: JudgeOptions,
		deadline: number | null,
		thinkingLevel: string,
		flight: InFlight,
	): Promise<
		ClassifierResult & {
			observation?: {
				version: number;
				attempts: number;
				partialAnswers?: Record<string, unknown>;
			};
		}
	> {
		const remaining =
			deadline !== null ? deadline - Date.now() : Number.POSITIVE_INFINITY;
		if (remaining <= 0 || opts.signal?.aborted)
			return {
				api: (backend === "classifier"
					? model.api
					: "llm-as-jev") as ClassifierApi,
				provider: model.provider,
				model: model.id,
				answers: {},
				timestamp: Date.now(),
				stopReason: remaining <= 0 ? "error" : "aborted",
				errorMessage:
					remaining <= 0
						? "request timed out before dispatch"
						: "request aborted before dispatch",
			};
		const timeoutMs = Number.isFinite(remaining) ? remaining : undefined;
		if (backend === "classifier" && flight.review) {
			const review = flight.review;
			const startIndex = review.attempts.length;
			let open = true;
			const onAttempt = collectAttempts(
				review.operationId,
				review.attempts,
				() => open && !review.settled,
				(attempt) => {
					if (ownsLiveCache(flight))
						ledger({ kind: "review-attempt", version: 1, attempt });
				},
				(text) => redactString(text, secrets),
				sizeOf(context.state, context.questions, model.id),
			);
			try {
				const result = (await classifyWithModel(
					runtime.registry,
					model as AnyClassifierModel,
					context,
					{
						signal: opts.signal,
						timeoutMs,
						observe: true,
						onAttempt,
						fetch: runtime.nativeFetch,
					},
				)) as ClassifierResult & {
					observation?: {
						version: number;
						attempts: number;
						partialAnswers?: Record<string, unknown>;
					};
				};
				const observedCount = review.attempts.length - startIndex;
				if (requestInterruption(flight, deadline, opts.signal)) {
					if (observedCount === 0 && result.observation?.version !== 1)
						review.observationSupported = false;
					return result;
				}
				if (
					result.observation?.version !== 1 ||
					result.observation.attempts !== observedCount
				) {
					review.observationSupported = false;
					return {
						...result,
						answers: {},
						stopReason: "error",
						errorMessage:
							"selected classifier adapter lacks observable HTTP attempts through Pi's public fetch option",
					};
				}
				if (result.stopReason === "error") {
					const terminal = review.attempts.slice(startIndex).at(-1);
					// Observed categories, never provider bodies, drive recovery and public diagnostics.
					const category = terminal?.errorCategory ?? "response";
					return {
						...result,
						errorMessage: `${category === "overflow" ? "context overflow" : `native review ${category} failure`}${terminal?.status ? ` (HTTP ${terminal.status})` : ""}`,
					};
				}
				return result;
			} finally {
				open = false;
			}
		}
		if (backend === "llm" && flight.review) {
			const review = flight.review;
			const start = review.attempts.length;
			const observed = observeLlmRegistry(runtime.registry, {
				operation: review.operationId,
				attempts: review.attempts,
				isOpen: () => !review.settled,
				publish: (attempt) => {
					if (ownsLiveCache(flight))
						ledger({ kind: "review-attempt", version: 1, attempt });
				},
				sanitize: (text) => redactString(text, secrets),
			});
			let result: ClassifierResult;
			try {
				result = await llmClassify(
					observed.registry,
					model as AnyModel,
					context,
					{
						thinkingLevel: thinkingLevel as JudgmentThinkingLevel,
						signal: opts.signal,
						timeoutMs,
					},
				);
			} finally {
				review.observationSupported =
					observed.close() && review.observationSupported;
			}
			if (requestInterruption(flight, deadline, opts.signal)) return result;
			if (!review.observationSupported)
				return {
					...result,
					answers: {},
					stopReason: "error",
					errorMessage:
						"selected LLM adapter lacks required HTTP/SSE attempt-observation capability",
				};
			if (result.stopReason === "error") {
				const terminal = review.attempts.slice(start).at(-1);
				return {
					...result,
					errorMessage:
						terminal?.errorCategory === "overflow"
							? "context overflow"
							: `LLM review ${terminal?.errorCategory ?? "response"} failure`,
				};
			}
			return result;
		}
		return backend === "classifier"
			? classifyWithModel(
					runtime.registry,
					model as AnyClassifierModel,
					context,
					{ signal: opts.signal, timeoutMs },
				)
			: llmClassify(runtime.registry, model as AnyModel, context, {
					thinkingLevel: thinkingLevel as JudgmentThinkingLevel,
					signal: opts.signal,
					timeoutMs,
				});
	}

	interface StageRun {
		answers: Record<string, ClassifierAnswer>;
		dropped: string[];
		stopReason: JudgeResult["stopReason"];
		errorMessage?: string;
		contextOverflow?: boolean;
		reuse: { hits: number; joined: number; sent: number };
		usage?: Usage;
	}

	/**
	 * Ordered evidence recovery (task 4.6). Stage = fixed state + evidence
	 * batch + advisory previous answers. Overflow reduces the constrained
	 * dimension (questions, then evidence). Intermediate-stage RAW opinions
	 * are ADVISORY ONLY (F3): the caller's policy is applied exactly once,
	 * to the completed FINAL stage's RAW answers — an earlier stage's
	 * acceptance or drop never survives into the final view, and a later
	 * error/abort returns no final answers.
	 */
	async function runStages(
		request: JudgeRequest,
		opts: JudgeOptions,
		policy: ThresholdPolicy,
		backend: "classifier" | "llm",
		model: AnyClassifierModel | AnyModel,
		modelId: string,
		thinkingLevel: string,
		limits: CapacityLimits | undefined,
		profile: CapacityProfile,
		overhead: number,
		flight: InFlight,
		deadline: number | null,
	): Promise<JudgeResult> {
		const total: StageRun = {
			answers: {},
			dropped: [],
			stopReason: "stop",
			reuse: { hits: 0, joined: 0, sent: 0 },
		};
		const usages: Usage[] = [];
		const evidence = frameEvidence(request.evidence ?? []);
		// Review keys never borrow legacy records lacking observation/transport provenance.
		const reviewOptions = flight.review?.options;
		const lineage = digest({
			review: 1,
			transport: model,
			thinkingLevel,
			projection: reviewOptions?.projectionRevision,
		});
		if (reviewOptions?.projectStage && !reviewOptions.projectionRevision)
			throw new InvalidRequestError("projectStage requires projectionRevision");
		// Each judgment key already includes its own complete question definition.
		// Sibling membership belongs to the checkpoint, not raw-answer identity:
		// adding C must not repay unchanged A/B in the same factual stage.
		const scope = flight.review
			? digest({
					lineage,
					state: request.state,
					checkpoint: reviewOptions?.checkpoint,
				})
			: undefined;
		const scopeIdentity = scope ? { scope } : {};
		const capacityChannel = channelKey(
			backend,
			flight.review ? digest({ model }) : modelId,
		);
		if (flight.review) flight.review.channel = capacityChannel;
		const completed: FramedEvidence[] = [];
		/** Advisory prior-stage opinions (RAW, unfiltered, never final). */
		let previousAnswers: Record<string, ClassifierAnswer> = {};
		if (reviewOptions?.checkpoint !== undefined) {
			if (opts.fresh !== undefined)
				throw new InvalidRequestError(
					"a fresh review cannot use an incremental seed",
				);
			const seed = reviewCheckpoints.find(
				(row) =>
					row.identity === reviewOptions.checkpoint && row.lineage === lineage,
			);
			if (
				!seed ||
				!seed.answerKeys.every((key, i) => {
					const answer = flight.cacheRef.answers.get(key);
					return (
						answer !== undefined &&
						digest(answer) === seed.answerDigests[i] &&
						durableAnswers.get(key) === seed.answerDigests[i]
					);
				})
			)
				throw new InvalidRequestError(
					"checkpoint is absent, incompatible or lacks durable answer references on this branch",
				);
			previousAnswers = Object.fromEntries(
				seed.questionIds.map((id, i) => [
					id,
					structuredClone(flight.cacheRef.answers.get(seed.answerKeys[i])!),
				]),
			);
		}
		/** Raw completed-stage view, separate from each caller's policy. */
		let stageRawAnswers: Record<string, ClassifierAnswer> = {};
		// Evidence recovery owns the full question set. Ancestor question batches
		// must not repeat that traversal or merge answers from its old factual stage.
		let evidenceRevision = 0;

		const sizeFor = (
			batch: FramedEvidence[],
			questions: Record<string, ClassifierQuestion>,
			fixed = request.state,
			prior = previousAnswers,
			final = true,
		) => {
			if (flight.review)
				return sizeOf(
					stageState(fixed, batch, prior, final),
					questions,
					model.id,
				);
			const size = sizeOf(request.state, questions);
			return {
				...size,
				stateBytes: size.stateBytes + framedEvidenceBytes(batch) + overhead,
			};
		};

		/** Persist only a complete required-question view, with answers durable first. */
		const checkpoint = (
			batch: FramedEvidence[],
			projection: ReviewStageProjection,
			questions: Record<string, ClassifierQuestion>,
			prior: Record<string, ClassifierAnswer>,
			final: boolean,
			answers: Record<string, ClassifierAnswer>,
		) => {
			const review = flight.review;
			if (!review || requestInterruption(flight, deadline, opts.signal)) return;
			if (projection.unresolved?.length) return;
			const ids = Object.keys(projection.questions);
			if (
				Object.keys(questions).length !== ids.length ||
				!ids.every(
					(id) =>
						Object.hasOwn(answers, id) &&
						validateAnswer(questions[id], answers[id]),
				)
			)
				return;
			const keys = ids.map((id) =>
				judgmentKey({
					...scopeIdentity,
					backend,
					model: modelId,
					thinkingLevel,
					state: projection.state,
					evidence: batch,
					previousAnswers: prior,
					questionId: id,
					question: questions[id],
					isFinalStage: final,
				}),
			);
			flushJudgments(flight);
			if (requestInterruption(flight, deadline, opts.signal)) return;
			const identity = digest({
				scope,
				keys,
				fresh: opts.fresh === undefined ? null : freshTokenKey(opts.fresh),
			});
			const record = {
				lineage,
				questionIds: ids,
				answerDigests: ids.map((id) => digest(answers[id])),
				sources: batch.map((f) => ({
					id: f.bounds?.of ?? f.record.id,
					...(f.bounds ? { bounds: { ...f.bounds } } : {}),
				})),
				identity,
				evidenceIds: batch.map((f) => f.record.id),
				answerKeys: keys.map((key) =>
					pendingKey(flight.cacheRef, opts.fresh, key),
				),
				model: modelId,
				final,
			};
			const allDurable = record.answerKeys.every(
				(key, i) => durableAnswers.get(key) === digest(answers[ids[i]]),
			);
			const existing = reviewCheckpoints.some(
				(row) => row.identity === identity && digest(row) === digest(record),
			);
			const durable =
				allDurable &&
				(existing ||
					writeLedger(runtime.ledger.append, {
						kind: "review-stage",
						version: 1,
						...record,
					}));
			if (!ownsLiveCache(flight)) return;
			if (durable && !existing) reviewCheckpoints.push(record);
			const progress: ReviewStageProgress = {
				final,
				checkpoint: identity,
				evidenceIds: record.evidenceIds,
				durable,
				sources: batch.map((f) => ({
					id: f.bounds?.of ?? f.record.id,
					...(f.bounds ? { bounds: { ...f.bounds } } : {}),
				})),
				opinions: structuredClone(answers),
			};
			review.progress.push(progress);
			completed.push(...batch);
			if (durable && review.options.onProgress) {
				try {
					void Promise.resolve(
						review.options.onProgress(structuredClone(progress)),
					).catch(() => {});
				} catch {
					/* Notification cannot control recovery. */
				}
			}
		};

		/**
		 * Evaluate one leaf stage (state + evidence batch + questions). On
		 * predicted or reported overflow reduce: questions first, then the
		 * evidence batch, then a single record into fragments. Returns false
		 * when the run must stop (failure/abort/irreducible).
		 */
		const stage = async (
			batch: FramedEvidence[],
			questions: Record<string, ClassifierQuestion>,
			isFinalStage: boolean,
			projection?: ReviewStageProjection,
		): Promise<boolean> => {
			const stopped = requestInterruption(flight, deadline, opts.signal);
			if (stopped) {
				Object.assign(total, stopped);
				return false;
			}
			if (!projection) {
				projection = { state: request.state, questions };
				if (reviewOptions?.projectStage) {
					const projected = reviewOptions.projectStage(
						structuredClone({
							evidence: batch,
							completed,
							previousAnswers,
							final: isFinalStage,
						}),
					);
					if (
						projected &&
						typeof (projected as unknown as Promise<unknown>).then ===
							"function"
					) {
						void Promise.resolve(projected).catch(() => {});
						throw new InvalidRequestError(
							"projectStage must return synchronous JSON",
						);
					}
					const valid = validateRequest(projected, true);
					if (
						projected.unresolved !== undefined &&
						(!Array.isArray(projected.unresolved) ||
							!projected.unresolved.every((id) => typeof id === "string"))
					)
						throw new InvalidRequestError("invalid projected unresolved ids");
					const withheld = new Set(projected.unresolved ?? []);
					if (
						Object.keys(request.questions).some(
							(id) => !Object.hasOwn(valid.questions, id) && !withheld.has(id),
						)
					)
						throw new InvalidRequestError(
							"projectStage omitted required questions without declaring them unresolved",
						);
					if ([...withheld].some((id) => Object.hasOwn(valid.questions, id)))
						throw new InvalidRequestError(
							"projected unresolved questions must not also be dispatchable",
						);
					projection = redactJson(
						{
							state: valid.state,
							questions: valid.questions,
							...(projected.unresolved
								? { unresolved: projected.unresolved }
								: {}),
						},
						secrets,
					) as unknown as ReviewStageProjection;
					questions = projection.questions;
					crossValidateThresholds(questions, opts.thresholds);
				}
			}
			const afterProjection = requestInterruption(
				flight,
				deadline,
				opts.signal,
			);
			if (afterProjection) {
				Object.assign(total, afterProjection);
				return false;
			}
			for (const id of projection.unresolved ?? [])
				flight.review?.unresolved.add(id);
			const fixed = projection.state;
			const qIds = Object.keys(questions);
			const stagePrior = previousAnswers;
			for (const id of qIds) flight.review?.unresolved.add(id);
			if (qIds.length === 0) return true;

			// 1. Cache/join phase per question identity. Identity includes the
			// dispatched stage coverage/finality (F6) so a partial-stage
			// judgment can never be reused as full coverage.
			const answers: Record<string, ClassifierAnswer> = {};
			const joins: [string, string, Promise<PendingJudgment>][] = [];
			const misses: [string, string][] = [];
			for (const id of qIds) {
				const key = judgmentKey({
					...scopeIdentity,
					backend,
					model: modelId,
					thinkingLevel,
					state: fixed,
					evidence: batch,
					previousAnswers,
					questionId: id,
					question: questions[id],
					isFinalStage,
				});
				// F2: cached/restored answers are revalidated against the
				// CURRENT question before use; a poisoned or stale record
				// that no longer matches cannot be accepted.
				const answerKey = pendingKey(flight.cacheRef, opts.fresh, key);
				const staged = flight.bufferedJudgments.findLast(
					(entry) => entry.key === key && entry.fresh === opts.fresh,
				)?.answer;
				const cachedRaw =
					staged ??
					(freshEligible(flight.cacheRef, opts.fresh, key)
						? flight.cacheRef.answers.get(answerKey)
						: undefined);
				const cached =
					cachedRaw !== undefined
						? validateAnswer(questions[id], cachedRaw)
						: undefined;
				if (cachedRaw !== undefined && cached === undefined) {
					// Poisoned entry: drop it so future calls redispatch.
					flight.cacheRef.answers.delete(answerKey);
				}
				if (cached) {
					flight.review?.unresolved.delete(id);
					total.reuse.hits += 1;
					Object.defineProperty(answers, id, {
						value: cached,
						enumerable: true,
						writable: true,
						configurable: true,
					});
				} else {
					// F6: pending lookup is fresh-token scoped — a forced review
					// never joins ordinary in-flight work; same-token retries do.
					const pending = flight.cacheRef.pending.get(
						pendingKey(flight.cacheRef, opts.fresh, key),
					);
					if (pending) {
						total.reuse.joined += 1;
						joins.push([id, key, pending]);
					} else {
						misses.push([id, key]);
					}
				}
			}

			// 2. Misses: capacity gate, then one dispatch for the batch.
			if (misses.length > 0) {
				const missQuestions = Object.fromEntries(
					misses.map(([id]) => [id, questions[id]]),
				);
				const size = sizeFor(
					batch,
					missQuestions,
					fixed,
					stagePrior,
					isFinalStage,
				);
				const envelope = judgmentKey({
					...scopeIdentity,
					backend,
					model: modelId,
					thinkingLevel,
					state: fixed,
					evidence: batch,
					previousAnswers,
					questionId: "*",
					question: { all: missQuestions } as never,
					isFinalStage,
				});
				const constraint = overflowConstraint(profile, size, limits);
				const evidenceCanSplit = splitPiece(batch) !== undefined;
				const fixedSize = sizeFor(
					// An irreducible source is part of the admission floor too;
					// shrinking questions cannot correct a false state-size hint.
					evidenceCanSplit ? [] : batch,
					missQuestions,
					fixed,
					stagePrior,
					isFinalStage,
				);
				const floor =
					flight.review && overflowConstraint(profile, fixedSize, limits);
				// A soft fixed-state prediction cannot be repaired by traversing records/questions.
				// Admit the useful unanswered batch once; exact rejections still take precedence.
				const admitFixed =
					floor === "state" ||
					floor === "rejection" ||
					(flight.review &&
						overflowConstraint(
							profile,
							{ ...fixedSize, questionBytes: fixedSize.longestQuestionBytes },
							limits,
						) === "request");
				const rejected =
					flight.cacheRef.rejected.has(envelope) ||
					misses.some(([id]) =>
						flight.cacheRef.rejected.has(
							judgmentKey({
								...scopeIdentity,
								backend,
								model: modelId,
								thinkingLevel,
								state: fixed,
								evidence: batch,
								previousAnswers,
								// Rejections store envelopes, not individual answer keys.
								questionId: "*",
								question: { all: { [id]: questions[id] } } as never,
								isFinalStage,
							}),
						),
					);
				const irreducible = misses.length === 1 && !evidenceCanSplit;

				if (rejected && flight.review) flight.review.rejectedReuses += 1;
				if (rejected && !irreducible) {
					// Never resend a rejected envelope unchanged: subdivide first.
					return await subdivide(
						batch,
						questions,
						isFinalStage,
						projection,
						constraint,
						missQuestions,
					);
				}
				if (rejected && irreducible) {
					total.stopReason = "error";
					total.contextOverflow = true;
					total.errorMessage =
						"context overflow: this exact envelope was already rejected and cannot be reduced further";
					return false;
				}
				if (
					constraint &&
					!admitFixed &&
					!(irreducible && misses.length === 1)
				) {
					// Predicted overflow: split before sending (soft estimate).
					if (flight.review) flight.review.presplits += 1;
					return await subdivide(
						batch,
						questions,
						isFinalStage,
						projection,
						constraint,
						missQuestions,
					);
				}

				// Dispatch (one request for the whole miss batch). The in-flight
				// promises are registered BEFORE the await so a concurrent identical
				// call joins instead of duplicating the request.
				const context: ClassifierContext = {
					state: stageState(fixed, batch, previousAnswers, isFinalStage),
					questions: missQuestions,
				};
				let recovering = false;
				const run = dispatch(
					backend,
					model,
					context,
					opts,
					deadline,
					thinkingLevel,
					flight,
				)
					.then((result) => {
						total.reuse.sent += misses.length;
						if (result.usage) usages.push(result.usage);
						if (
							flight.review &&
							result.observation?.version === 1 &&
							!requestInterruption(flight, deadline, opts.signal) &&
							result.stopReason !== "aborted"
						) {
							// Valid partial members survive failure; they do not advance coverage.
							for (const [id, key] of misses) {
								const partial = result.observation.partialAnswers;
								const raw =
									partial && Object.hasOwn(partial, id)
										? partial[id]
										: result.stopReason === "stop" &&
												Object.hasOwn(result.answers, id)
											? result.answers[id]
											: undefined;
								const answer = validateAnswer(questions[id], raw);
								if (answer) {
									flight.review.unresolved.delete(id);
									persistJudgment(
										flight,
										key,
										answer,
										backend,
										modelId,
										thinkingLevel,
										opts.fresh,
									);
								}
							}
							flushJudgments(flight);
						}
						if (result.stopReason !== "stop") return { ...result, answers: {} };
						const validated: Record<string, ClassifierAnswer> = {};
						for (const [id] of misses) {
							const answer = validateAnswer(
								questions[id],
								Object.hasOwn(result.answers, id)
									? result.answers[id]
									: undefined,
							);
							if (!answer)
								return {
									...result,
									answers: {},
									stopReason: "error" as const,
									errorMessage: `incompatible answer for question "${id}"`,
								};
							Object.defineProperty(validated, id, {
								value: answer,
								enumerable: true,
								configurable: true,
								writable: true,
							});
						}
						const stopped = requestInterruption(flight, deadline, opts.signal);
						if (stopped) return { ...result, ...stopped, answers: {} };
						for (const [id, key] of misses) {
							flight.review?.unresolved.delete(id);
							persistJudgment(
								flight,
								key,
								validated[id],
								backend,
								modelId,
								thinkingLevel,
								opts.fresh,
							);
						}
						return { ...result, answers: validated };
					})
					.then(async (result) => {
						const stopped = requestInterruption(flight, deadline, opts.signal);
						if (stopped) return { ...result, ...stopped, answers: {} };
						if (result.stopReason !== "error" || !isContextOverflow(result))
							return result;
						recovering = true;
						// Existing waiters retain this completion promise; recursive leaves
						// must not look up their own failed parent's pending entries.
						settlePending(
							flight.cacheRef,
							misses.map(([, key]) =>
								pendingKey(flight.cacheRef, opts.fresh, key),
							),
						);
						recordCapacity(flight, profile, capacityChannel, {
							outcome: "overflow",
							stateBytes: size.stateBytes,
							questionBytes: size.questionBytes,
							longestQuestionBytes: size.longestQuestionBytes,
						});
						flight.cacheRef.rejected.add(envelope);
						ledger({ kind: "rejected", envelope });
						const recovered = await subdivide(
							batch,
							questions,
							isFinalStage,
							projection,
							constraint,
							missQuestions,
						);
						const afterRecovery = requestInterruption(
							flight,
							deadline,
							opts.signal,
						);
						if (afterRecovery)
							return { ...result, ...afterRecovery, answers: {} };
						return {
							...result,
							answers: recovered ? stageRawAnswers : {},
							stopReason: recovered ? ("stop" as const) : total.stopReason,
							errorMessage: recovered ? undefined : total.errorMessage,
						};
					});
				for (const [id, key] of misses) {
					const p: Promise<PendingJudgment> = run.then(
						(r) => ({
							stopReason: r.stopReason,
							answer:
								r.stopReason === "stop" && Object.hasOwn(r.answers, id)
									? r.answers[id]
									: undefined,
							errorMessage: r.errorMessage
								? redactString(r.errorMessage, secrets)
								: undefined,
							contextOverflow: r.stopReason === "error" && isContextOverflow(r),
						}),
						(error) => ({
							stopReason: "error",
							errorMessage: redactString(String(error), secrets),
						}),
					);
					// F6: register under the fresh-scoped pending key.
					trackPending(
						flight.cacheRef,
						pendingKey(flight.cacheRef, opts.fresh, key),
						p,
					);
				}
				const result = await run;
				const interruptedDispatch = requestInterruption(
					flight,
					deadline,
					opts.signal,
				);
				if (interruptedDispatch || result.stopReason === "aborted") {
					Object.assign(
						total,
						interruptedDispatch ?? {
							stopReason: "aborted",
							errorMessage: "backend classification aborted",
						},
					);
					// F7/F4: settle this batch's failed pending ownership so
					// nothing joins aborted work.
					settlePending(
						flight.cacheRef,
						misses.map(([, key]) =>
							pendingKey(flight.cacheRef, opts.fresh, key),
						),
					);
					return false;
				}
				if (recovering) return result.stopReason === "stop";
				if (result.stopReason === "error") {
					settlePending(
						flight.cacheRef,
						misses.map(([, key]) =>
							pendingKey(flight.cacheRef, opts.fresh, key),
						),
					);
					total.stopReason = "error";
					total.errorMessage = redactString(
						result.errorMessage ?? "backend classification failed",
						secrets,
					);
					return false;
				}
				// Answered: observe usage for calibration (F4: guarded).
				recordCapacity(flight, profile, capacityChannel, {
					outcome: "answered",
					inputTokens: flight.review
						? flight.review.attempts.at(-1)?.inputTokens
						: result.usage?.input,
					stateBytes: size.stateBytes,
					questionBytes: size.questionBytes,
					longestQuestionBytes: size.longestQuestionBytes,
				});
				for (const [id] of misses) {
					const hasOwn = Object.hasOwn(result.answers, id);
					const raw = hasOwn
						? (result.answers as Record<string, unknown>)[id]
						: undefined;
					const answer = validateAnswer(questions[id], raw);
					if (answer)
						Object.defineProperty(answers, id, {
							value: answer,
							enumerable: true,
							writable: true,
							configurable: true,
						});
				}
			}
			// 3. Joins (F5: each join is bounded by THIS caller's deadline/
			// abort; the owner's promise is never canceled). F4: joins resolve
			// against the promise captured at lookup time — an owner's cache
			// generation never changes a joiner's already-captured promise.
			for (const [id, key, promise] of joins) {
				const joined = await bounded(promise, deadline, opts.signal);
				const stoppedJoin = requestInterruption(flight, deadline, opts.signal);
				if (stoppedJoin) {
					Object.assign(total, stoppedJoin);
					return false;
				}
				if (!joined || joined.stopReason !== "stop") {
					total.stopReason = joined?.stopReason ?? "error";
					total.errorMessage =
						joined?.errorMessage ?? "shared classification failed";
					if (joined?.contextOverflow) total.contextOverflow = true;
					return false;
				}
				if (joined.answer !== undefined) {
					const validated = validateAnswer(questions[id], joined.answer);
					if (validated) {
						flight.review?.unresolved.delete(id);
						persistJudgment(
							flight,
							key,
							validated,
							backend,
							modelId,
							thinkingLevel,
							opts.fresh,
						);
						Object.defineProperty(answers, id, {
							value: validated,
							enumerable: true,
							writable: true,
							configurable: true,
						});
					}
				}
			}
			// 4. (F3) Intermediate-stage answers are ADVISORY ONLY: they update
			// `previousAnswers` for later stages and nothing else. The caller's
			// policy is applied exactly once — below, on the completed FINAL
			// stage's RAW answers.
			stageRawAnswers = answers;
			checkpoint(
				batch,
				projection,
				questions,
				stagePrior,
				isFinalStage,
				answers,
			);
			// Explicitly withheld scopes are not missing native response members:
			// no checkpoint advances, but independent final choices remain usable.
			if (projection.unresolved?.length && !isFinalStage) {
				total.stopReason = "error";
				total.errorMessage =
					"intermediate stage has locally unresolved required questions";
				return false;
			}
			if (!isFinalStage) {
				previousAnswers = flight.review
					? answers
					: { ...previousAnswers, ...answers };
				return true;
			}
			// Final stage: build the caller's accepted view from THESE answers.
			// Own-key lookup only: an inherited `constructor`/`toString` value
			// is never treated as an answer (F2).
			const finalAnswers: Record<string, ClassifierAnswer> = {};
			const finalDropped: string[] = [];
			for (const id of qIds) {
				const answer: ClassifierAnswer | undefined = Object.hasOwn(answers, id)
					? (answers as Record<string, ClassifierAnswer>)[id]
					: undefined;
				if (!answer) {
					if (total.stopReason === "stop") {
						total.stopReason = "error";
						total.errorMessage = `backend returned no answer for question "${id}"`;
					}
					continue;
				}
				if (accepted(answer, backend, id, policy)) {
					Object.defineProperty(finalAnswers, id, {
						value: answer,
						enumerable: true,
						writable: true,
						configurable: true,
					});
				} else {
					finalDropped.push(id);
				}
			}
			// Replace, never accumulate: the final view is exactly this stage's.
			total.answers = finalAnswers;
			total.dropped = finalDropped;
			return true;
		};

		/** Keep question-bound work on one factual stage; otherwise reduce evidence. */
		async function subdivide(
			batch: FramedEvidence[],
			questions: Record<string, ClassifierQuestion>,
			isFinalStage: boolean,
			projection: ReviewStageProjection,
			constraint: CapacityConstraint | undefined,
			unanswered: Record<string, ClassifierQuestion>,
		): Promise<boolean> {
			const qIds = Object.keys(questions);
			const halvesQ = splitQuestions(qIds);
			const halvesE = splitPiece(batch);
			let evidenceFirst = false;
			if (flight.review && halvesE && halvesQ) {
				if (constraint === "state") evidenceFirst = true;
				else if (constraint === "request") {
					const size = sizeFor(
						batch,
						unanswered,
						projection.state,
						previousAnswers,
						isFinalStage,
					);
					// If even one longest question cannot fit beside this state,
					// question batching alone cannot remove the request pressure.
					const single = overflowConstraint(
						profile,
						{ ...size, questionBytes: size.longestQuestionBytes },
						limits,
					);
					evidenceFirst = single === "request" || single === "state";
				} else {
					// An unclassified rejection does not identify a token dimension.
					// Compare actual envelope reductions; do not infer it from record count.
					const bytes = (
						frames: FramedEvidence[],
						qs: Record<string, ClassifierQuestion>,
					) => {
						const size = sizeFor(
							frames,
							qs,
							projection.state,
							previousAnswers,
							isFinalStage,
						);
						return size.stateBytes + size.questionBytes;
					};
					const questionSize = Math.max(
						...halvesQ.map((ids) =>
							bytes(
								batch,
								Object.fromEntries(
									ids
										.filter((id) => Object.hasOwn(unanswered, id))
										.map((id) => [id, unanswered[id]]),
								),
							),
						),
					);
					const evidenceSize = Math.max(
						...halvesE.map((frames) => bytes(frames, unanswered)),
					);
					evidenceFirst = evidenceSize < questionSize;
				}
			}
			if (halvesQ && !evidenceFirst) {
				// Merge ONLY question subtrees over this same state/evidence.
				// Each evidence subtree still replaces its own final view.
				const answers: Record<string, ClassifierAnswer> = {};
				const raw: Record<string, ClassifierAnswer> = {};
				const dropped = new Set<string>();
				const prior = previousAnswers;
				const revision = evidenceRevision;
				let advisory = prior;
				for (const half of halvesQ) {
					previousAnswers = prior;
					const sub = Object.fromEntries(half.map((id) => [id, questions[id]]));
					if (!(await stage(batch, sub, isFinalStage, projection)))
						return false;
					// A question subtree may discover state pressure. Its evidence
					// recovery has already evaluated the full stage's questions.
					if (evidenceRevision !== revision) return true;
					Object.defineProperties(
						raw,
						Object.getOwnPropertyDescriptors(stageRawAnswers),
					);
					if (!isFinalStage) advisory = { ...advisory, ...previousAnswers };
					if (isFinalStage) {
						Object.defineProperties(
							answers,
							Object.getOwnPropertyDescriptors(total.answers),
						);
						for (const id of total.dropped) dropped.add(id);
					}
				}
				stageRawAnswers = raw;
				checkpoint(batch, projection, questions, prior, isFinalStage, raw);
				previousAnswers = isFinalStage ? prior : advisory;
				if (isFinalStage) {
					total.answers = answers;
					total.dropped = [...dropped];
				}
				return true;
			}
			if (halvesE) {
				// Promote an insufficient question split into ONE complete evidence
				// traversal, not a traversal per sibling question batch.
				if (flight.review) evidenceRevision++;
				const wholeQuestions = flight.review ? projection.questions : questions;
				if (!(await stage(halvesE[0], wholeQuestions, false))) return false;
				return await stage(halvesE[1], wholeQuestions, isFinalStage);
			}
			// Irreducible: fixed state plus one minimum unit cannot fit.
			total.stopReason = "error";
			total.contextOverflow = true;
			total.errorMessage =
				"context overflow: the required fixed state plus one irreducible unit cannot fit; reduce state or evidence";
			return false;
		}

		// Evidence batches: whole set as one piece first.
		if (evidence.length > 0) {
			if (!(await stage(evidence, request.questions, true))) {
				return finish(total, usages, backend, modelId, flight);
			}
		} else if (!(await stage([], request.questions, true))) {
			return finish(total, usages, backend, modelId, flight);
		}

		return finish(total, usages, backend, modelId, flight);
	}

	function finish(
		total: StageRun,
		usages: Usage[],
		backend: "classifier" | "llm",
		modelId: string,
		flight: InFlight,
	): JudgeResult {
		const result: JudgeResult = {
			answers: total.stopReason === "stop" ? total.answers : {},
			dropped: total.stopReason === "stop" ? total.dropped : [],
			backend,
			model: modelId,
			stopReason: total.stopReason,
			reuse: total.reuse,
		};
		if (total.errorMessage) result.errorMessage = total.errorMessage;
		if (total.contextOverflow) result.contextOverflow = true;
		if (usages.length > 0) result.usage = sumUsage(usages);
		// F4: judgment commits flush ONLY for a completed non-aborted request
		// that still owns the live cache. An aborted request persists no new
		// judgments; a stale request (branch switched) writes nothing to the
		// new branch.
		if (total.stopReason !== "aborted") flushJudgments(flight);
		// One compact accounting record per request (counts only, never
		// bodies) — only when this request still owns the live cache.
		if (ownsLiveCache(flight)) {
			ledger({
				kind: "diag",
				backend,
				model: modelId,
				hits: total.reuse.hits,
				joined: total.reuse.joined,
				sent: total.reuse.sent,
				inputTokens: result.usage?.input ?? 0,
				outputTokens: result.usage?.output ?? 0,
				outcome: total.stopReason,
			});
		}
		return result;
	}

	return service;
}

/**
 * Wrapper state for one stage: fixed state, current evidence batch and
 * advisory previous answers, plus final-stage marker. Fixed state is never
 * mutated by subdivision.
 */
function stageState(
	state: JsonObject,
	batch: FramedEvidence[],
	previousAnswers: Record<string, ClassifierAnswer>,
	isFinalStage: boolean,
): JsonObject {
	const out: JsonObject = {
		fixed: state,
		// Model-facing evidence: caller records with bounds projected OUTSIDE
		// metadata (`fragmentBounds`), never a mutation of caller JSON.
		evidence: toModelEvidence(batch),
		previousAnswers: previousAnswers as unknown as JsonValue,
		progress: {
			processedBytes: batch.reduce((s, f) => s + f.record.text.length, 0),
			final: isFinalStage,
		},
	};
	return out;
}
