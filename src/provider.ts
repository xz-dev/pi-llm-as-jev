/**
 * Native Pi classifier provider (design D5, form proven by the 1.2 spike).
 *
 * Registers `llm-as-jev` with `pi.registerProvider(provider)`, exposing zero
 * or one classifier model derived from the configured chat model. `classify`
 * delegates to the discrete LLM backend, so nested `streamSimple` resolves
 * real chat-provider authentication; the `emulated` marker key never reaches
 * the target endpoint. No chat models are listed, so nothing leaks into
 * `/model`.
 */

import type {
	Api,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	Model,
	Provider,
} from "@earendil-works/pi-ai";
import { type LlmRegistry, llmClassify } from "./backend-llm.js";
import type { JudgmentConfig } from "./config.js";

/** Any chat model regardless of api. */
type AnyModel = Model<Api>;
/** Any classifier model regardless of api. */
type AnyClassifierModel = ClassifierModel<ClassifierApi>;

export const EMULATED_PROVIDER_ID = "llm-as-jev";
/** Internal marker key; nested streaming resolves real credentials. */
const EMULATED_API_KEY = "emulated";

/** Registry slice the provider needs for availability checks. */
export interface ProviderRegistry {
	getModel(provider: string, id: string): AnyModel | undefined;
	checkAuth(providerId: string): Promise<{ source?: string } | undefined>;
}

export interface EmulatedClassifierOptions {
	registry: ProviderRegistry;
	config: JudgmentConfig;
}

/**
 * The single emulated classifier model, or undefined when no chat model is
 * configured. `id` is `provider/modelid`, `contextWindow`/`cost` copied from
 * the chat model.
 */
export function emulatedClassifierModel(
	config: JudgmentConfig,
): AnyClassifierModel | undefined {
	if (!config.provider || !config.modelId) return undefined;
	const id = `${config.provider}/${config.modelId}`;
	return {
		type: "classifier",
		id,
		provider: EMULATED_PROVIDER_ID,
		name: `LLM-as-Jev emulation (${id})`,
		api: "llm-as-jev",
		baseUrl: "https://emulated.invalid",
		input: ["text"],
		contextWindow: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

/** Fill `contextWindow` and `cost` from the configured chat model. */
function deriveFromChatModel(
	model: AnyClassifierModel,
	chat: AnyModel,
): AnyClassifierModel {
	return {
		...model,
		name: `LLM-as-Jev emulation (${chat.provider}/${chat.id})`,
		contextWindow: chat.contextWindow,
		cost: chat.cost,
	};
}

/**
 * Availability of the emulation: the underlying chat provider must have
 * usable credentials, and the configured chat model must exist in the
 * registry. Resolves undefined (no models advertised) otherwise.
 */
async function underlyingAvailable(
	registry: ProviderRegistry,
	config: JudgmentConfig,
): Promise<AnyModel | undefined> {
	if (!config.provider || !config.modelId) return undefined;
	const auth = await registry.checkAuth(config.provider);
	if (!auth) return undefined;
	const chat = registry.getModel(config.provider, config.modelId);
	return chat ?? undefined;
}

/**
 * Build the native provider. Availability of the classifier follows the
 * underlying chat provider's auth check; `resolve` returns the internal
 * `emulated` marker only when that provider is ready, and there is no login
 * handler to pollute `/login`.
 */
export function createEmulatedClassifierProvider({
	registry,
	config,
}: EmulatedClassifierOptions): Provider {
	return {
		id: EMULATED_PROVIDER_ID,
		name: "LLM-as-Jev classifier emulation",
		auth: {
			apiKey: {
				name: "Delegated chat credentials",
				check: async () => {
					const chat = await underlyingAvailable(registry, config);
					return chat ? { type: "api_key", source: "delegated" } : undefined;
				},
				resolve: async () => {
					const chat = await underlyingAvailable(registry, config);
					return chat
						? {
								auth: { apiKey: EMULATED_API_KEY },
								source: "delegated",
							}
						: undefined;
				},
			},
		},
		getModels: () => [],
		stream: unsupportedChat,
		streamSimple: unsupportedChat,
		getAllModels: () => {
			// ponytail: synchronous model list cannot await the auth check; the
			// registry's getAvailableOfType filter handles live availability.
			const model = emulatedClassifierModel(config);
			if (!model || !config.provider || !config.modelId) return [];
			const chat = registry.getModel(config.provider, config.modelId);
			return chat ? [deriveFromChatModel(model, chat)] : [];
		},
		classify: async (
			model: AnyClassifierModel,
			context: ClassifierContext,
			options?: { signal?: AbortSignal; timeoutMs?: number },
		): Promise<ClassifierResult> => {
			const chat =
				config.provider && config.modelId
					? registry.getModel(config.provider, config.modelId)
					: undefined;
			if (!chat) {
				return {
					api: model.api,
					provider: EMULATED_PROVIDER_ID,
					model: model.id,
					answers: {},
					stopReason: "error",
					errorMessage: `Configured chat model "${config.model}" is not available`,
					timestamp: Date.now(),
				};
			}
			return llmClassify(registry as unknown as LlmRegistry, chat, context, {
				thinkingLevel: config.thinkingLevel,
				signal: options?.signal,
				timeoutMs: options?.timeoutMs,
			});
		},
	};
}

/** The provider hosts no chat models; nested registry calls do the streaming. */
function unsupportedChat(): never {
	throw new Error(
		"llm-as-jev hosts no chat models; use modelRegistry.streamSimple",
	);
}

/** Proven registration form from task 1.2: native provider overload. */
export function registerEmulatedClassifierProvider(
	pi: { registerProvider(provider: Provider): unknown },
	options: EmulatedClassifierOptions,
): Provider {
	const provider = createEmulatedClassifierProvider(options);
	pi.registerProvider(provider);
	return provider;
}
