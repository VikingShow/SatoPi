/**
 * SplitView — Horizontal split layout for TUI.
 *
 * Renders two components side by side: a sidebar (left) and a main view (right).
 * The sidebar width is configurable and can be toggled (Ctrl+B).
 *
 * ## Layout
 *   ┌── Sidebar ──┬── Main View ───────────────────────┐
 *   │ agent list   │ transcript / editor                 │
 *   │ ...          │ ...                                 │
 *   └──────────────┴─────────────────────────────────────┘
 */

import type { Component } from "@satopi/pi-tui";

export interface SplitViewConfig {
	/** Sidebar component. */
	sidebar: Component;
	/** Main view component. */
	main: Component;
	/** Sidebar width in columns (default 30). */
	sidebarWidth?: number;
	/** Whether the sidebar is visible (default true). */
	sidebarVisible?: boolean;
}

export class SplitView implements Component {
	readonly name = "SplitView";
	rows = 0;
	cols = 0;

	readonly #config: SplitViewConfig;
	#sidebarWidth: number;
	#sidebarVisible: boolean;

	constructor(config: SplitViewConfig) {
		this.#config = config;
		this.#sidebarWidth = config.sidebarWidth ?? 30;
		this.#sidebarVisible = config.sidebarVisible ?? true;
	}

	get sidebarWidth(): number {
		return this.#sidebarWidth;
	}

	get sidebarVisible(): boolean {
		return this.#sidebarVisible;
	}

	/** Toggle sidebar visibility. */
	toggleSidebar(): void {
		this.#sidebarVisible = !this.#sidebarVisible;
	}

	/** Resize sidebar width by delta columns. */
	resizeSidebar(delta: number): void {
		this.#sidebarWidth = Math.max(10, Math.min(60, this.#sidebarWidth + delta));
	}

	layout(maxRows: number, maxCols: number): void {
		this.rows = maxRows;
		this.cols = maxCols;
		const mainWidth = this.#sidebarVisible ? maxCols - this.#sidebarWidth - 1 : maxCols;
		const sidebarRows = maxRows;
		const mainRows = maxRows;

		this.#config.sidebar.rows = sidebarRows;
		this.#config.sidebar.cols = this.#sidebarVisible ? this.#sidebarWidth : 0;
		this.#config.sidebar.layout?.(sidebarRows, this.#sidebarVisible ? this.#sidebarWidth : 0);

		this.#config.main.rows = mainRows;
		this.#config.main.cols = Math.max(1, mainWidth);
		this.#config.main.layout?.(mainRows, Math.max(1, mainWidth));
	}

	render(): string[] {
		const maxRows = this.rows;
		const sidebarLines = this.#sidebarVisible ? this.#config.sidebar.render() : [];
		const mainLines = this.#config.main.render();
		const separator = this.#sidebarVisible ? "│" : "";

		const result: string[] = [];
		for (let i = 0; i < maxRows; i++) {
			const left = i < sidebarLines.length ? sidebarLines[i].padEnd(this.#sidebarWidth) : " ".repeat(this.#sidebarWidth);
			const right = i < mainLines.length ? mainLines[i] : "";
			result.push(this.#sidebarVisible ? `${left}${separator}${right}` : right);
		}

		return result;
	}

	/** Forward keyboard events to sidebar or main based on focus. */
	handleKey?(key: string): boolean {
		// Forward to sidebar if it handles the key
		if (this.#sidebarVisible && this.#config.sidebar.handleKey?.(key)) {
			return true;
		}
		// Otherwise forward to main
		return this.#config.main.handleKey?.(key) ?? false;
	}
}
