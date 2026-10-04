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
	timeoutMs: 120_000,
	...overrides,
});

// ---------------------------------------------------------------------------
// 8.1 Status formatter
// ---------------------------------------------------------------------------

test("status with default Jev available names the candidate and the LLM fallback", () => {
	const line = formatStatus({
		config: config({
			mode: "auto",
			model: "anthropic/claude-sonnet-4-5",
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
			thinkingLevel: "low",
		}),
		native: { defaultCandidate: "typesafe/jev-1.13" },
		configPath: "/home/u/.pi/agent/llm-as-jev.json",
	});
	assert.match(line, /mode=auto/);
	assert.match(line, /classifier=default jev \(typesafe\/jev-1\.13\)/);
	assert.match(line, /llm=anthropic\/claude-sonnet-4-5 @ low/);
	assert.match(line, /\/home\/u\/\.pi\/agent\/llm-as-jev\.json/);
	// Spec scenario: status identifies the actual Jev candidate and names the
	// configured LLM as fallback.
	assert.match(line, /auto→typesafe\/jev-1\.13, fallback llm/);
});

test("status distinguishes an unavailable EXPLICIT classifier from default discovery", () => {
	// Spec scenario: explicit classifier unavailable, another native exists.
	const line = formatStatus({
		config: config({ mode: "auto", model: "openai/gpt-5" }),
		native: { explicit: "typesafe/kev-2.1", error: "not available" },
		configPath: "/p",
	});
	assert.match(line, /classifier=typesafe\/kev-2\.1 \(unavailable\)/);
	// Never claims the other native model will be used.
	assert.doesNotMatch(line, /auto→typesafe\/jev/);
	assert.match(
		line,
		/auto→llm \(openai\/gpt-5; explicit classifier unavailable\)/,
	);
});

test("status with an available explicit non-Jev classifier uses it", () => {
	const line = formatStatus({
		config: config({ mode: "auto", model: "openai/gpt-5" }),
		native: { explicit: "openrouter/tev-mini" },
		configPath: "/p",
	});
	assert.match(line, /classifier=openrouter\/tev-mini/);
	assert.doesNotMatch(line, /unavailable/);
	assert.match(line, /auto→openrouter\/tev-mini, fallback llm/);
});

test("status unconfigured: no classifier and no LLM named as missing", () => {
	const line = formatStatus({
		config: config(),
		native: {},
		configPath: "/tmp/x/llm-as-jev.json",
	});
	assert.match(line, /llm=not configured/);
	assert.match(line, /classifier=default jev \(none available\)/);
	assert.match(line, /auto→llm \(not configured\)/);
});

test("status forced modes never mention the other backend as active", () => {
	const classifier = formatStatus({
		config: config({
			mode: "classifier",
			classifierModel: "openrouter/tev-mini",
			model: "openai/gpt-5",
		}),
		native: { explicit: "openrouter/tev-mini" },
		configPath: "/p",
	});
	assert.match(
		classifier,
		/mode=classifier \[classifier→openrouter\/tev-mini\]/,
	);
	assert.doesNotMatch(classifier, /auto→/);
	const llm = formatStatus({
		config: config({ mode: "llm", model: "openai/gpt-5" }),
		native: { defaultCandidate: "typesafe/jev-1.13" },
		configPath: "/p",
	});
	assert.match(llm, /mode=llm \[llm→openai\/gpt-5\]/);
	assert.doesNotMatch(llm, /auto→/);
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
