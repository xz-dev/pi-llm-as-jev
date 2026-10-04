/**
 * Extension entry (task 9.1). Loads config once per activation (diagnostics
 * reported once per session), constructs the judgment service, publishes the
 * identity-checked `Symbol.for("pi-llm-as-jev:service")` handle, registers
 * the emulated classifier provider and the `/llm-as-jev` commands, and binds
 * generation/branch ledger lifecycle to Pi session navigation.
 *
 * The main-session model and thinking level are never touched.
 */

import type {
	Api,
	ClassifierApi,
	ClassifierModel,
	Model,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveNativeClassifier } from "./backend-jev.js";
import {
	type JudgmentConfig,
	type JudgmentMode,
	type JudgmentThinkingLevel,
	loadConfig,
	saveConfig,
} from "./config.js";
import { pickFromList } from "./picker.js";
import { createEmulatedClassifierProvider } from "./provider.js";
import { type CreatedService, createJudgmentService } from "./service.js";
import {
	filterModels,
	formatStatus,
	levelOptions,
	type NativeStatus,
	type PickerModel,
	preselectIndex,
	preselectLevel,
	sortModels,
} from "./ui.js";

type AnyModel = Model<Api>;
type AnyClassifierModel = ClassifierModel<ClassifierApi>;

const SERVICE_KEY = Symbol.for("pi-llm-as-jev:service");
const EMULATED_ID = "llm-as-jev";

/** Structural slice of the registry the service/backends/provider expect. */
interface RegistrySlice {
	getAvailable(): readonly AnyModel[];
	getModel(provider: string, id: string): AnyModel | undefined;
	getAvailableOfType(
		type: "classifier",
		provider?: string,
		options?: { signal?: AbortSignal },
	): Promise<readonly AnyClassifierModel[]>;
	getAuth(
		providerId: string,
	): Promise<{ auth?: { apiKey?: string } } | undefined>;
	getProviders?(): readonly { id: string }[];
	checkAuth(providerId: string): Promise<{ source?: string } | undefined>;
	classify: unknown;
	streamSimple: unknown;
}

/** The real `ctx.modelRegistry` facade (ModelRegistry) as the host provides it. */
interface HostModelRegistry {
	getAll(): readonly AnyModel[];
	getAvailable(): readonly AnyModel[];
	find(provider: string, modelId: string): AnyModel | undefined;
	getAvailableOfType(
		type: "classifier",
		provider?: string,
		options?: { signal?: AbortSignal },
	): Promise<readonly AnyClassifierModel[]>;
	getProviderAuth(
		providerId: string,
	): Promise<{ auth?: { apiKey?: string }; source?: string } | undefined>;
	getRegisteredProviderIds(): readonly string[];
	classify(model: never, context: never, options?: never): Promise<unknown>;
	streamSimple(
		model: never,
		context: never,
		options?: never,
	): { result(): Promise<unknown> };
}

/**
 * Adapt the host ModelRegistry facade to the registry slices the service,
 * backends and provider expect (getModel→find, getAuth→getProviderAuth,
 * checkAuth→getProviderAuth presence). Provider ids for redaction derive
 * from the model catalog plus extension registrations; the facade exposes
 * no direct provider enumeration.
 */
function adaptRegistry(host: HostModelRegistry): RegistrySlice {
	const providers = (): { id: string }[] => {
		const ids = new Set<string>();
		for (const model of host.getAll()) ids.add(model.provider);
		for (const id of host.getRegisteredProviderIds()) ids.add(id);
		return [...ids].map((id) => ({ id }));
	};
	return {
		getAvailable: () => host.getAvailable(),
		getModel: (provider, id) => host.find(provider, id),
		getAvailableOfType: (type, provider, options) =>
			host.getAvailableOfType(type, provider, options),
		getAuth: async (providerId) => {
			try {
				return await host.getProviderAuth(providerId);
			} catch {
				return undefined; // auth resolution failure never breaks judgment
			}
		},
		getProviders: providers,
		checkAuth: async (providerId) => {
			const auth = await host
				.getProviderAuth(providerId)
				.catch(() => undefined);
			return auth?.auth?.apiKey ? { source: auth.source } : undefined;
		},
		// Bind host methods: the facade's classify/streamSimple rely on `this`
		// (e.g. ModelRegistry.classify → this.runtime.classify); copying the
		// reference unbound crashes with "undefined is not an object".
		classify: host.classify.bind(host) as unknown,
		streamSimple: host.streamSimple.bind(host) as unknown,
	};
}

const fallbackConfig = (): JudgmentConfig => ({
	mode: "auto",
	thinkingLevel: "off",
	timeoutMs: 120_000,
});

export default function extension(pi: ExtensionAPI): void {
	let config: JudgmentConfig = fallbackConfig();
	/** The ADAPTED registry: what the service and provider consume. */
	let registry: RegistrySlice | undefined;
	/** The raw host facade, for provider re-registration. */
	let host: HostModelRegistry | undefined;
	let service: CreatedService | undefined;
	let disposed = false;
	let pendingDiagnostics: string[] | null = null;
	let unknownChatWarned = false;
	const configLoaded: Promise<void> = loadConfig().then(
		(result) => {
			config = result.config;
			pendingDiagnostics = result.diagnostics.map((d) => d.message);
		},
		() => {
			config = fallbackConfig();
		},
	);

	const getConfig = (): JudgmentConfig => config;

	// ---- Provider registration + runtime re-registration (7.2). ----
	function registerProvider(): void {
		if (disposed || !registry) return;
		// Unregister first so a chat-model change cannot leave a stale
		// classifier dispatching under the old id. pi.unregisterProvider
		// clears the old model list immediately; pi.registerProvider
		// recomposes the provider and refreshes the registry snapshot in the
		// same tick — no restart, no /reload, no stale dispatch.
		try {
			pi.unregisterProvider(EMULATED_ID);
		} catch {
			/* first registration: nothing to remove */
		}
		pi.registerProvider(
			createEmulatedClassifierProvider({
				registry: registry as never,
				config,
			}),
		);
	}

	// ---- Service construction on first registry bind. ----
	function bindRegistry(next: unknown): void {
		if (disposed) return;
		host = next as HostModelRegistry;
		registry = adaptRegistry(host);
		if (service) return;
		// The service consumes the ADAPTED registry (getModel/getAuth/
		// getProviders/checkAuth + classify/streamSimple forwarding), never
		// the raw host facade: the facade lacks those structural members and
		// dispatching through it fails at runtime.
		service = createJudgmentService({
			registry: registry as never,
			config: getConfig,
			ledger: {
				append: (type, data) => {
					if (type === "llm-as-jev-ledger") pi.appendEntry(type, data);
				},
				branch: () => sessionManager?.getBranch(),
			},
		});
		// Newest activation owns the handle: publish unconditionally. The
		// identity check lives on SHUTDOWN (below) — an old runtime can never
		// delete its replacement's handle, and a replacement is not evicted by
		// a stale shutdown.
		const holder = globalThis as Record<symbol, unknown>;
		holder[SERVICE_KEY] = service;
		registerProvider();
	}

	let sessionManager: { getBranch(): unknown[] } | undefined;

	/** Native-path status: explicit selection, default Jev candidate or error. */
	async function nativeStatus(): Promise<NativeStatus> {
		if (!registry) return {};
		try {
			const selected = await resolveNativeClassifier(
				registry as never,
				config,
				{ signal: AbortSignal.timeout(config.timeoutMs) },
			);
			if ("model" in selected)
				return config.classifierModel !== undefined
					? { explicit: config.classifierModel }
					: {
							defaultCandidate: `${selected.model.provider}/${selected.model.id}`,
						};
			return config.classifierModel !== undefined
				? { explicit: config.classifierModel, error: "not available" }
				: {};
		} catch {
			return config.classifierModel !== undefined
				? { explicit: config.classifierModel, error: "not available" }
				: {};
		}
	}

	// ---- /llm-as-jev command tree (8.1 status+mode, 8.2/8.3 chat pickers,
	//      8.4 native classifier picker). ----
	pi.registerCommand("llm-as-jev", {
		description:
			"Judge backend: status, mode <auto|classifier|llm>, model + level pickers",
		getArgumentCompletions: (prefix: string) => {
			const options = ["mode auto", "mode classifier", "mode llm"].filter((o) =>
				o.startsWith(prefix),
			);
			if (options.length === 0) return null;
			return options.map((o) => ({ label: o, value: o }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await configLoaded;
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "mode") {
				const mode = parts[1];
				if (mode === "auto" || mode === "classifier" || mode === "llm") {
					await setMode(mode, ctx);
					return;
				}
				ctx.ui.notify(
					`Usage: /llm-as-jev mode <auto|classifier|llm> (current: ${config.mode}; the old "jev" value is no longer accepted)`,
					"warning",
				);
				return;
			}
			if (parts[0] === "classifier") {
				if (ctx.mode !== "tui" || !ctx.hasUI) {
					ctx.ui.notify(
						"llm-as-jev: classifier selection needs the interactive TUI",
						"warning",
					);
					return;
				}
				await runClassifierPicker(ctx);
				return;
			}
			if (parts[0] === "status") {
				await showStatus(ctx);
				return;
			}
			if (parts.length > 0) {
				// Unknown subcommand: point at /llm-as-jev classifier too.
				ctx.ui.notify(
					`Unknown argument "${parts[0]}"; usage: /llm-as-jev [status] | mode <auto|classifier|llm> | classifier`,
					"warning",
				);
				return;
			}
			await showStatus(ctx);
			// Custom components need the TUI; RPC/json/print still get status.
			if (ctx.mode !== "tui" || !ctx.hasUI) return;
			await runChatPickers(ctx);
		},
	});

	pi.registerCommand("llm-as-jev-classifier", {
		description:
			"Select the native judge classifier (independent of the LLM model)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await configLoaded;
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify(
					"llm-as-jev: classifier selection needs the interactive TUI",
					"warning",
				);
				return;
			}
			await runClassifierPicker(ctx);
		},
	});

	async function setMode(
		mode: JudgmentMode,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		try {
			config = (await saveConfig({ mode })).config;
			ctx.ui.notify(`llm-as-jev: mode set to ${mode}`, "info");
		} catch (error) {
			ctx.ui.notify(
				`llm-as-jev: could not save mode (${errText(error)}); disk unchanged, still ${config.mode}`,
				"error",
			);
			// Atomic swap only on successful write: a failed save leaves BOTH
			// disk and memory on the previous mode.
		}
	}

	async function showStatus(ctx: ExtensionContext): Promise<void> {
		ctx.ui.notify(
			formatStatus({
				config,
				native: await nativeStatus(),
				configPath: configPathForStatus(),
			}),
			"info",
		);
	}

	function configPathForStatus(): string {
		const env = process.env.PI_CODING_AGENT_DIR;
		if (env && env.trim() !== "")
			return `${env.replace(/\/+$/, "")}/llm-as-jev.json`;
		const home = process.env.HOME ?? "";
		return home === ""
			? "llm-as-jev.json"
			: `${home.replace(/\/+$/, "")}/.pi/agent/llm-as-jev.json`;
	}

	// ---- 8.2/8.3: chat model → thinking level pickers. ----
	async function runChatPickers(ctx: ExtensionCommandContext): Promise<void> {
		if (!registry) {
			ctx.ui.notify("llm-as-jev: model registry not bound yet", "warning");
			return;
		}
		// Chat models with usable credentials, alphabetical provider/id.
		const models: PickerModel[] = sortModels(
			registry.getAvailable().map((m) => ({
				provider: m.provider,
				id: m.id,
				name: m.name,
			})),
		);
		if (models.length === 0) {
			ctx.ui.notify(
				"No chat models with usable credentials; use /login first.",
				"warning",
			);
			return;
		}
		const selectedModel = await pickModel(ctx, models, config.model);
		if (selectedModel === undefined) return; // cancel: nothing changes
		const chat = registry.getModel(selectedModel.provider, selectedModel.id);
		if (!chat) {
			ctx.ui.notify(
				`llm-as-jev: ${selectedModel.provider}/${selectedModel.id} is no longer available; nothing saved`,
				"warning",
			);
			return;
		}
		const levels = levelOptions(chat);
		const level = await pickLevel(ctx, selectedModel, levels);
		if (level === undefined) return; // cancel at either step: nothing saved

		// Final confirmation done: persist BOTH chat values atomically,
		// swap the in-memory config, re-register the emulated classifier and
		// refresh the service — same process, no /reload.
		try {
			config = (
				await saveConfig({
					model: `${selectedModel.provider}/${selectedModel.id}`,
					thinkingLevel: level,
					// Chat selection never touches the native slot.
				})
			).config;
			registerProvider();
			service?.updateConfig(config);
			ctx.ui.notify(
				`llm-as-jev: model ${config.model} @ ${config.thinkingLevel} saved (native selection unchanged)`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(
				`llm-as-jev: could not save settings (${errText(error)}); previous config kept`,
				"error",
			);
		}
	}

	// ---- 8.4: native classifier picker (no thinking step). ----
	async function runClassifierPicker(
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (!registry) {
			ctx.ui.notify("llm-as-jev: model registry not bound yet", "warning");
			return;
		}
		let available: readonly AnyClassifierModel[];
		try {
			available = await registry.getAvailableOfType("classifier");
		} catch (error) {
			ctx.ui.notify(
				`llm-as-jev: classifier discovery failed (${errText(error)})`,
				"error",
			);
			return;
		}
		// Own emulation excluded from native selection (spec/D3).
		const candidates = sortModels(
			available
				.filter((m) => m.provider !== EMULATED_ID)
				.map((m) => ({
					provider: m.provider,
					id: m.id,
					name: m.name ?? m.id,
				})),
		);
		if (candidates.length === 0) {
			ctx.ui.notify(
				"No compatible native classifiers available; the LLM backend still works.",
				"warning",
			);
			return;
		}
		const selected = await pickModel(ctx, candidates, config.classifierModel);
		if (selected === undefined) return; // cancel: nothing changes
		const chosen = available.find(
			(m) => m.provider === selected.provider && m.id === selected.id,
		);
		if (!chosen) {
			ctx.ui.notify(
				`llm-as-jev: ${selected.provider}/${selected.id} is no longer available; nothing saved`,
				"warning",
			);
			return;
		}
		// Persist ONLY the native slot; the next native judgment uses it
		// immediately (the service reads config per request). Chat model,
		// thinking level, main session: untouched.
		try {
			config = (
				await saveConfig({
					classifierModel: `${selected.provider}/${selected.id}`,
				})
			).config;
			service?.updateConfig(config);
			ctx.ui.notify(
				`llm-as-jev: classifier ${config.classifierModel} selected (chat settings unchanged)`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(
				`llm-as-jev: could not save classifier (${errText(error)}); previous config kept`,
				"error",
			);
		}
	}

	/** Shared searchable picker over models; returns the chosen reference. */
	async function pickModel(
		ctx: ExtensionCommandContext,
		models: readonly PickerModel[],
		configured: string | undefined,
	): Promise<PickerModel | undefined> {
		const value = await pickFromList(ctx.ui, {
			title: "Judge model (sorted by provider/id)",
			items: models.map((m) => ({
				value: `${m.provider}/${m.id}`,
				label: m.id,
				description: m.provider,
			})),
			preselectIndex: preselectIndex(models, configured),
			// Filtered results stay alphabetical: filterModels preserves order.
			filter: (query) =>
				filterModels(models, query).map((m) => `${m.provider}/${m.id}`),
		});
		return value === undefined
			? undefined
			: models.find((m) => `${m.provider}/${m.id}` === value);
	}

	async function pickLevel(
		ctx: ExtensionCommandContext,
		model: PickerModel,
		levels: readonly JudgmentThinkingLevel[],
	): Promise<JudgmentThinkingLevel | undefined> {
		const preselect = preselectLevel(levels, config.thinkingLevel);
		const value = await pickFromList(ctx.ui, {
			title: `Thinking level for ${model.provider}/${model.id}`,
			items: levels.map((level) => ({
				value: level,
				label: level,
				description:
					level === preselect
						? level === config.thinkingLevel
							? "configured"
							: "model default"
						: undefined,
			})),
			preselectIndex: levels.indexOf(preselect),
			filter: null,
		});
		return value as JudgmentThinkingLevel | undefined;
	}

	// ---- Lifecycle: registry bind, branch restore, identity-checked dispose. ----
	async function onSessionNav(_event: unknown, ctx: ExtensionContext) {
		await configLoaded;
		bindRegistry(ctx.modelRegistry);
		if (
			config.model &&
			config.provider &&
			config.modelId &&
			!unknownChatWarned &&
			!registry?.getModel(config.provider, config.modelId)
		) {
			ctx.ui.notify(
				"llm-as-jev: configured chat model is not in Pi's catalog; LLM backend unavailable",
				"warning",
			);
			unknownChatWarned = true;
		}
		sessionManager = ctx.sessionManager as never;
		if (service) service.refreshBranch(); // branch-only ledger restore
	}

	pi.on("session_start", onSessionNav);
	pi.on("session_tree", onSessionNav);
	pi.on("session_before_fork", onSessionNav);
	pi.on("session_before_switch", onSessionNav);

	// Config diagnostics: reported exactly once per session (first context).
	pi.on("session_start", async (_event, ctx) => {
		await configLoaded;
		if (pendingDiagnostics && pendingDiagnostics.length > 0) {
			for (const message of pendingDiagnostics)
				ctx.ui.notify(message, "warning");
			pendingDiagnostics = null;
		}
	});

	pi.on("session_shutdown", () => {
		// Identity check: an old runtime must never delete its replacement's
		// handle, and a replacement must not be evicted by a stale shutdown.
		const holder = globalThis as Record<symbol, unknown>;
		if (holder[SERVICE_KEY] === service) delete holder[SERVICE_KEY];
		disposed = true;
	});
}

function errText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
