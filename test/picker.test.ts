/**
 * Direct tests for the searchable picker component (task 8.2/8.4):
 * alphabetical order preservation, true fuzzy filtering through the pure
 * helper, real-index preselection, keyboard routing (list keys vs search
 * input), cancel resolving undefined, and select resolving the chosen value.
 * Uses the real Pi TUI component classes headlessly (no terminal).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	fuzzyFilter,
	getKeybindings,
	type SelectItem,
	type SelectList,
	setKeybindings,
} from "@earendil-works/pi-tui";
import { SearchablePickerComponent } from "../src/picker.ts";
import { filterModels, preselectIndex, sortModels } from "../src/ui.ts";

const ITEMS: SelectItem[] = sortModels([
	{ provider: "openai", id: "gpt-5", name: "GPT-5" },
	{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
	{ provider: "zhipu", id: "glm-4.7", name: "GLM" },
]).map((m) => ({
	value: `${m.provider}/${m.id}`,
	label: m.id,
	description: m.provider,
}));

function spec(overrides: Partial<Parameters<typeof makeSpec>[0]> = {}) {
	return makeSpec(overrides);
}
function makeSpec(
	overrides: {
		preselectIndex?: number;
		items?: SelectItem[];
		filter?: ((q: string) => string[]) | null;
	} = {},
) {
	return {
		title: "test",
		items: overrides.items ?? ITEMS,
		preselectIndex: overrides.preselectIndex ?? 0,
		filter:
			overrides.filter === undefined
				? (q: string) =>
						filterModels(
							ITEMS.map((i) => ({
								provider: i.description ?? "",
								id: i.label,
								name: "",
							})),
							q,
						).map(
							(m) =>
								ITEMS.find((i) => i.value === `${m.provider}/${m.id}`)?.value ??
								"",
						)
				: overrides.filter,
	};
}

/** Keybindings are global; ensure the default set is installed for matches(). */
const kb = getKeybindings();

function makePicker(s = spec()) {
	let settled: string | undefined | null = null;
	const picker = new SearchablePickerComponent(
		s,
		(result) => {
			settled = result;
		},
		{ fg: (_c, text) => text },
	);
	const result = () => settled;
	return { picker, result };
}

function list(): SelectList {
	// The component appends the list at a known child index; reach it via
	// render-independent access through the public SelectList instance.
	return (pickerOf() as unknown as { list?: SelectList }).list as SelectList;
}
let current: SearchablePickerComponent | undefined;
function pickerOf(): SearchablePickerComponent {
	return current as SearchablePickerComponent;
}

test.before(() => {
	// Keybindings need explicit install in headless mode.
	setKeybindings(kb);
});

test("renders items in caller order (alphabetical provider/id)", () => {
	const { picker, result } = makePicker();
	current = picker;
	assert.equal(result(), null); // not settled
	const lines = picker.render(100).join("\n");
	const a = lines.indexOf("claude-sonnet-4-5");
	const b = lines.indexOf("gpt-5");
	const c = lines.indexOf("glm-4.7");
	assert.ok(a >= 0 && b > a && c > b, `alphabetical order kept: ${lines}`);
});

test("preselects the real index without reordering", () => {
	// openai/gpt-5 is index 1 in ITEMS.
	const { picker } = makePicker(spec({ preselectIndex: 1 }));
	current = picker;
	const selected = list().getSelectedItem();
	assert.equal(selected?.value, "openai/gpt-5");
	// Still at its alphabetical position: render shows it second.
	const lines = picker.render(100).join("\n");
	assert.ok(lines.indexOf("claude-sonnet-4-5") < lines.indexOf("gpt-5"));
});

test("typing filters through the fuzzy helper while keeping order", () => {
	const { picker } = makePicker();
	current = picker;
	// Type "snnet" (subsequence of claude-sonnet-4-5).
	for (const ch of "snnet") picker.handleInput(ch);
	const lines = picker.render(100).join("\n");
	assert.ok(lines.includes("claude-sonnet-4-5"));
	assert.ok(!lines.includes("gpt-5"));
	assert.ok(!lines.includes("glm-4.7"));
	// Still the first (and only) selectable row — order preserved.
	const selected = list().getSelectedItem();
	assert.equal(selected?.value, "anthropic/claude-sonnet-4-5");
});

test("cancel (escape) resolves undefined and nothing else", () => {
	const { picker, result } = makePicker();
	current = picker;
	picker.handleInput("\x1b");
	assert.equal(result(), undefined);
	// Double-finish is a no-op.
	picker.handleInput("\r");
	assert.equal(result(), undefined);
});

test("enter selects the highlighted item", () => {
	const { picker, result } = makePicker(spec({ preselectIndex: 2 }));
	current = picker;
	picker.handleInput("\r");
	assert.equal(result(), "zhipu/glm-4.7");
});

test("arrow keys move within filtered results", () => {
	const { picker, result } = makePicker();
	current = picker;
	for (const ch of "g") picker.handleInput(ch); // filters to gpt-5 + glm-4.7
	picker.handleInput("\x1b[B"); // down
	picker.handleInput("\r");
	assert.equal(result(), "zhipu/glm-4.7");
});

test("no filter callback disables filtering (level picker shape)", () => {
	const levels: SelectItem[] = ["off", "low", "high"].map((l) => ({
		value: l,
		label: l,
	}));
	const { picker, result } = makePicker(
		spec({ items: levels, filter: null, preselectIndex: 1 }),
	);
	current = picker;
	for (const ch of "zzz") picker.handleInput(ch);
	picker.handleInput("\r");
	assert.equal(result(), "low"); // still the preselected entry
});

test("empty match set renders a no-match state and enter is a no-op", () => {
	const { picker, result } = makePicker();
	current = picker;
	for (const ch of "qqqq") picker.handleInput(ch);
	picker.handleInput("\r");
	assert.equal(result(), null); // nothing selected: no crash, not settled
});

// The pure helpers are covered in ui.test.ts; this guards the seam between
// the component and the helper contract (fuzzyFilter reorders — ours must not).
test("fuzzyFilter from pi-tui reorders, our filter preserves input order", () => {
	const models = [
		{ provider: "b", id: "zzy", name: "" },
		{ provider: "a", id: "yyz", name: "" },
	];
	const reordered = fuzzyFilter(models, "y", (m) => `${m.provider}/${m.id}`);
	const ours = filterModels(models, "y");
	assert.deepEqual(
		ours.map((m) => m.provider),
		["b", "a"],
	); // unchanged
	assert.notDeepEqual(reordered, models); // proves pi-tui sorts by score
	// Preselect falls back to 0 for absent configured refs.
	assert.equal(preselectIndex(models, "gone/x"), 0);
});
