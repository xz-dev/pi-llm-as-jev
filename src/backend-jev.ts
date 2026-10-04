/**
 * Native classifier backend (design D3).
 *
 * Selection honors an explicit `classifierModel` (`provider/modelid`)
 * exactly — including compatible non-Jev models — and otherwise falls back
 * to Jev identity/provider-priority discovery. This plugin's `llm-as-jev`
 * emulation provider is never a native candidate. Dispatch goes through
 * `modelRegistry.classify()` so authentication, credentials and usage stay
 * owned by the host registry.
 *
 * Handoff to core: after `resolveNativeClassifier` picks a model, dispatch
 * MUST go through `classifyWithModel` with that already-selected model so a
 * changed catalog can never substitute a different model mid-request.
 * `classifyWithJev` retains standalone Jev discovery+dispatch for existing
 * callers; `classifyWithNative` composes selection + pinned dispatch.
 */

import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import { EMULATED_PROVIDER_ID } from "./provider.js";

/** Any classifier model regardless of api. */
type AnyClassifierModel = import("@earendil-works/pi-ai").ClassifierModel<
	import("@earendil-works/pi-ai").ClassifierApi
>;

/** Preference order for providers hosting real Jev classifiers (D3). */
export const JEV_PROVIDER_PRIORITY: readonly string[] = [
	"typesafe",
	"openrouter",
	"cloudflare-workers-ai",
	"vercel-ai-gateway",
	"opencode",
];

/** Structural slice of `Models` used by the native backend. */
export interface JevRegistry {
	getAvailableOfType(
		type: "classifier",
		providerId?: string,
		options?: { signal?: AbortSignal },
	): Promise<readonly AnyClassifierModel[]>;
	classify(
		model: AnyClassifierModel,
		context: ClassifierContext,
		options?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<ClassifierResult>;
}

/** Renamed native registry surface; `JevRegistry` is kept for compatibility. */
export type NativeRegistry = JevRegistry;

export interface JevClassifyOptions {
	signal?: AbortSignal;
	/** Deadline shared across discovery and classification, not reset per leaf. */
	timeoutMs?: number;
}

/**
 * Jev model identity: the last path segment of the model id is `jev` or a
 * `jev-*` variant. Filters actual Jev identities, not arbitrary classifiers
 * that happen to live on supported providers (kev, tev, span, mercury, d1).
 */
export function isJevClassifierModel(model: AnyClassifierModel): boolean {
	if (model.provider === EMULATED_PROVIDER_ID) return false;
	const lastSegment = model.id.slice(model.id.lastIndexOf("/") + 1);
	return /^jev(?:$|[-_])/i.test(lastSegment);
}

/**
 * Pick one Jev classifier by provider priority, then `provider/id`
 * localeCompare as a deterministic tiebreak. Returns undefined when no
 * candidate is a Jev identity.
 */
export function selectJevModel(
	models: readonly AnyClassifierModel[],
): AnyClassifierModel | undefined {
	const candidates = models.filter(isJevClassifierModel);
	if (candidates.length === 0) return undefined;
	return candidates.sort((a, b) => {
		const rankA = JEV_PROVIDER_PRIORITY.indexOf(a.provider);
		const rankB = JEV_PROVIDER_PRIORITY.indexOf(b.provider);
		if (rankA !== rankB) {
			return (
				(rankA === -1 ? JEV_PROVIDER_PRIORITY.length : rankA) -
				(rankB === -1 ? JEV_PROVIDER_PRIORITY.length : rankB)
			);
		}
		if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
		// Codepoint compare: localeCompare ordering is locale-dependent.
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	})[0];
}

/**
 * Discover the highest-priority available Jev classifier, if any.
 */
export async function findJevModel(
	registry: JevRegistry,
	options?: { signal?: AbortSignal },
): Promise<AnyClassifierModel | undefined> {
	const available = await registry.getAvailableOfType("classifier", undefined, {
		signal: options?.signal,
	});
	return selectJevModel([...available]);
}

/** Options selecting the native candidate (explicit reference or default). */
export interface NativeSelection {
	/** Explicit `provider/modelid`; when present it is honored exactly. */
	classifierModel?: string;
	/** Pre-split provider portion of `classifierModel` (from config). */
	classifierProvider?: string;
	/** Pre-split model id portion of `classifierModel` (may contain slashes). */
	classifierModelId?: string;
}

/** Split `provider/modelid` on the FIRST slash; undefined parts when malformed. */
function splitReference(value: string): {
	provider?: string;
	modelId?: string;
} {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return {};
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

/**
 * Resolve the native candidate for this request.
 *
 * Explicit reference: match the AVAILABLE compatible classifier with exactly
 * this `provider`/`id`; the registry's availability already encodes adapter
 * compatibility — no invented api whitelist. Own emulation is excluded.
 * Missing/unavailable references return a structured error that names the
 * selection and never substitutes another native model.
 *
 * No reference: retain Jev identity + provider-priority discovery.
 */
export async function resolveNativeClassifier(
	registry: JevRegistry,
	selection: NativeSelection,
	options?: { signal?: AbortSignal },
): Promise<
	{ model: AnyClassifierModel } | { error: string; selection?: string }
> {
	const available = await registry.getAvailableOfType("classifier", undefined, {
		signal: options?.signal,
	});
	const compatible = [...available].filter(
		(model) => model.provider !== EMULATED_PROVIDER_ID,
	);

	let provider = selection.classifierProvider;
	let modelId = selection.classifierModelId;
	if (selection.classifierModel !== undefined) {
		if (provider === undefined || modelId === undefined) {
			const ref = splitReference(selection.classifierModel);
			provider = provider ?? ref.provider;
			modelId = modelId ?? ref.modelId;
		}
	}
	if (provider !== undefined && modelId !== undefined) {
		const found = compatible.find(
			(model) => model.provider === provider && model.id === modelId,
		);
		if (found) return { model: found };
		return {
			error: `configured classifier ${provider}/${modelId} is not available`,
			selection: `${provider}/${modelId}`,
		};
	}
	if (selection.classifierModel !== undefined) {
		// Malformed explicit reference (not provider/modelid): still an
		// unavailable explicit selection, never default discovery.
		return {
			error: `configured classifier ${JSON.stringify(selection.classifierModel)} is not in provider/modelid form`,
			selection: selection.classifierModel,
		};
	}
	const jev = selectJevModel(compatible);
	return jev
		? { model: jev }
		: {
				error:
					"No Jev classifier model is available from any configured provider",
			};
}

function resultShell(): ClassifierResult {
	return {
		api: "typesafe-system-one" as ClassifierApi,
		provider: "",
		model: "",
		answers: {},
		stopReason: "error",
		timestamp: Date.now(),
	};
}

/**
 * One combined caller/deadline signal applied across discovery and
 * classification (D3: the deadline is not reset for each leaf). The abort
 * reason records whether the caller or the deadline fired, so expiry and
 * caller abort stay distinguishable.
 */
function deadlineSignal(
	options: JevClassifyOptions | undefined,
	deadline: number | null,
): {
	signal: AbortSignal | undefined;
	expired: () => boolean;
	cleanup: () => void;
} {
	if (!options?.signal && deadline === null) {
		return { signal: undefined, expired: () => false, cleanup: () => {} };
	}
	const controller = new AbortController();
	let callerAborted = false;
	let timedOut = false;
	const caller = options?.signal;
	const onCallerAbort = () => {
		callerAborted = true;
		controller.abort();
	};
	if (caller) {
		if (caller.aborted) {
			onCallerAbort();
		} else {
			caller.addEventListener("abort", onCallerAbort, { once: true });
		}
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	if (deadline !== null) {
		timer = setTimeout(
			() => {
				timedOut = true;
				controller.abort();
			},
			Math.max(0, deadline - Date.now()),
		);
	}
	return {
		signal: controller.signal,
		expired: () =>
			callerAborted
				? false
				: timedOut || (deadline !== null && Date.now() >= deadline),
		cleanup: () => {
			if (timer !== undefined) clearTimeout(timer);
			if (caller) {
				caller.removeEventListener("abort", onCallerAbort);
			}
		},
	};
}

/**
 * Race a registry promise against caller abort and deadline expiry so the
 * caller settles even when the registry never observes its signal. The
 * guarded promise is left un-awaited; a late registry resolution is dropped.
 */
async function guardRace<T>(
	promise: Promise<T>,
	deadline: number | null,
	signal: AbortSignal | undefined,
	expired: () => boolean,
): Promise<{ value: T } | { timeout: true } | { aborted: true }> {
	if (deadline === null && !signal) return { value: await promise };
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const settleAbort = (
		resolve: (r: { timeout: true } | { aborted: true }) => void,
	) => {
		// Deadline-driven abort is a timeout, not a caller abort.
		resolve(expired() ? { timeout: true } : { aborted: true });
	};
	try {
		return (await Promise.race([
			promise.then((value) => ({ value }) as const),
			new Promise<{ timeout: true } | { aborted: true }>((resolve) => {
				if (deadline !== null) {
					timer = setTimeout(
						() => resolve({ timeout: true }),
						Math.max(0, deadline - Date.now()),
					);
				}
				if (signal) {
					if (signal.aborted) settleAbort(resolve);
					else {
						onAbort = () => settleAbort(resolve);
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
 * @deprecated Prefer `resolveNativeClassifier` + `classifyWithModel`. Kept
 * for existing callers/tests: equivalent to `classifyWithNative` with no
 * explicit selection (Jev discovery only).
 */
export async function classifyWithJev(
	registry: JevRegistry,
	context: ClassifierContext,
	options?: JevClassifyOptions,
): Promise<ClassifierResult> {
	return classifyWithNative(registry, {}, context, options);
}

/** Options for the pinned-model dispatch handoff (`classifyWithModel`). */
export interface NativeClassifyOptions extends JevClassifyOptions {}

/**
 * Pinned dispatch (handoff to core): classify with an ALREADY-SELECTED
 * model. Dispatch never rediscovers, so a changed catalog can never
 * substitute a different model mid-request. Selection stays in
 * `resolveNativeClassifier`; combined discovery+dispatch for legacy callers
 * stays in `classifyWithJev`/`classifyWithNative`.
 */
export async function classifyWithModel(
	registry: JevRegistry,
	model: AnyClassifierModel,
	context: ClassifierContext,
	options?: JevClassifyOptions,
): Promise<ClassifierResult> {
	if (options?.signal?.aborted) {
		return { ...resultShell(), stopReason: "aborted" };
	}
	const deadline =
		options?.timeoutMs !== undefined ? Date.now() + options.timeoutMs : null;
	const { signal, expired, cleanup } = deadlineSignal(options, deadline);
	try {
		return await classifySelected(
			registry,
			model,
			context,
			options,
			deadline,
			signal,
			expired,
		);
	} finally {
		cleanup();
	}
}

/**
 * Selection + pinned dispatch composed for existing callers. Explicit
 * `classifierModel` pins the candidate; otherwise Jev discovery applies.
 */
export async function classifyWithNative(
	registry: JevRegistry,
	selection: NativeSelection,
	context: ClassifierContext,
	options?: JevClassifyOptions,
): Promise<ClassifierResult> {
	if (options?.signal?.aborted) {
		return { ...resultShell(), stopReason: "aborted" };
	}
	const deadline =
		options?.timeoutMs !== undefined ? Date.now() + options.timeoutMs : null;
	const { signal, expired, cleanup } = deadlineSignal(options, deadline);
	try {
		return await classifyWithNativeGuarded(
			registry,
			selection,
			context,
			options,
			deadline,
			signal,
			expired,
		);
	} finally {
		cleanup();
	}
}

async function classifyWithNativeGuarded(
	registry: JevRegistry,
	selection: NativeSelection,
	context: ClassifierContext,
	options: JevClassifyOptions | undefined,
	deadline: number | null,
	signal: AbortSignal | undefined,
	expired: () => boolean,
): Promise<ClassifierResult> {
	const timeoutError = (): ClassifierResult => ({
		...resultShell(),
		errorMessage: `Native classifier timed out after ${options?.timeoutMs}ms`,
	});

	// Discovery: settle even when the registry ignores the abort signal.
	let model: AnyClassifierModel | undefined;
	try {
		const raced = await guardRace(
			resolveNativeClassifier(registry, selection, { signal }),
			deadline,
			signal,
			expired,
		);
		if ("timeout" in raced) return timeoutError();
		if ("aborted" in raced) return { ...resultShell(), stopReason: "aborted" };
		if ("error" in raced.value) {
			return { ...resultShell(), errorMessage: raced.value.error };
		}
		model = raced.value.model;
	} catch (error) {
		if (options?.signal?.aborted) {
			return { ...resultShell(), stopReason: "aborted" };
		}
		if (expired()) return timeoutError();
		return {
			...resultShell(),
			errorMessage: `Native classifier discovery failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	if (options?.signal?.aborted) {
		return { ...resultShell(), stopReason: "aborted" };
	}
	if (!model) {
		return {
			...resultShell(),
			errorMessage:
				"No Jev classifier model is available from any configured provider",
		};
	}
	return classifySelected(
		registry,
		model,
		context,
		options,
		deadline,
		signal,
		expired,
	);
}

/**
 * Dispatch one frozen model through `registry.classify`. The `signal`
 * argument is the combined caller/deadline signal from the caller's
 * `deadlineSignal()` when dispatched via `classifyWithNative`/`classifyWithModel`;
 * standalone direct calls may pass the caller signal itself.
 * Caller abort beats deadline: a registry "aborted" caused by our own
 * deadline is a timeout, never a caller abort.
 */
async function classifySelected(
	registry: JevRegistry,
	model: AnyClassifierModel,
	context: ClassifierContext,
	options: JevClassifyOptions | undefined,
	deadline: number | null,
	signal: AbortSignal | undefined,
	expired: () => boolean,
): Promise<ClassifierResult> {
	const timeoutError = (): ClassifierResult => ({
		...resultShell(),
		errorMessage: `Native classifier timed out after ${options?.timeoutMs}ms`,
	});
	// No dispatch after the deadline has expired (a non-positive remaining
	// budget counts as expired: there is nothing left to spend).
	const remaining =
		deadline !== null ? deadline - Date.now() : Number.POSITIVE_INFINITY;
	if (expired() || remaining <= 0) return timeoutError();
	let classification: Promise<ClassifierResult>;
	try {
		classification = registry.classify(model, context, {
			signal,
			timeoutMs: Number.isFinite(remaining) ? remaining : undefined,
		});
	} catch (error) {
		if (options?.signal?.aborted) {
			return { ...resultShell(), stopReason: "aborted" };
		}
		if (expired()) return timeoutError();
		// Registry classify never rejects in practice; keep the no-throw contract.
		return {
			...resultShell(),
			provider: model.provider,
			model: model.id,
			errorMessage: `Native classification failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}

	let winner: ClassifierResult;
	try {
		const raced = await guardRace(classification, deadline, signal, expired);
		if ("timeout" in raced) return timeoutError();
		if ("aborted" in raced) return { ...resultShell(), stopReason: "aborted" };
		winner = raced.value;
	} catch (error) {
		if (options?.signal?.aborted) {
			return { ...resultShell(), stopReason: "aborted" };
		}
		if (expired()) return timeoutError();
		return {
			...resultShell(),
			provider: model.provider,
			model: model.id,
			errorMessage: `Native classification failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	if (winner.stopReason === "aborted" && options?.signal?.aborted) {
		return winner;
	}
	// A registry "aborted" caused by our own deadline (not the caller) is a timeout.
	if (winner.stopReason === "aborted" && expired()) return timeoutError();
	return winner;
}
