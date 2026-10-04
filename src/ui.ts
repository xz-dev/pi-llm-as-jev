/**
 * Judge-model settings UI helpers (tasks 8.1-8.4, design D8). Pure helpers
 * are exported for unit tests; the interactive components (chat model →
 * level pickers, native classifier picker) are assembled in src/index.ts
 * over `ctx.ui.custom` with Pi's own `Input` + `SelectList` primitives.
 * Non-TUI operation is guarded before any custom UI is requested.
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { fuzzyMatch } from "@earendil-works/pi-tui";
import type { JudgmentConfig, JudgmentThinkingLevel } from "./config.js";

/** Pi's own model default level (coding-agent `DEFAULT_THINKING_LEVEL`). */
export const DEFAULT_THINKING_LEVEL: JudgmentThinkingLevel = "medium";

/** A model candidate for either picker (chat or native classifier). */
export interface PickerModel {
	provider: string;
	id: string;
	/** Display name used for fuzzy matching. */
	name: string;
}

/** Full `provider/modelid` reference of a candidate. */
export const modelRef = (m: PickerModel): string => `${m.provider}/${m.id}`;

/**
 * Sort available models alphabetically by `provider/id` with
 * `localeCompare` (spec: both pickers, including filtered results).
 */
export function sortModels(models: readonly PickerModel[]): PickerModel[] {
	return [...models].sort((a, b) => modelRef(a).localeCompare(modelRef(b)));
}

/**
 * Fuzzy-match one query token against a candidate's `provider/id` or
 * display name (subsequence in order, Pi's own `fuzzyMatch`).
 */
function tokenMatches(model: PickerModel, token: string): boolean {
	return (
		fuzzyMatch(token, modelRef(model)).matches ||
		fuzzyMatch(token, model.name).matches
	);
}

/**
 * True fuzzy filter over ids and display names that PRESERVES the caller's
 * (alphabetical) order — Pi's `fuzzyFilter` reorders by score, which the
 * spec forbids ("still in alphabetical order"), so match per item instead.
 * All whitespace-separated tokens must match somewhere.
 */
export function filterModels(
	models: readonly PickerModel[],
	query: string,
): PickerModel[] {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return [...models];
	return models.filter((m) => tokens.every((t) => tokenMatches(m, t)));
}

/** Index of the configured model inside the list, or the first entry (0). */
export function preselectIndex(
	models: readonly PickerModel[],
	configured?: string,
): number {
	if (configured === undefined) return 0;
	const index = models.findIndex((m) => modelRef(m) === configured);
	return index >= 0 ? index : 0;
}

/** Exact supported levels for a model, Pi's own computation (spec: level picker). */
export function levelOptions(model: {
	reasoning: boolean;
	thinkingLevelMap?: Record<string, unknown>;
}): readonly JudgmentThinkingLevel[] {
	// getSupportedThinkingLevels already handles the non-reasoning case (["off"])
	// and the xhigh/max opt-in map; delegate rather than duplicating.
	return getSupportedThinkingLevels(
		model as Parameters<typeof getSupportedThinkingLevels>[0],
	) as JudgmentThinkingLevel[];
}

/**
 * Level to preselect: the configured level when the model supports it,
 * otherwise the model's default (`DEFAULT_THINKING_LEVEL` clamped through
 * Pi's own supported-level logic).
 */
export function preselectLevel(
	levels: readonly JudgmentThinkingLevel[],
	configured: JudgmentThinkingLevel,
): JudgmentThinkingLevel {
	return levels.includes(configured)
		? configured
		: clampLevel(levels, DEFAULT_THINKING_LEVEL);
}

/** Pi's clamp semantics over an explicit level list. */
export function clampLevel(
	levels: readonly JudgmentThinkingLevel[],
	requested: JudgmentThinkingLevel,
): JudgmentThinkingLevel {
	if (levels.includes(requested)) return requested;
	const ORDER: readonly JudgmentThinkingLevel[] = [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	];
	const index = ORDER.indexOf(requested);
	if (index === -1) return levels[0] ?? "off";
	for (let i = index; i < ORDER.length; i++)
		if (levels.includes(ORDER[i])) return ORDER[i];
	for (let i = index - 1; i >= 0; i--)
		if (levels.includes(ORDER[i])) return ORDER[i];
	return levels[0] ?? "off";
}

/** What the status line reports about the native classifier path. */
export interface NativeStatus {
	/** Effective explicit selection from config, when set. */
	explicit?: string;
	/** Discovered default Jev candidate (`provider/modelid`), when resolvable. */
	defaultCandidate?: string;
	/** Discovery/lookup error text (explicit-unavailable or none-available). */
	error?: string;
}

export interface StatusInput {
	config: JudgmentConfig;
	/** Native path status: explicit selection, default candidate or error. */
	native: NativeStatus;
	configPath: string;
}

/**
 * One-line status (8.1): mode, effective native candidate and its
 * availability, LLM model/level, config path. Distinguishes an unavailable
 * EXPLICIT native selection from unconfigured default discovery.
 */
export function formatStatus({
	config,
	native,
	configPath,
}: StatusInput): string {
	const llm = config.model ?? "not configured";
	const level = config.thinkingLevel;
	const classifier = native.explicit
		? native.error
			? `classifier=${native.explicit} (unavailable)`
			: `classifier=${native.explicit}`
		: native.defaultCandidate
			? `classifier=default jev (${native.defaultCandidate})`
			: native.error
				? `classifier=default jev (${native.error})`
				: "classifier=default jev (none available)";
	const auto =
		native.explicit && !native.error
			? `auto→${native.explicit}, fallback llm (${llm})`
			: native.explicit && native.error
				? `auto→llm (${llm}; explicit classifier unavailable)`
				: native.defaultCandidate
					? `auto→${native.defaultCandidate}, fallback llm (${llm})`
					: `auto→llm (${llm})`;
	const backend =
		config.mode === "auto"
			? auto
			: `${config.mode}→${config.mode === "classifier" ? (native.explicit ?? "default jev") : llm}`;
	return `llm-as-jev: mode=${config.mode} [${backend}] | ${classifier} | llm=${llm} @ ${level} | ${configPath}`;
}
