/**
 * Stateless judgment service (version two). Owns backend selection
 * (auto|classifier|llm), per-attempt progress-idle and optional hard clocks,
 * Jev threshold policy, known-key redaction and caller/lifecycle
 * cancellation. NO completed-answer caching, in-flight joins, evidence
 * subdivision, checkpoints, ledgers, learned capacity or attempt accounting:
 * identical calls perform independent inference and callers own all durable
 * business state. `judge()` NEVER throws: every failure resolves through
 * `stopReason`/`errorMessage`.
 */

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
	CapacityDisclosure,
	ClassifierAnswer,
	JudgeOptions,
	JudgeRequest,
	JudgeResult,
	JudgmentService,
	ThresholdRule,
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
	type EffectiveTimeouts,
	type JudgmentConfig,
	type JudgmentMode,
	type JudgmentThinkingLevel,
	resolveTimeouts,
} from "./config.js";
import { isContextOverflow, publicErrorMessage } from "./pipeline.js";
import { accepted, type ThresholdPolicy, validateAnswer } from "./policy.js";
import {
	type AuthResolvingRegistry,
	redactJson,
	redactString,
} from "./redaction.js";

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

export interface ServiceRuntime {
	registry: ServiceRegistry;
	config: () => JudgmentConfig;
	/** Optional embedding transport, forwarded through Pi's public native fetch option. */
	nativeFetch?: typeof globalThis.fetch;
	/** Fresh known-secrets snapshot; recomputed lazily by the lifecycle hook. */
	secrets?: () => readonly string[];
	/**
	 * Inference-blocking settings problem (e.g. legacy `timeoutMs` migration
	 * required). When set, `judge()` returns an actionable error and dispatches
	 * nothing; read-only status paths report it without rewriting settings.
	 */
	settingsBlock?: () => string | undefined;
}

/** Abort reason marking a generation-progress idle expiry. */
const IDLE_EXPIRED = Symbol("generation progress idle timeout");
/** Abort reason marking the whole-model-attempt hard expiry. */
const HARD_EXPIRED = Symbol("model attempt hard timeout");
/** Abort reason marking attempt retirement after failover. */
const ATTEMPT_RETIRED = Symbol("backend attempt retired after failover");

/**
 * One admitted model attempt's clocks (shared by the service and the direct
 * emulated-provider entry so both obey the same waiting semantics). The idle
 * clock is armed at construction and re-armed ONLY by `progress()` — a
 * nonempty text/thinking/tool-argument delta or a validated completed
 * question answer. The optional hard clock is armed once and never renews.
 * Both abort `controller`, so every wait in the attempt observes the same
 * combined signal; nested adapters receive that signal and must not start a
 * second competing hard budget.
 */
export interface AttemptClocks {
	/** Combined caller/idle/hard signal for the whole attempt. */
	readonly signal: AbortSignal;
	/** True once idle expired (and hard/caller did not fire first). */
	idleExpired(): boolean;
	/** True once the hard cap expired. */
	hardExpired(): boolean;
	/** Record genuine generation progress; renews the idle clock only. */
	progress(): void;
	/** Stop both timers; the attempt settled. */
	dispose(): void;
}

export function newAttemptClocks(
	effective: EffectiveTimeouts,
	callerSignal: AbortSignal | undefined,
): AttemptClocks {
	const controller = new AbortController();
	let idleHit = false;
	let hardHit = false;
	let settled = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const onCallerAbort = () => controller.abort(callerSignal?.reason);
	if (callerSignal) {
		if (callerSignal.aborted) onCallerAbort();
		else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
	}
	const armIdle = () => {
		if (settled) return;
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			idleHit = true;
			controller.abort(IDLE_EXPIRED);
		}, effective.idleTimeoutMs);
	};
	const hardTimer =
		effective.modelTimeoutMs !== undefined
			? setTimeout(() => {
					hardHit = true;
					controller.abort(HARD_EXPIRED);
				}, effective.modelTimeoutMs)
			: undefined;
	armIdle();
	return {
		signal: controller.signal,
		idleExpired: () => idleHit,
		hardExpired: () => hardHit,
		progress: armIdle,
		dispose: () => {
			settled = true;
			if (idleTimer !== undefined) clearTimeout(idleTimer);
			if (hardTimer !== undefined) clearTimeout(hardTimer);
			if (callerSignal)
				callerSignal.removeEventListener("abort", onCallerAbort);
		},
	};
}

/** Error thrown internally for invalid requests; converted to a result, never surfaced. */
class InvalidRequestError extends Error {}

type Candidate =
	| { backend: "classifier"; model: AnyClassifierModel }
	| { backend: "llm"; model: AnyModel }
	| { error: string };

/** Fixed backend order per mode: automatic modes allow ONE switch. */
function backendRoute(mode: JudgmentMode): ("classifier" | "llm")[] {
	switch (mode) {
		case "auto":
			return ["classifier", "llm"];
		case "auto-llm":
			return ["llm", "classifier"];
		default:
			return [mode];
	}
}

function unavailableSummary(mode: JudgmentMode): string {
	return mode === "auto-llm"
		? "no LLM model is configured or usable and no selected/default native classifier is available (llm-as-jev.json: model)"
		: "no selected/default native classifier is available and no LLM model is configured (llm-as-jev.json: model)";
}

/** Bounded per-candidate outcome text for a both-failed summary (already redacted). */
function boundedOutcome(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
}

const resultShell = (
	backend: "classifier" | "llm",
	model: string,
): JudgeResult => ({
	answers: {},
	dropped: [],
	backend,
	model,
	stopReason: "stop",
});

/** Option keys removed in version two: presence is an explicit error. */
const REMOVED_OPTION_FIELDS: readonly (keyof JudgeOptions)[] = [
	"timeoutMs",
	"fresh",
	"cache",
	"planStages",
	"projectStage",
	"projectionRevision",
	"checkpoint",
	"onProgress",
];

const validTimerField = (v: unknown): v is number =>
	typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 2_147_483_647;

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

function validateRequest(req: unknown): JudgeRequest {
	if (req === null || typeof req !== "object" || Array.isArray(req))
		throw new InvalidRequestError("request is not an object");
	const request = req as Record<string, unknown>;
	// Removed fields are rejected explicitly, never silently ignored: callers
	// must pack facts into `state`.
	if (Object.hasOwn(request, "evidence"))
		throw new InvalidRequestError(
			'"evidence" was removed in service version two; pack evidence records into state',
		);
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
	assertJsonValue(questions, "questions");
	const questionIds = Object.keys(questions);
	if (questionIds.length === 0)
		throw new InvalidRequestError("questions is empty");
	for (const id of questionIds) {
		const problem = validateQuestion(id, questions[id]);
		if (problem) throw new InvalidRequestError(problem);
	}
	return request as unknown as JudgeRequest;
}

function validatePolicy(opts: Record<string, unknown>): void {
	for (const field of REMOVED_OPTION_FIELDS) {
		if (Object.hasOwn(opts, field))
			throw new InvalidRequestError(
				`option "${field}" was removed in service version two`,
			);
	}
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
		assertJsonValue(opts.thresholds, "thresholds");
		for (const [id, rule] of Object.entries(
			opts.thresholds as Record<string, unknown>,
		)) {
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
	for (const field of ["idleTimeoutMs", "modelTimeoutMs"] as const) {
		const v = opts[field];
		if (v !== undefined && !validTimerField(v))
			throw new InvalidRequestError(
				`${field} must be a positive finite integer (milliseconds) within the timer range`,
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
 * Race a promise against an attempt's combined clock signal without
 * canceling the underlying work: a hung registry/auth/discovery promise can
 * never hold the public boundary. `undefined` means the attempt ended
 * (idle/hard/caller); rejections propagate to the caller's catch boundary.
 */
async function bounded<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T | undefined> {
	void promise.catch(() => {});
	if (!signal) return await promise;
	if (signal.aborted) return undefined;
	let onAbort: (() => void) | undefined;
	try {
		const raced = (await Promise.race([
			promise.then((value) => ({ value }) as const),
			new Promise<{ dropped: true }>((resolve) => {
				onAbort = () => resolve({ dropped: true });
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		])) as { value: T } | { dropped: true };
		return "value" in raced ? raced.value : undefined;
	} finally {
		if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
	}
}

// ---------------------------------------------------------------------------
// Service instance
// ---------------------------------------------------------------------------

/** One backend attempt's result and whether it permits the one switch. */
interface AttemptOutcome {
	result: JudgeResult;
	failover: boolean;
	/** Redacted service-authored outcome category for both-failed summaries. */
	summary: string;
	unavailable?: boolean;
}

export interface CreatedService extends JudgmentService {
	/** Internal status view: reuse its already-admitted settings snapshot. */
	availabilityFor(
		config: JudgmentConfig,
	): Promise<{ classifier?: string; llm?: string }>;
	/** Lifecycle hook: cancel all owned in-flight work (navigation/shutdown). */
	abortAll(): void;
}

export function createJudgmentService(runtime: ServiceRuntime): CreatedService {
	const active = new Set<AbortController>();
	let secrets: readonly string[] = runtime.secrets?.() ?? [];

	/**
	 * Resolve the SELECTED provider's credential through Pi only, bounded by
	 * the attempt's own clocks. Readiness never waits on unrelated providers;
	 * a late-resolving key still joins the redaction set.
	 */
	async function resolveSelectedSecret(
		providerId: string,
		signal: AbortSignal,
	): Promise<boolean> {
		try {
			const auth = await bounded(
				runtime.registry.getAuth(providerId).then((resolved) => {
					// Retain even late keys for redaction, never for late dispatch.
					const key = resolved?.auth?.apiKey;
					if (typeof key === "string" && key.length > 0)
						secrets = [...new Set([...secrets, key])];
					return resolved;
				}),
				signal,
			);
			// Pi resolves undefined for unknown/unconfigured providers. A
			// resolved auth object without an apiKey is valid (e.g. local/AWS).
			return auth?.auth !== undefined;
		} catch {
			return false;
		}
	}

	/** Lifecycle navigation: cancel owned work; no state to restore. */
	function abortAll(): void {
		for (const controller of active) controller.abort();
		secrets = runtime.secrets?.() ?? secrets;
	}

	/**
	 * Resolve ONE backend family lazily. Native: explicit selection honored
	 * exactly, else default Jev discovery; resolveNativeClassifier never
	 * substitutes another native model for a missing explicit selection.
	 */
	async function resolveCandidate(
		config: JudgmentConfig,
		backend: "classifier" | "llm",
		signal: AbortSignal | undefined,
	): Promise<Candidate> {
		if (backend === "llm") {
			const llm = llmChatModel(config);
			return llm
				? { backend: "llm", model: llm }
				: {
						error: `${config.mode === "llm" ? "mode is llm but " : ""}no LLM model is configured (llm-as-jev.json: model)`,
					};
		}
		const native = await resolveNativeClassifier(
			runtime.registry,
			nativeSelection(config),
			{ signal },
		);
		return "model" in native
			? { backend: "classifier", model: native.model }
			: { error: native.error };
	}

	/** Read-only candidate setup uses its own clocks and selected-provider readiness. */
	async function probeCandidate(
		config: JudgmentConfig,
		backend: "classifier" | "llm",
		signal?: AbortSignal,
	): Promise<Candidate> {
		if (signal?.aborted) return { error: "aborted" };
		const clocks = newAttemptClocks(
			resolveTimeouts(config, backend, undefined),
			signal,
		);
		try {
			const candidate = await bounded(
				(async () => {
					const resolved = await resolveCandidate(
						config,
						backend,
						clocks.signal,
					);
					if (clocks.signal.aborted || "error" in resolved) return resolved;
					return (await resolveSelectedSecret(
						resolved.model.provider,
						clocks.signal,
					))
						? resolved
						: { error: "selected provider authentication is unavailable" };
				})(),
				clocks.signal,
			);
			if (signal?.aborted) return { error: "aborted" };
			return candidate ?? { error: "backend selection timed out" };
		} catch (error) {
			return {
				error: publicErrorMessage(
					error instanceof Error ? error.message : String(error),
				),
			};
		} finally {
			clocks.dispose();
		}
	}

	/** Read-only view: the first ready candidate in the configured order. */
	async function resolveBackend(
		config: JudgmentConfig,
		signal: AbortSignal | undefined,
	): Promise<Candidate> {
		const route = backendRoute(config.mode);
		for (const backend of route) {
			const candidate = await probeCandidate(config, backend, signal);
			if (signal?.aborted) return { error: "aborted" };
			if (!("error" in candidate) || route.length === 1) return candidate;
		}
		return { error: unavailableSummary(config.mode) };
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
		_backend: "classifier" | "llm",
		model: AnyClassifierModel | AnyModel,
	): string {
		return `${model.provider}/${model.id}`;
	}

	/**
	 * Declared limits with their source (capacity v2). An exact configured
	 * override wins; otherwise model metadata (`contextWindow`); otherwise
	 * nothing. No built-in channel constants or learned values.
	 */
	function contextLimitsWithSource(
		model: AnyClassifierModel | AnyModel,
		config: JudgmentConfig,
	): {
		limits?: CapacityDisclosure["limits"];
		source: CapacityDisclosure["limitSource"];
	} {
		const ref = `${model.provider}/${model.id}`;
		if (config.contextLimits && Object.hasOwn(config.contextLimits, ref))
			return { limits: { ...config.contextLimits[ref] }, source: "override" };
		const window = model.contextWindow;
		return typeof window === "number" && window > 0
			? { limits: { contextWindow: window }, source: "model" }
			: { source: "none" };
	}

	/** Capacity block for disclosure: declared limits only (version two). */
	function capacityDisclosure(
		backend: "classifier" | "llm",
		model: AnyClassifierModel | AnyModel,
		modelId: string,
		config: JudgmentConfig,
	): CapacityDisclosure {
		const { limits, source } = contextLimitsWithSource(model, config);
		return {
			backend,
			model: modelId,
			limits: { ...limits },
			limitSource: source,
		};
	}

	const service: CreatedService = {
		version: 2,
		capacityVersion: 2,
		abortAll,

		async describeSelection(opts) {
			if (opts?.signal?.aborted) return { error: "aborted" };
			// Read-only current snapshot; every candidate owns fresh setup clocks.
			try {
				const config = structuredClone(runtime.config());
				const resolved = await resolveBackend(config, opts?.signal);
				if ("error" in resolved)
					return { error: redactString(resolved.error, secrets) };
				const { backend, model } = resolved;
				const modelId = modelIdentity(backend, model);
				return capacityDisclosure(backend, model, modelId, config);
			} catch (error) {
				return {
					error: redactString(
						publicErrorMessage(
							error instanceof Error ? error.message : String(error),
						),
						secrets,
					),
				};
			}
		},

		async availability() {
			try {
				return await service.availabilityFor(structuredClone(runtime.config()));
			} catch {
				return {}; // read-only readiness is best-effort
			}
		},

		async availabilityFor(
			config,
		): Promise<{ classifier?: string; llm?: string }> {
			const out: { classifier?: string; llm?: string } = {};
			for (const backend of ["classifier", "llm"] as const) {
				const candidate = await probeCandidate(config, backend);
				if (!("error" in candidate))
					out[backend] = modelIdentity(backend, candidate.model);
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
				const blocked = runtime.settingsBlock?.();
				if (blocked !== undefined)
					return {
						...resultShell("llm", ""),
						stopReason: "error",
						errorMessage: redactString(blocked, secrets),
					};
				return await judgeInner(rawReq, { ...rawOpts, signal });
			} catch (error) {
				return {
					...resultShell("llm", ""),
					stopReason: "error",
					errorMessage: redactString(
						publicErrorMessage(
							error instanceof Error ? error.message : String(error),
						),
						secrets,
					),
				};
			} finally {
				active.delete(controller);
			}
		},
	};

	/** Interrupted attempt: idle/hard expiry is a backend failure, caller abort is terminal. */
	function interruptedResult(
		flight: Flight,
		config: JudgmentConfig,
	): JudgeResult | undefined {
		const clocks = flight.clocks;
		if (flight.retired || clocks.signal.reason === ATTEMPT_RETIRED)
			return {
				...resultShell(
					flight.selected?.backend ?? "llm",
					flight.selected?.model ?? config.model ?? "",
				),
				stopReason: "aborted",
				errorMessage: "attempt retired after failover",
			};
		if (clocks.hardExpired() || clocks.signal.reason === HARD_EXPIRED)
			return {
				...resultShell(
					flight.selected?.backend ?? "llm",
					flight.selected?.model ?? config.model ?? "",
				),
				stopReason: "error",
				errorMessage: `model attempt timed out after ${flight.effective.modelTimeoutMs}ms`,
			};
		if (clocks.idleExpired() || clocks.signal.reason === IDLE_EXPIRED)
			return {
				...resultShell(
					flight.selected?.backend ?? "llm",
					flight.selected?.model ?? config.model ?? "",
				),
				stopReason: "error",
				errorMessage: `no generation progress for ${flight.effective.idleTimeoutMs}ms`,
			};
		if (clocks.signal.aborted)
			return {
				...resultShell(
					flight.selected?.backend ?? "llm",
					flight.selected?.model ?? config.model ?? "",
				),
				stopReason: "aborted",
				errorMessage: "request aborted by caller signal",
			};
		return undefined;
	}

	/** One admitted attempt's owned clocks and selected identity. */
	interface Flight {
		clocks: AttemptClocks;
		effective: EffectiveTimeouts;
		selected?: { backend: "classifier" | "llm"; model: string };
		/** Set once failover moves on: fences late publication. */
		retired?: boolean;
		/** A local orchestration fault ended the attempt: never failover permission. */
		localFault?: boolean;
	}

	/**
	 * One logical operation: admit ONE configuration snapshot, then run the
	 * mode's fixed backend route. Automatic modes switch at most once, only
	 * after an eligible backend failure; each attempt gets fresh independent
	 * clocks, while caller abort, navigation, invalid input and local faults
	 * stay terminal. A retired attempt is fenced: its late results cannot
	 * publish, and its partial answers never reach the final view.
	 */
	async function judgeInner(
		rawReq: unknown,
		rawOpts: JudgeOptions | undefined,
	): Promise<JudgeResult> {
		const config = structuredClone(runtime.config());
		// Admit synchronously before setup: caller-owned JSON/policy can change
		// during an await, but every attempt must evaluate this same snapshot.
		let request: JudgeRequest;
		let opts: JudgeOptions;
		try {
			const validated = validateRequest(rawReq);
			validatePolicy((rawOpts ?? {}) as Record<string, unknown>);
			crossValidateThresholds(validated.questions, rawOpts?.thresholds);
			request = structuredClone({
				state: validated.state,
				questions: validated.questions,
			});
			opts = {
				...structuredClone({
					minConfidence: rawOpts?.minConfidence,
					thresholds: rawOpts?.thresholds,
					idleTimeoutMs: rawOpts?.idleTimeoutMs,
					modelTimeoutMs: rawOpts?.modelTimeoutMs,
				}),
				signal: rawOpts?.signal,
			};
		} catch (error) {
			const message =
				error instanceof InvalidRequestError
					? error.message
					: publicErrorMessage(
							error instanceof Error ? error.message : String(error),
						);
			return {
				...resultShell("llm", config.model ?? ""),
				stopReason: "error",
				errorMessage: redactString(`invalid request: ${message}`, secrets),
			};
		}
		const policy: ThresholdPolicy = {
			default: opts.minConfidence,
			perQuestion: opts.thresholds ?? {},
		};
		const route = backendRoute(config.mode);
		const failures: string[] = [];
		let unavailableOnly = true;
		let outcome: AttemptOutcome | undefined;
		let resolvedFailure: JudgeResult | undefined;
		for (const backend of route) {
			if (outcome) {
				const shell = resultShell(outcome.result.backend, outcome.result.model);
				if (opts.signal?.aborted)
					return {
						...shell,
						stopReason: "aborted",
						errorMessage: "request aborted by caller signal",
					};
			}
			const flight: Flight = {
				clocks: newAttemptClocks(
					resolveTimeouts(config, backend, opts),
					opts.signal,
				),
				effective: resolveTimeouts(config, backend, opts),
			};
			try {
				outcome = await judgeAttempt(request, policy, flight, config, backend);
			} finally {
				flight.clocks.dispose();
			}
			if (!outcome.failover || route.length === 1) return outcome.result;
			flight.retired = true;
			failures.push(
				`${backend}${outcome.result.model ? ` ${outcome.result.model}` : ""}: ${boundedOutcome(outcome.summary)}`,
			);
			unavailableOnly &&= outcome.unavailable === true;
			if (!outcome.unavailable) resolvedFailure = outcome.result;
		}
		// Identify the terminal attempt that resolved a model, when any did.
		const terminal =
			(outcome?.unavailable
				? (resolvedFailure ?? outcome?.result)
				: outcome?.result) ?? resultShell("llm", config.model ?? "");
		const head = unavailableOnly
			? unavailableSummary(config.mode)
			: "both automatic backend attempts failed";
		return {
			...terminal,
			answers: {},
			dropped: [],
			stopReason: "error",
			contextOverflow: outcome?.result.contextOverflow,
			errorMessage: redactString(`${head} (${failures.join("; ")})`, secrets),
		};
	}

	/**
	 * One backend attempt of an admitted operation: redaction readiness and
	 * selection settle inside this attempt's own clocks, then one dispatch
	 * over the complete immutable request. `failover` marks an eligible
	 * backend failure; `summary` is service-authored text (never a raw
	 * provider body) used for a both-failed operation message.
	 */
	async function judgeAttempt(
		request: JudgeRequest,
		policy: ThresholdPolicy,
		flight: Flight,
		config: JudgmentConfig,
		family: "classifier" | "llm",
	): Promise<AttemptOutcome> {
		const terminal = (result: JudgeResult): AttemptOutcome => ({
			result,
			failover: false,
			summary: "",
		});
		const eligible = (
			result: JudgeResult,
			summary: string,
			unavailable = false,
		): AttemptOutcome => ({
			result,
			failover: true,
			summary,
			...(unavailable ? { unavailable } : {}),
		});
		/** Interruption: idle/hard expiry is a backend failure, aborts are terminal. */
		const stoppedOutcome = (result: JudgeResult): AttemptOutcome =>
			result.stopReason === "error"
				? eligible(result, result.errorMessage ?? "attempt timed out")
				: terminal(result);

		try {
			const beforeSelection = interruptedResult(flight, config);
			if (beforeSelection) return stoppedOutcome(beforeSelection);

			// Selection lives inside the attempt clocks: discovery hangs settle
			// through idle expiry, never through rejection or a late dispatch.
			let resolved: Candidate;
			try {
				const raced = await bounded(
					resolveCandidate(config, family, flight.clocks.signal),
					flight.clocks.signal,
				);
				if (raced === undefined) {
					const stopped = interruptedResult(flight, config) ?? {
						...resultShell(family, config.model ?? ""),
						stopReason: "error" as const,
						errorMessage: "selection did not settle within the attempt clocks",
					};
					return stoppedOutcome(stopped);
				}
				resolved = raced;
			} catch (error) {
				const stopped = interruptedResult(flight, config);
				if (stopped) return stoppedOutcome(stopped);
				return eligible(
					{
						...resultShell(
							family,
							(family === "classifier"
								? config.classifierModel
								: config.model) ?? "",
						),
						stopReason: "error",
						errorMessage: redactString(
							publicErrorMessage(
								error instanceof Error ? error.message : String(error),
							),
							secrets,
						),
					},
					`${family} selection failed`,
				);
			}
			if ("error" in resolved) {
				return eligible(
					{
						...resultShell(
							family,
							(family === "classifier"
								? config.classifierModel
								: config.model) ?? "",
						),
						stopReason: "error",
						errorMessage: redactString(resolved.error, secrets),
					},
					redactString(resolved.error, secrets),
					true,
				);
			}

			// Freeze the actual backend, model and effective thinking for the
			// whole attempt: a registry/config change mid-flight can never
			// substitute another model or level.
			const { backend, model } = resolved;
			const modelId = modelIdentity(backend, model);
			flight.selected = { backend, model: modelId };
			const thinkingLevel =
				backend === "llm"
					? effectiveThinkingLevel(model as AnyModel, config.thinkingLevel)
					: "none";
			const capacity = capacityDisclosure(backend, model, modelId, config);

			// The model's OWN provider credential joins the redaction set before
			// dispatch (a discovered native provider may differ from config).
			const ready = await resolveSelectedSecret(
				model.provider,
				flight.clocks.signal,
			);
			const beforeDispatch = interruptedResult(flight, config);
			if (beforeDispatch) return stoppedOutcome(beforeDispatch);
			if (!ready)
				return eligible(
					{
						...resultShell(backend, modelId),
						capacity,
						stopReason: "error",
						errorMessage: "selected provider authentication is unavailable",
					},
					"selected provider authentication is unavailable",
				);

			const attemptSecrets = [...secrets];
			const redacted = redactJson(request, attemptSecrets);
			// Redaction may rename schema keys. Reject ambiguity rather than
			// silently merging questions/labels or sending a credential as a key.
			if (
				Object.keys(redacted.questions).length !==
					Object.keys(request.questions).length ||
				Object.values(redacted.questions).some(
					(question) => validateQuestion("", question) !== undefined,
				) ||
				Object.values(request.questions).some(
					(question) =>
						question.type === "choice" &&
						new Set(
							Object.keys(question.criteria).map((label) =>
								redactString(label, attemptSecrets),
							),
						).size !== Object.keys(question.criteria).length,
				)
			)
				return terminal({
					...resultShell(backend, modelId),
					capacity,
					stopReason: "error",
					errorMessage:
						"question schema is ambiguous or invalid after credential redaction",
				});
			const context: ClassifierContext = {
				state: redacted.state,
				questions: redacted.questions,
			};

			const result = await dispatch(
				backend,
				model,
				context,
				flight,
				thinkingLevel,
			);

			const stopped = interruptedResult(flight, config);
			if (stopped)
				return stopped.stopReason === "error"
					? eligible(
							{ ...stopped, capacity },
							stopped.errorMessage ?? "attempt timed out",
						)
					: terminal({ ...stopped, capacity });
			// A late result from a retired attempt can never publish.
			if (flight.retired)
				return terminal({
					...resultShell(backend, modelId),
					capacity,
					stopReason: "aborted",
					errorMessage: "attempt retired after failover",
				});

			if (result.stopReason === "aborted")
				return terminal({
					...resultShell(backend, modelId),
					capacity,
					stopReason: "aborted",
					errorMessage: redactString(
						result.errorMessage
							? publicErrorMessage(result.errorMessage)
							: "request aborted",
						secrets,
					),
				});
			if (result.stopReason === "error") {
				// Overflow reads the RAW provider message before sanitization;
				// the public result carries only a service-authored summary
				// (status from a recognized SDK prefix), never a raw provider body.
				const overflow = isContextOverflow(result);
				const failed: JudgeResult = {
					...resultShell(backend, modelId),
					capacity,
					stopReason: "error",
					errorMessage: redactString(
						publicErrorMessage(
							result.errorMessage ?? "backend classification failed",
						),
						secrets,
					),
					...(overflow ? { contextOverflow: true as const } : {}),
				};
				return eligible(failed, failureSummary(failed, flight));
			}

			// Complete-result validation BEFORE policy filtering: an incomplete
			// or malformed raw result never publishes partial final answers.
			const answers: Record<string, ClassifierAnswer> = {};
			for (const id of Object.keys(request.questions)) {
				const wireId = redactString(id, attemptSecrets);
				const raw = Object.hasOwn(result.answers, wireId)
					? result.answers[wireId]
					: undefined;
				let answer = validateAnswer(redacted.questions[wireId], raw);
				const question = request.questions[id];
				if (answer?.type === "choice" && question.type === "choice") {
					const wireAnswer = answer;
					const labels = Object.keys(question.criteria);
					answer = validateAnswer(question, {
						...wireAnswer,
						choice: labels.find(
							(label) =>
								redactString(label, attemptSecrets) === wireAnswer.choice,
						),
						probabilities: Object.fromEntries(
							labels.map((label) => [
								label,
								wireAnswer.probabilities[redactString(label, attemptSecrets)],
							]),
						),
					});
				}
				if (!answer)
					return eligible(
						{
							...resultShell(backend, modelId),
							capacity,
							stopReason: "error",
							errorMessage: redactString(
								`incompatible answer for question "${id}"`,
								secrets,
							),
						},
						"invalid or incompatible output",
					);
				Object.defineProperty(answers, id, {
					value: answer,
					enumerable: true,
					writable: true,
					configurable: true,
				});
			}
			// Apply this caller's policy once to the freshly validated view.
			const finalAnswers: Record<string, ClassifierAnswer> = {};
			const dropped: string[] = [];
			for (const [id, answer] of Object.entries(answers)) {
				if (accepted(answer, backend, id, policy)) {
					Object.defineProperty(finalAnswers, id, {
						value: answer,
						enumerable: true,
						writable: true,
						configurable: true,
					});
				} else {
					dropped.push(id);
				}
			}
			return terminal({
				answers: finalAnswers,
				dropped,
				backend,
				model: modelId,
				stopReason: "stop",
				capacity,
				...(result.usage ? { usage: result.usage } : {}),
			});
		} catch (error) {
			// Absolute backstop: any residual throw resolves structurally.
			const stopped = interruptedResult(flight, config);
			if (stopped) return stoppedOutcome(stopped);
			const message = error instanceof Error ? error.message : String(error);
			return terminal({
				...resultShell(
					flight.selected?.backend ?? "llm",
					flight.selected?.model ?? config.model ?? "",
				),
				stopReason: "error",
				errorMessage: redactString(publicErrorMessage(message), secrets),
			});
		}
	}

	/**
	 * One backend dispatch over the complete immutable question set. The
	 * native path uses PINNED dispatch (`classifyWithModel`) with the frozen
	 * model; the LLM path receives the frozen effective thinking level. Both
	 * run entirely inside the attempt's combined clock signal; generation
	 * progress renews only the idle clock.
	 */
	async function dispatch(
		backend: "classifier" | "llm",
		model: AnyClassifierModel | AnyModel,
		context: ClassifierContext,
		flight: Flight,
		thinkingLevel: string,
	): Promise<ClassifierResult> {
		if (flight.clocks.signal.aborted) {
			return {
				api: (backend === "classifier"
					? model.api
					: "llm-as-jev") as ClassifierApi,
				provider: model.provider,
				model: model.id,
				answers: {},
				timestamp: Date.now(),
				stopReason: "aborted",
				errorMessage: "request aborted before dispatch",
			};
		}
		const options = {
			signal: flight.clocks.signal,
			progress: () => flight.clocks.progress(),
			fetch: runtime.nativeFetch,
		};
		// A settled-but-late result can never outlive the caller: race the
		// backend promise against the combined signal so a non-cooperative
		// adapter still settles the attempt.
		const run =
			backend === "classifier"
				? classifyWithModel(
						runtime.registry,
						model as AnyClassifierModel,
						context,
						options,
					)
				: llmClassify(runtime.registry, model as AnyModel, context, {
						thinkingLevel: thinkingLevel as JudgmentThinkingLevel,
						...options,
						onAnswer: () => flight.clocks.progress(),
					});
		const settled = await bounded(run, flight.clocks.signal);
		if (settled === undefined) {
			return {
				api: (backend === "classifier"
					? model.api
					: "llm-as-jev") as ClassifierApi,
				provider: model.provider,
				model: model.id,
				answers: {},
				timestamp: Date.now(),
				stopReason: "error",
				errorMessage: "attempt did not settle within its clocks",
			};
		}
		return settled;
	}

	/**
	 * Service-authored category for a failed attempt, never a provider body.
	 */
	function failureSummary(result: JudgeResult, flight: Flight): string {
		const message = result.errorMessage ?? "";
		if (result.contextOverflow || /context overflow/i.test(message))
			return "context overflow";
		if (
			flight.clocks.hardExpired() ||
			/timed out|no generation progress/i.test(message)
		)
			return `timed out after ${flight.effective.idleTimeoutMs}ms`;
		if (
			/did not return a valid|incompatible answer|returned no answer|lacks/i.test(
				message,
			)
		)
			return "invalid or incompatible output";
		return "provider or transport failure";
	}

	return service;
}
