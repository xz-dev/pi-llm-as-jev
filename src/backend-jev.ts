/**
 * Native classifier backend (design D3, version two waiting contract).
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
 *
 * Waiting: the caller's combined attempt signal bounds the whole native
 * classification; a non-streaming adapter simply idles out when it produces
 * no progress within the idle window.
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
		options?: {
			signal?: AbortSignal;
			timeoutMs?: number;
			fetch?: typeof globalThis.fetch;
		},
	): Promise<ClassifierResult>;
}

/** Renamed native registry surface; `JevRegistry` is kept for compatibility. */
export type NativeRegistry = JevRegistry;

export interface JevClassifyOptions {
	/** Combined attempt signal owned by the caller's clocks. */
	signal?: AbortSignal;
	/** Genuine-generation callback; native adapters rarely stream, so this is advisory. */
	progress?: () => void;
	/** Public HTTP transport seam; defaults to global fetch. */
	fetch?: typeof globalThis.fetch;
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
 * codepoint order as a deterministic tiebreak. Returns undefined when no
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
 * Race a registry promise against the caller's combined attempt signal so
 * the caller settles even when the registry never observes it. The guarded
 * promise is left un-awaited; a late registry resolution is dropped.
 */
async function guarded<T>(
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

/**
 * Pinned dispatch (handoff to core): classify with an ALREADY-SELECTED
 * model. Dispatch never rediscovers, so a changed catalog can never
 * substitute a different model mid-request. The caller's combined attempt
 * signal (idle + optional hard + caller abort) bounds the whole call; this
 * module starts no second competing clock.
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
	let classification: Promise<ClassifierResult>;
	try {
		classification = registry.classify(model, context, {
			signal: options?.signal,
			...(options?.fetch ? { fetch: options.fetch } : {}),
		});
	} catch (error) {
		if (options?.signal?.aborted) {
			return { ...resultShell(), stopReason: "aborted" };
		}
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

	let winner: ClassifierResult | undefined;
	try {
		winner = await guarded(classification, options?.signal);
	} catch (error) {
		if (options?.signal?.aborted) {
			return { ...resultShell(), stopReason: "aborted" };
		}
		return {
			...resultShell(),
			provider: model.provider,
			model: model.id,
			errorMessage: `Native classification failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	if (winner === undefined) {
		// Settled through the signal race: the owning attempt reports the
		// exact clock that fired (idle vs hard vs caller abort).
		return { ...resultShell(), stopReason: "aborted" };
	}
	if (winner.stopReason === "aborted" && options?.signal?.aborted) {
		return winner;
	}
	return winner;
}
