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

/** One `service.availability()` snapshot: usable references only. */
export interface Availability {
	classifier?: string;
	llm?: string;
}

export interface StatusInput {
	config: JudgmentConfig;
	/** Service availability snapshot; undefined when the service isn't bound. */
	availability?: Availability;
	configPath: string;
}

export interface StatusOverview {
	/** Labeled rows: Mode, Classifier, LLM, Thinking, Config. */
	text: string;
	/** Mode-aware warning for a missing usable backend, or undefined. */
	warning?: string;
}

const DISPLAY_MODES: Record<string, string> = {
	classifier: "Classifier",
	llm: "LLM",
};

/**
 * Multi-line read-only overview: mode (with the automatic-mode suffix over
 * the availability snapshot), the two model slots, thinking level and
 * config path. `Jev` names default discovery, `None` an unconfigured slot;
 * configured references are retained and marked unavailable rather than
 * appearing unset. The warning names a relevant settings command and, for
 * forced modes, that the other backend is never selected automatically.
 */
export function formatStatus({
	config,
	availability,
	configPath,
}: StatusInput): StatusOverview {
	const mode = config.mode;
	const usableClassifier = availability?.classifier;
	const usableLlm = availability?.llm;

	let modeLabel: string;
	if (mode === "auto") {
		modeLabel = usableClassifier
			? "Auto(classifier)"
			: usableLlm
				? "Auto(llm)"
				: "Auto(None)";
	} else {
		modeLabel = DISPLAY_MODES[mode];
	}

	let classifierRow: string;
	if (config.classifierModel !== undefined) {
		classifierRow =
			usableClassifier !== undefined
				? config.classifierModel
				: `${config.classifierModel} (unavailable)`;
	} else {
		classifierRow = usableClassifier
			? `Jev (default: ${usableClassifier})`
			: "Jev (unavailable)";
	}

	let llmRow: string;
	if (config.model === undefined) {
		llmRow = "None";
	} else {
		llmRow = usableLlm ? config.model : `${config.model} (unavailable)`;
	}

	const rows: [string, string][] = [
		["Mode", modeLabel],
		["Classifier", classifierRow],
		["LLM", llmRow],
		["Thinking", config.thinkingLevel],
		["Config", configPath],
	];
	const width = Math.max(...rows.map(([label]) => label.length));
	const text = [
		"LLM-as-Jev",
		"",
		...rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`),
	].join("\n");

	let warning: string | undefined;
	if (availability !== undefined) {
		if (mode === "auto" && !usableClassifier && !usableLlm) {
			warning =
				"llm-as-jev: no usable judge backend; configure an available classifier with /llm-as-jev classifier or an LLM with /llm-as-jev llm";
		} else if (mode === "classifier" && !usableClassifier) {
			warning =
				"llm-as-jev: the configured classifier is unavailable; pick an available one with /llm-as-jev classifier (mode classifier never uses the LLM automatically)";
		} else if (mode === "llm" && !usableLlm) {
			warning =
				"llm-as-jev: the configured LLM is unavailable; pick an available model with /llm-as-jev llm (mode llm never uses the classifier automatically)";
		}
	}
	return { text, warning };
}
