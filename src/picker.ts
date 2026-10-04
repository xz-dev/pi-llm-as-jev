/**
 * Searchable picker overlay over Pi TUI primitives (tasks 8.2/8.3). One
 * component built from `Container` + `Text` + `Input` + `SelectList`, using
 * the host's keybindings for navigation. Item order is the caller's order
 * (alphabetical for the model picker); filtering is delegated to the
 * caller's pure helper so filtered results keep that order. Cancel resolves
 * `undefined` and changes nothing.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	Container,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";

/** Theme color callback shape used by this component (subset of Pi's Theme). */
export interface PickerTheme {
	fg(color: string, text: string): string;
}

/** Minimal structural slice of the extension UI context (`ctx.ui.custom`). */
export interface PickerUI {
	custom<T>(
		factory: (
			tui: TUI,
			theme: PickerTheme,
			keybindings: ReturnType<typeof getKeybindings>,
			done: (result: T) => void,
		) => Component & { dispose?(): void },
		options?: { overlay?: boolean },
	): Promise<T | undefined>;
}

export interface PickerSpec {
	title: string;
	/** Ordered items; the picker preserves this order exactly. */
	items: SelectItem[];
	/** Real index into `items` to preselect in place (not moved to top). */
	preselectIndex: number;
	/**
	 * Ordered subset of item values matching a query; null disables
	 * filtering (the level picker has a handful of rows).
	 */
	filter: ((query: string) => string[]) | null;
}

export async function pickFromList(
	ui: PickerUI,
	spec: PickerSpec,
): Promise<string | undefined> {
	return ui.custom<string | undefined>(
		(_tui, theme, _keybindings, done) =>
			new SearchablePickerComponent(spec, done, theme),
		{ overlay: true },
	);
}

/** No-color fallback when the host provides no theme callbacks. */
const plainTheme: PickerTheme = { fg: (_c, text) => text };

/**
 * `Input` search box + `SelectList` results. Arrow keys / enter / escape
 * are routed to the list; every other key goes to the search input, and the
 * list is rebuilt from the filtered values while keeping the current
 * selection when it survives the filter.
 */
export class SearchablePickerComponent extends Container {
	private readonly searchInput: Input;
	private list: SelectList;
	private readonly listChildIndex: number;
	private readonly spec: PickerSpec;
	private readonly done: (result: string | undefined) => void;
	private readonly theme: PickerTheme;
	private readonly allItems: SelectItem[];
	private closed = false;

	constructor(
		spec: PickerSpec,
		done: (result: string | undefined) => void,
		theme?: PickerTheme,
	) {
		super();
		this.spec = spec;
		this.done = done;
		this.theme = theme ?? plainTheme;
		this.allItems = spec.items;

		this.addChild(new Text(this.theme.fg("accent", this.spec.title), 0, 0));
		this.addChild(new Spacer(1));
		this.searchInput = new Input({ prompt: "/ " });
		this.searchInput.onSubmit = () => {
			const item = this.list.getSelectedItem();
			if (item) this.finish(item.value);
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.list = this.buildList(this.allItems, this.spec.preselectIndex);
		this.listChildIndex = this.children.length;
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				this.theme.fg(
					"dim",
					"Type to filter · ↑/↓ move · Enter select · Esc cancel",
				),
				0,
				0,
			),
		);
	}

	private buildList(items: SelectItem[], preselect: number): SelectList {
		const list = new SelectList(items, 10, selectListTheme(this.theme), {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 48,
		});
		if (items.length > 0) {
			list.setSelectedIndex(Math.min(Math.max(0, preselect), items.length - 1));
		}
		list.onSelect = (item) => this.finish(item.value);
		list.onCancel = () => this.finish(undefined);
		return list;
	}

	private finish(result: string | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.done(result);
	}

	private applyFilter(): void {
		if (!this.spec.filter) return;
		const query = this.searchInput.getValue();
		const values = this.spec.filter(query);
		const kept = this.allItems.filter((item) => values.includes(item.value));
		// Keep the current selection when it survives the filter; else top row.
		const current = this.list.getSelectedItem()?.value;
		const preselect = Math.max(
			0,
			kept.findIndex((item) => item.value === current),
		);
		this.list = this.buildList(kept, preselect);
		this.children[this.listChildIndex] = this.list;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.finish(undefined);
			return;
		}
		const isList =
			kb.matches(data, "tui.select.up") ||
			kb.matches(data, "tui.select.down") ||
			kb.matches(data, "tui.select.confirm");
		if (isList) {
			this.list.handleInput(data);
			return;
		}
		this.searchInput.handleInput(data);
		this.applyFilter();
	}
}

/** SelectList theme callbacks in the host theme's colors. */
function selectListTheme(theme: PickerTheme): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}
