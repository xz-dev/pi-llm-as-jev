/**
 * Unit tests for the pure settings-UI helpers (tasks 8.1-8.4): status
 * formatter (classifier/LLM independent slots, unavailable-explicit vs
 * default discovery), model item sorting/true-fuzzy filtering/preselect for
 * both pickers, and thinking-level lists.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { JudgmentConfig } from "../src/config.ts";
import {
	DEFAULT_THINKING_LEVEL,
	filterModels,
	formatStatus,
	levelOptions,
	preselectIndex,
	preselectLevel,
	sortModels,
} from "../src/ui.ts";

const config = (overrides: Partial<JudgmentConfig> = {}): JudgmentConfig => ({
	mode: "auto",
	thinkingLevel: "off",
	...overrides,
});

// ---------------------------------------------------------------------------
// Overview formatter: availability snapshot → Mode/Classifier/LLM rows +
// mode-aware warning. No registry/auth/file access (pure).
// ---------------------------------------------------------------------------

test("default usable Jev shows Auto(classifier), its reference and LLM None", () => {
	const overview = formatStatus({
		config: config({ mode: "auto", thinkingLevel: "low" }),
		availability: { classifier: "typesafe/jev-1.13" },
		configPath: "/home/u/.pi/agent/llm-as-jev.json",
	});
	assert.match(overview.text, /^Mode\s+Auto\(classifier\)$/m);
	assert.match(
		overview.text,
		/^Classifier\s+Jev \(default: typesafe\/jev-1\.13\)$/m,
	);
	assert.match(overview.text, /^LLM\s+None$/m);
	assert.match(overview.text, /^Thinking\s+low$/m);
	assert.match(overview.text, /\/home\/u\/\.pi\/agent\/llm-as-jev\.json/);
	// Default Jev usable: no missing-backend warning.
	assert.equal(overview.warning, undefined);
});

test("unavailable Jev with a usable configured LLM shows Auto(llm)", () => {
	const overview = formatStatus({
		config: config({ mode: "auto", model: "openai/gpt-5" }),
		availability: { llm: "openai/gpt-5" },
		configPath: "/p",
	});
	assert.match(overview.text, /^Mode\s+Auto\(llm\)$/m);
	assert.match(overview.text, /^Classifier\s+Jev \(unavailable\)$/m);
	assert.match(overview.text, /^LLM\s+openai\/gpt-5$/m);
	assert.equal(overview.warning, undefined);
});

test("available explicit non-Jev classifier is retained exactly", () => {
	const overview = formatStatus({
		config: config({
			mode: "auto",
			classifierModel: "openrouter/tev-mini",
			model: "openai/gpt-5",
		}),
		availability: { classifier: "openrouter/tev-mini", llm: "openai/gpt-5" },
		configPath: "/p",
	});
	assert.match(overview.text, /^Mode\s+Auto\(classifier\)$/m);
	assert.match(overview.text, /^Classifier\s+openrouter\/tev-mini$/m);
	assert.doesNotMatch(overview.text, /unavailable/);
	assert.equal(overview.warning, undefined);
});

test("auto-llm shows Auto-LLM(llm), Auto-LLM(classifier), Auto-LLM(None) by availability", () => {
	const both = formatStatus({
		config: config({ mode: "auto-llm" }),
		availability: { classifier: "typesafe/jev-1.13", llm: "fake/fake-model" },
		configPath: "/x/llm-as-jev.json",
	});
	assert.ok(both.text.includes("Auto-LLM(llm)"));
	assert.equal(both.warning, undefined);

	const onlyNative = formatStatus({
		config: config({ mode: "auto-llm" }),
		availability: { classifier: "typesafe/jev-1.13" },
		configPath: "/x/llm-as-jev.json",
	});
	assert.ok(onlyNative.text.includes("Auto-LLM(classifier)"));

	const none = formatStatus({
		config: config({ mode: "auto-llm" }),
		availability: {},
		configPath: "/x/llm-as-jev.json",
	});
	assert.ok(none.text.includes("Auto-LLM(None)"));
	assert.match(none.warning ?? "", /no usable judge backend/);
});

test("Auto(None): unconfigured LLM stays None while configured refs mark unavailable", () => {
	const none = formatStatus({
		config: config(),
		availability: {},
		configPath: "/tmp/x/llm-as-jev.json",
	});
	assert.match(none.text, /^Mode\s+Auto\(None\)$/m);
	assert.match(none.text, /^Classifier\s+Jev \(unavailable\)$/m);
	assert.match(none.text, /^LLM\s+None$/m);
	// Warning names BOTH settings entries.
	assert.match(none.warning ?? "", /\/llm-as-jev classifier/);
	assert.match(none.warning ?? "", /\/llm-as-jev llm/);

	// Configured-but-uncredentialed LLM keeps its reference, not `None`.
	const uncredentialed = formatStatus({
		config: config({ model: "openai/gpt-5" }),
		availability: {},
		configPath: "/p",
	});
	assert.match(uncredentialed.text, /^Mode\s+Auto\(None\)$/m);
	assert.match(uncredentialed.text, /^LLM\s+openai\/gpt-5 \(unavailable\)$/m);
	assert.match(uncredentialed.warning ?? "", /\/llm-as-jev llm/);
});

test("forced modes keep their labels and warn without claiming the other backend", () => {
	const classifier = formatStatus({
		config: config({
			mode: "classifier",
			classifierModel: "native/gone-1",
			model: "openai/gpt-5",
		}),
		// Other slot usable; required one is not.
		availability: { llm: "openai/gpt-5" },
		configPath: "/p",
	});
	assert.match(classifier.text, /^Mode\s+Classifier$/m);
	assert.match(
		classifier.text,
		/^Classifier\s+native\/gone-1 \(unavailable\)$/m,
	);
	assert.match(classifier.text, /^LLM\s+openai\/gpt-5$/m);
	assert.doesNotMatch(classifier.text, /Auto\(/);
	assert.match(classifier.warning ?? "", /\/llm-as-jev classifier/);
	assert.match(classifier.warning ?? "", /never uses the LLM/);

	const llm = formatStatus({
		config: config({ mode: "llm", model: "openai/gpt-5" }),
		availability: { classifier: "typesafe/jev-1.13" },
		configPath: "/p",
	});
	assert.match(llm.text, /^Mode\s+LLM$/m);
	assert.match(llm.text, /^LLM\s+openai\/gpt-5 \(unavailable\)$/m);
	assert.doesNotMatch(llm.text, /Auto\(/);
	assert.match(llm.warning ?? "", /\/llm-as-jev llm/);
	assert.match(llm.warning ?? "", /never uses the classifier/);
});

test("available required slot in a forced mode emits no warning", () => {
	const ok = formatStatus({
		config: config({ mode: "llm", model: "openai/gpt-5" }),
		availability: { llm: "openai/gpt-5" },
		configPath: "/p",
	});
	assert.match(ok.text, /^Mode\s+LLM$/m);
	assert.equal(ok.warning, undefined);
});

// ---------------------------------------------------------------------------
// 8.2/8.4 shared picker helpers: sorting, fuzzy filtering, preselection
// ---------------------------------------------------------------------------

const MODELS = [
	{ provider: "openai", id: "gpt-5", name: "GPT-5 flagship" },
	{
		provider: "anthropic",
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
	},
	{ provider: "zhipu", id: "glm-4.7", name: "GLM 4.7" },
	{ provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
];

test("models sort alphabetically by provider/id with localeCompare", () => {
	const sorted = sortModels(MODELS);
	assert.deepEqual(
		sorted.map((m) => `${m.provider}/${m.id}`),
		[
			"anthropic/claude-sonnet-4-5",
			"openai/gpt-5",
			"openai/gpt-5-mini",
			"zhipu/glm-4.7",
		],
	);
});

test("spec: preselect configured model at its alphabetical position", () => {
	const sorted = sortModels(MODELS);
	// openai/gpt-5 sits at index 1 — preselected in place, not moved to top.
	assert.equal(preselectIndex(sorted, "openai/gpt-5"), 1);
	assert.equal(sorted[1]?.id, "gpt-5");
});

test("spec: nothing configured highlights the first alphabetical entry", () => {
	assert.equal(preselectIndex(sortModels(MODELS), undefined), 0);
	// Unknown/removed configured model falls back to the first entry.
	assert.equal(preselectIndex(sortModels(MODELS), "gone/model"), 0);
});

test("spec: true fuzzy search keeps only matches, still alphabetical", () => {
	const sorted = sortModels(MODELS);
	// Subsequence match on provider/id (Pi fuzzyMatch semantics).
	const sonnet = filterModels(sorted, "snnet");
	assert.deepEqual(
		sonnet.map((m) => `${m.provider}/${m.id}`),
		["anthropic/claude-sonnet-4-5"],
	);
	// Display-name fuzzy match ("GPT-5 mini" via 'g5m').
	const byName = filterModels(sorted, "g5m");
	assert.deepEqual(
		byName.map((m) => m.id),
		["gpt-5-mini"],
	);
	// Provider/id token search.
	const gpt = filterModels(sorted, "openai gpt-5");
	assert.deepEqual(
		gpt.map((m) => m.id),
		["gpt-5", "gpt-5-mini"],
	);
	// Empty query returns everything in order.
	assert.equal(filterModels(sorted, "").length, MODELS.length);
	assert.deepEqual(filterModels(sorted, "zzzz"), []);
});

// ---------------------------------------------------------------------------
// 8.3 Thinking level picker
// ---------------------------------------------------------------------------

const reasoningModel = {
	reasoning: true,
	thinkingLevelMap: {},
};
const nonReasoningModel = { reasoning: false };

test("spec: reasoning model offers exactly its supported levels", () => {
	assert.deepEqual(levelOptions(reasoningModel), [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
	]);
});

test("spec: non-reasoning model offers only off", () => {
	assert.deepEqual(levelOptions(nonReasoningModel), ["off"]);
});

test("xhigh/max stay opt-in through the model's thinkingLevelMap", () => {
	const mapped = {
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: null as null },
	};
	assert.deepEqual(levelOptions(mapped), [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
	]);
});

test("preselect configured level when supported, else model default clamped", () => {
	const levels = levelOptions(reasoningModel);
	assert.equal(preselectLevel(levels, "low"), "low");
	// Configured xhigh unsupported on the plain reasoning model → the
	// model default (medium) clamped onto the supported list.
	assert.equal(preselectLevel(levels, "xhigh"), "medium");
	// Non-reasoning: any configured level becomes off (its only level).
	assert.equal(preselectLevel(levelOptions(nonReasoningModel), "high"), "off");
});

test("model default is medium, clamped with Pi's up-first direction", () => {
	assert.equal(DEFAULT_THINKING_LEVEL, "medium");
	assert.equal(preselectLevel(["off", "minimal", "low"], "xhigh"), "low");
	// medium on [low,high] clamps up to high, Pi's own direction.
	assert.equal(preselectLevel(["low", "high"], "off"), "high");
});
