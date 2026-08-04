/**
 * profile-select-dialog.test.ts — ProfileSelectDialog "+ Create new agent"
 * entry (Phase C of the crew-discovery TUI plan).
 *
 * The dialog is a plain Component: render(width) + handleInput(data) are
 * driven directly (no TUI). Draft-name mode collects alphanumeric keys,
 * Backspace deletes, Enter creates via the global ProfileRegistry (the item
 * list refresh is synchronous; persistence is fire-and-forget), Esc cancels;
 * a duplicate id keeps the dialog drafting with an inline error.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ProfileRegistry } from "@satopi/pi-coding-agent/agent/agent-profile";
import {
	ProfileSelectDialog,
	type ProfileSelectItem,
} from "@satopi/pi-coding-agent/modes/components/swarm/profile-select-dialog";
import { initTheme, theme } from "@satopi/pi-coding-agent/modes/theme/theme";
import { setProjectDir, TempDir } from "@satopi/pi-utils";

/** setProjectDir chdirs the worker process — restore the original cwd in teardown. */
const originalCwd = process.cwd();

const strip = (line: string): string => Bun.stripANSI(line);

function makeDialog(): { dialog: ProfileSelectDialog; items: ProfileSelectItem[] } {
	const items: ProfileSelectItem[] = [
		{
			profileId: "swarm-planner",
			name: "Planner",
			archetype: "planner",
			creditScore: 50,
			successRate: 0.5,
			domains: ["planning"],
			selected: false,
			warned: false,
		},
		{
			profileId: "swarm-implementer",
			name: "Implementer",
			archetype: "implementer",
			creditScore: 50,
			successRate: 0.5,
			domains: ["implementation"],
			selected: false,
			warned: false,
		},
	];
	const dialog = new ProfileSelectDialog(
		items,
		theme,
		() => {},
		() => {},
	);
	return { dialog, items };
}

function renderText(dialog: ProfileSelectDialog): string {
	return dialog.render(80).map(strip).join("\n");
}

/** Move the cursor onto the trailing "+ Create new agent" row and confirm. */
function openCreateRow(dialog: ProfileSelectDialog): void {
	dialog.handleInput("j");
	dialog.handleInput("j");
	dialog.handleInput("\n");
}

let tmp: TempDir;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	ProfileRegistry.resetGlobalForTests();
	tmp = TempDir.createSync("@profile-dialog-");
	setProjectDir(tmp.path());
	await ProfileRegistry.initGlobal(tmp.path());
});

afterEach(() => {
	ProfileRegistry.resetGlobalForTests();
	setProjectDir(originalCwd);
	tmp.removeSync();
});

describe("ProfileSelectDialog — create new agent", () => {
	test("renders a trailing + Create new agent row", () => {
		const { dialog } = makeDialog();
		const text = renderText(dialog);
		expect(text).toContain("+ Create new agent");
	});

	test("Enter on the create row enters draft mode; Esc cancels", () => {
		const { dialog } = makeDialog();
		openCreateRow(dialog);
		expect(renderText(dialog)).toContain("New agent name:");
		dialog.handleInput("\u001b");
		expect(renderText(dialog)).not.toContain("New agent name:");
	});

	test("draft keys append, backspace deletes, Enter creates and preselects", () => {
		const { dialog, items } = makeDialog();
		openCreateRow(dialog);
		for (const ch of "demx") dialog.handleInput(ch);
		expect(renderText(dialog)).toContain("demx");
		dialog.handleInput("\u007f"); // backspace removes the "x"
		dialog.handleInput("o"); // → "demo"
		dialog.handleInput("\n");

		// The item list refresh is synchronous, so the new agent is visible
		// immediately after the Enter that confirms the draft.
		const text = renderText(dialog);
		expect(text).toContain("demo");
		expect(text).not.toContain("New agent name:");
		expect(items.map(i => i.profileId)).toEqual(["swarm-planner", "swarm-implementer", "demo"]);
		expect(items[2]!.selected).toBe(true);
		const demoRow = text.split("\n").find(line => line.includes("demo"));
		expect(demoRow).toContain("\u2713"); // checked marker — preselected

		// Created through the global registry with default credit.
		const profile = ProfileRegistry.global().get("demo");
		expect(profile?.identity.name).toBe("demo");
		expect(profile?.identity.archetype).toBe("worker");
		expect(profile?.credit.score).toBe(50);
	});

	test("duplicate id keeps the dialog in draft mode with an inline error", () => {
		// Pre-create the id so the dialog's create attempt collides.
		ProfileRegistry.global().createProfile({ profileId: "demo", name: "Demo", archetype: "worker" });
		const before = ProfileRegistry.global().list().length;

		const { dialog } = makeDialog();
		openCreateRow(dialog);
		for (const ch of "demo") dialog.handleInput(ch);
		dialog.handleInput("\n");

		const text = renderText(dialog);
		expect(text).toContain("New agent name:"); // still drafting
		expect(text).toContain("already exists"); // inline warning row
		expect(ProfileRegistry.global().list().length).toBe(before); // no duplicate created
	});

	test("draft confirm with an empty name shows an inline error", () => {
		const { dialog } = makeDialog();
		openCreateRow(dialog);
		dialog.handleInput("\n");
		const text = renderText(dialog);
		expect(text).toContain("Name cannot be empty");
		expect(text).toContain("New agent name:");
	});

	test("non-alphanumeric draft keys are ignored (no injection into the name)", () => {
		const { dialog } = makeDialog();
		openCreateRow(dialog);
		dialog.handleInput("d");
		dialog.handleInput("!");
		dialog.handleInput(" ");
		expect(renderText(dialog)).toContain("d");
		expect(renderText(dialog)).not.toContain("d!");
	});
});
