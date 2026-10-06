/**
 * Settings for the judgment service, stored at `<agentDir>/llm-as-jev.json`.
 *
 * Model references split on their FIRST slash: `provider/modelid` where the
 * model id itself may contain slashes (design D8). `classifierModel` and the
 * LLM `model` are independent slots: configuring one never mutates the other,
 * and the file never inherits the main-session model or thinking level.
 *
 * Any invalid KNOWN field invalidates the whole file: all known fields fall
 * back to defaults rather than partially accepting it (spec
 * judge-model-settings/Configuration file). Unknown extra keys are preserved
 * on save and never by themselves make the file invalid. An explicit
 * `classifierModel` absent from Pi's catalog is preserved as an unavailable
 * explicit selection, not erased.
 */

import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import type { CapacityLimits } from "./capacity.js";

/** Exact provider/model references; an override replaces the default profile. */
export type ContextLimitOverrides = Record<
	string,
	Pick<CapacityLimits, "request" | "stateAndLongestQuestion">
>;

export type JudgmentMode = "auto" | "classifier" | "llm";
export type JudgmentThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export const DEFAULT_MODE: JudgmentMode = "auto";
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface JudgmentConfig {
	mode: JudgmentMode;
	/** Optional explicit native classifier `provider/modelid`. Unset means
	 * default Jev discovery; an unavailable explicit reference stays selected
	 * (for diagnostics) and never silently resolves to another native model. */
	classifierModel?: string;
	/** Model id portion of `classifierModel`, without the provider prefix. */
	classifierModelId?: string;
	/** Provider portion of `classifierModel`, before the first slash. */
	classifierProvider?: string;
	/** `provider/modelid`; unset means no LLM backend is available — the
	 * service must never fall back to the main-session model. */
	model?: string;
	/** Model id portion of `model`, without the provider prefix. */
	modelId?: string;
	/** Provider portion of `model`, before the first slash. */
	provider?: string;
	thinkingLevel: JudgmentThinkingLevel;
	timeoutMs: number;
	contextLimits?: ContextLimitOverrides;
}

export interface ConfigDiagnostic {
	message: string;
}

export interface LoadedConfig {
	config: JudgmentConfig;
	/** Diagnostics for the invalid file; empty when the file is clean. */
	diagnostics: ConfigDiagnostic[];
	/** True when no file exists and defaults were applied. */
	defaults: boolean;
}

const MODES: readonly JudgmentMode[] = ["auto", "classifier", "llm"];
const LEVELS: readonly JudgmentThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
const KNOWN_KEYS = [
	"mode",
	"classifierModel",
	"model",
	"thinkingLevel",
	"timeoutMs",
	"contextLimits",
] as const;
let saveSeq = 0;

/** Resolve `<agentDir>`: `PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
export function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env && env.trim() !== "") {
		return env;
	}
	const home = process.env.HOME ?? "";
	return home === "" ? "" : `${home.replace(/\/+$/, "")}/.pi/agent`;
}

export function configFilePath(dir = agentDir()): string {
	return dir === "" ? "llm-as-jev.json" : `${dir}/llm-as-jev.json`;
}

function defaultConfig(): JudgmentConfig {
	return {
		mode: DEFAULT_MODE,
		thinkingLevel: "off",
		timeoutMs: DEFAULT_TIMEOUT_MS,
	};
}

function parseModelReference(
	value: string,
	field: string,
	diagnostics: ConfigDiagnostic[],
): { provider?: string; modelId?: string } {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		diagnostics.push({
			message: `llm-as-jev.json: ${field} "${value}" is not in provider/modelid form; using default settings`,
		});
		return {};
	}
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

/** Validate one model reference field; returns the split parts when valid. */
function readModelField(
	obj: Record<string, unknown>,
	field: "classifierModel" | "model",
	diagnostics: ConfigDiagnostic[],
): { ok: boolean; provider?: string; modelId?: string } {
	const value = obj[field];
	if (value === undefined) return { ok: true };
	if (typeof value !== "string" || value.trim() === "") {
		diagnostics.push({
			message: `llm-as-jev.json: ${field} ${JSON.stringify(value)} is not a non-empty string; using default settings`,
		});
		return { ok: false };
	}
	const ref = parseModelReference(value, field, diagnostics);
	if (ref.provider === undefined) return { ok: false };
	return { ok: true, provider: ref.provider, modelId: ref.modelId };
}

function readContextLimits(value: unknown): ContextLimitOverrides | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const entries = Object.entries(value);
	const limits: [string, ContextLimitOverrides[string]][] = [];
	for (const [ref, profile] of entries) {
		const slash = ref.indexOf("/");
		if (
			slash <= 0 ||
			slash === ref.length - 1 ||
			profile === null ||
			typeof profile !== "object" ||
			Array.isArray(profile)
		)
			return undefined;
		const fields = Object.entries(profile);
		if (
			!fields.length ||
			fields.some(
				([key, limit]) =>
					!["request", "stateAndLongestQuestion"].includes(key) ||
					typeof limit !== "number" ||
					!Number.isSafeInteger(limit) ||
					limit <= 0,
			)
		)
			return undefined;
		limits.push([ref, Object.fromEntries(fields)]);
	}
	return Object.fromEntries(limits);
}

/**
 * Validate a raw config object into effective settings plus diagnostics.
 * All-or-defaults: one invalid KNOWN field discards every known field;
 * unknown extras are tolerated and never trigger diagnostics.
 */
export function validateConfig(raw: unknown): LoadedConfig {
	const diagnostics: ConfigDiagnostic[] = [];
	const config = defaultConfig();
	const fields: {
		mode?: JudgmentMode;
		classifierModel?: { provider: string; modelId: string };
		model?: { provider: string; modelId: string };
		thinkingLevel?: JudgmentThinkingLevel;
		timeoutMs?: number;
		contextLimits?: ContextLimitOverrides;
	} = {};
	let invalid = false;

	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		diagnostics.push({
			message:
				"llm-as-jev.json: root is not a JSON object; using default settings",
		});
		return { config, diagnostics, defaults: false };
	}
	const obj = raw as Record<string, unknown>;

	if (obj.mode !== undefined) {
		if (
			typeof obj.mode === "string" &&
			MODES.includes(obj.mode as JudgmentMode)
		) {
			fields.mode = obj.mode as JudgmentMode;
		} else {
			invalid = true;
			diagnostics.push({
				message: `llm-as-jev.json: unknown mode ${JSON.stringify(obj.mode)} (expected auto|classifier|llm); using default settings`,
			});
		}
	}

	const classifier = readModelField(obj, "classifierModel", diagnostics);
	if (!classifier.ok) invalid = true;
	else if (classifier.provider !== undefined)
		fields.classifierModel = {
			provider: classifier.provider,
			modelId: classifier.modelId as string,
		};

	const llm = readModelField(obj, "model", diagnostics);
	if (!llm.ok) invalid = true;
	else if (llm.provider !== undefined)
		fields.model = {
			provider: llm.provider,
			modelId: llm.modelId as string,
		};

	if (obj.thinkingLevel !== undefined) {
		if (
			typeof obj.thinkingLevel === "string" &&
			LEVELS.includes(obj.thinkingLevel as JudgmentThinkingLevel)
		) {
			fields.thinkingLevel = obj.thinkingLevel as JudgmentThinkingLevel;
		} else {
			invalid = true;
			diagnostics.push({
				message: `llm-as-jev.json: unknown thinkingLevel ${JSON.stringify(obj.thinkingLevel)} (expected one of ${LEVELS.join("|")}); using default settings`,
			});
		}
	}

	if (obj.timeoutMs !== undefined) {
		if (
			typeof obj.timeoutMs === "number" &&
			Number.isFinite(obj.timeoutMs) &&
			Number.isInteger(obj.timeoutMs) &&
			obj.timeoutMs > 0
		) {
			fields.timeoutMs = obj.timeoutMs;
		} else {
			invalid = true;
			diagnostics.push({
				message: `llm-as-jev.json: timeoutMs ${JSON.stringify(obj.timeoutMs)} is not a positive finite integer; using default settings`,
			});
		}
	}

	if (obj.contextLimits !== undefined) {
		fields.contextLimits = readContextLimits(obj.contextLimits);
		if (!fields.contextLimits) {
			invalid = true;
			diagnostics.push({
				message:
					"llm-as-jev.json: contextLimits requires provider/model profiles with positive integer request and/or stateAndLongestQuestion limits; using default settings",
			});
		}
	}

	if (invalid) return { config: defaultConfig(), diagnostics, defaults: false };

	if (fields.mode !== undefined) config.mode = fields.mode;
	if (fields.classifierModel !== undefined) {
		const value = obj.classifierModel as string;
		config.classifierModel = value;
		config.classifierProvider = fields.classifierModel.provider;
		config.classifierModelId = fields.classifierModel.modelId;
	}
	if (fields.model !== undefined) {
		const value = obj.model as string;
		config.model = value;
		config.provider = fields.model.provider;
		config.modelId = fields.model.modelId;
	}
	if (fields.thinkingLevel !== undefined)
		config.thinkingLevel = fields.thinkingLevel;
	if (fields.timeoutMs !== undefined) config.timeoutMs = fields.timeoutMs;
	if (fields.contextLimits !== undefined)
		config.contextLimits = fields.contextLimits;
	return { config, diagnostics, defaults: false };
}

/** Shared decoding for asynchronous operations and synchronous metadata. */
function parseConfigText(text: string): LoadedConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			config: defaultConfig(),
			diagnostics: [
				{
					message: `llm-as-jev.json: malformed JSON (${(error as Error).message}); using default settings`,
				},
			],
			defaults: false,
		};
	}
	return validateConfig(raw);
}

function unreadableConfig(error: unknown): LoadedConfig {
	const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
	return {
		config: defaultConfig(),
		diagnostics: missing
			? []
			: [
					{
						message: `llm-as-jev.json: could not read settings file (${(error as Error).message}); using default settings`,
					},
				],
		defaults: missing,
	};
}

/** Load current contents, without caching file contents or timestamps. */
export async function loadConfig(dir = agentDir()): Promise<LoadedConfig> {
	try {
		return parseConfigText(await fs.readFile(configFilePath(dir), "utf8"));
	} catch (error) {
		return unreadableConfig(error);
	}
}

/** Synchronous native metadata callbacks use the same decoding/default policy. */
export function loadConfigSync(dir = agentDir()): LoadedConfig {
	try {
		return parseConfigText(readFileSync(configFilePath(dir), "utf8"));
	} catch (error) {
		return unreadableConfig(error);
	}
}

/**
 * Write the config file atomically (temp file + rename).
 *
 * Steps (F8): normalize the EXISTING known settings once to a valid
 * all-default base via `validateConfig`, copy unknown OWN extras — including
 * `__proto__` — without mutating prototypes, apply the confirmed update
 * (including `null` removals) to that base, then validate the result. An
 * invalid update throws before writing: the confirmed save can never
 * silently resurrect invalid persisted fields or drop the new choice. The
 * written file contains exactly the validated known fields plus preserved
 * extras, and the returned config equals what a reload would produce.
 *
 * The two model slots are independent: updating one leaves the other
 * untouched. Pass `null` for `classifierModel` or `model` to remove that
 * slot (the classifier slot's removal restores default Jev discovery).
 */
export async function saveConfig(
	update: {
		mode?: JudgmentMode;
		classifierModel?: string | null;
		model?: string | null;
		thinkingLevel?: JudgmentThinkingLevel;
		timeoutMs?: number;
		contextLimits?: ContextLimitOverrides | null;
	},
	dir = agentDir(),
): Promise<LoadedConfig> {
	const path = configFilePath(dir);
	let existing: Record<string, unknown> = {};
	const diagnostics: ConfigDiagnostic[] = [];
	try {
		const text = await fs.readFile(path, "utf8");
		const parsed: unknown = JSON.parse(text);
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
		) {
			existing = parsed as Record<string, unknown>;
		} else {
			diagnostics.push({
				message:
					"llm-as-jev.json: existing file is not a JSON object; unknown keys not preserved",
			});
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			diagnostics.push({
				message: `llm-as-jev.json: could not read existing file (${(error as Error).message}); unknown keys not preserved`,
			});
		}
	}

	// 1. Normalize existing known settings once. An invalid persisted file
	//    contributes only its extras; its broken known fields never reach the
	//    write (no resurrected "jev" modes or malformed references).
	const base = validateConfig(existing).config;

	// 2. Unknown own extras survive verbatim — including `__proto__` — via
	//    defineProperty on a null-prototype record, so special keys are never
	//    routed through Object.prototype mutation.
	const next: Record<string, unknown> = Object.create(null);
	for (const key of Object.keys(existing)) {
		if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
			Object.defineProperty(next, key, {
				value: existing[key],
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}

	// 3. Apply the confirmed update to the normalized base. `null` removes a
	//    slot; omitted fields keep the base value.
	const candidate: Record<string, unknown> = {};
	candidate.mode = update.mode !== undefined ? update.mode : base.mode;
	if (update.classifierModel === null) {
		// removed — field stays absent
	} else if (update.classifierModel !== undefined) {
		candidate.classifierModel = update.classifierModel;
	} else if (base.classifierModel !== undefined) {
		candidate.classifierModel = base.classifierModel;
	}
	if (update.model === null) {
		// removed — field stays absent
	} else if (update.model !== undefined) {
		candidate.model = update.model;
	} else if (base.model !== undefined) {
		candidate.model = base.model;
	}
	candidate.thinkingLevel =
		update.thinkingLevel !== undefined
			? update.thinkingLevel
			: base.thinkingLevel;
	candidate.timeoutMs =
		update.timeoutMs !== undefined ? update.timeoutMs : base.timeoutMs;
	const contextLimits =
		update.contextLimits === undefined
			? base.contextLimits
			: update.contextLimits;
	if (contextLimits != null) candidate.contextLimits = contextLimits;

	// 4. Validate the final update. Invalid → throw BEFORE writing: disk and
	//    memory stay unchanged and no success is reported.
	const merged = validateConfig(candidate);
	if (merged.diagnostics.length > 0) {
		throw new Error(merged.diagnostics.map((d) => d.message).join("; "));
	}

	// 5. Exactly the validated known fields plus preserved extras.
	next.mode = merged.config.mode;
	next.thinkingLevel = merged.config.thinkingLevel;
	next.timeoutMs = merged.config.timeoutMs;
	if (merged.config.model !== undefined) {
		next.model = merged.config.model;
	}
	if (merged.config.contextLimits !== undefined)
		next.contextLimits = merged.config.contextLimits;
	if (merged.config.classifierModel !== undefined) {
		next.classifierModel = merged.config.classifierModel;
	}

	await fs.mkdir(dir, { recursive: true });
	// pid alone can collide across concurrent test processes; add a monotonic
	// counter so two saves in the same process and millisecond stay unique.
	let seq = ++saveSeq;
	if (seq >= Number.MAX_SAFE_INTEGER) {
		saveSeq = 0;
		seq = ++saveSeq;
	}
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${seq}`;
	await fs.writeFile(tmp, `${JSON.stringify(next, null, "\t")}\n`, {
		mode: 0o600,
	});
	try {
		await fs.rename(tmp, path);
	} catch (error) {
		await fs.rm(tmp, { force: true }).catch(() => {});
		throw error;
	}

	return {
		config: merged.config,
		diagnostics,
		defaults: false,
	};
}
