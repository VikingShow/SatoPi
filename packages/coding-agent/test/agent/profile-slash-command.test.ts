/**
 * profile-slash-command.test.ts — `/profile` slash command (Phase C of the
 * crew-discovery TUI plan).
 *
 * The handler is invoked through the real registry entry (lookupBuiltinSlash-
 * Command) with a minimal runtime whose `output` captures emitted text. The
 * global ProfileRegistry is pointed at a temp workspace via setProjectDir, so
 * create/list/delete exercise the real persistence path end to end.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { ProfileRegistry } from "@satopi/pi-coding-agent/agent/agent-profile";
import { lookupBuiltinSlashCommand } from "@satopi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand } from "@satopi/pi-coding-agent/slash-commands/helpers/parse";
import type { SlashCommandRuntime } from "@satopi/pi-coding-agent/slash-commands/types";
import { setProjectDir, TempDir } from "@satopi/pi-utils";

/** setProjectDir chdirs the worker process — restore the original cwd in teardown. */
const originalCwd = process.cwd();

let tmp: TempDir;
let output: string[];
let runtime: SlashCommandRuntime;

beforeEach(() => {
	ProfileRegistry.resetGlobalForTests();
	tmp = TempDir.createSync("@profile-cmd-");
	setProjectDir(tmp.path());
	output = [];
	runtime = {
		cwd: tmp.path(),
		output: (text: string) => {
			output.push(text);
		},
	} as unknown as SlashCommandRuntime;
});

afterEach(() => {
	ProfileRegistry.resetGlobalForTests();
	setProjectDir(originalCwd);
	tmp.removeSync();
});

async function runCommand(text: string): Promise<void> {
	const spec = lookupBuiltinSlashCommand("profile");
	expect(spec, "profile command must be registered").toBeDefined();
	const parsed = parseSlashCommand(text);
	expect(parsed).not.toBeNull();
	await spec!.handle!(parsed!, runtime);
}

function lastOutput(): string {
	return output[output.length - 1] ?? "";
}

describe("/profile", () => {
	test("registers with list/create/delete subcommands", () => {
		const spec = lookupBuiltinSlashCommand("profile");
		expect(spec?.allowArgs).toBe(true);
		expect(spec?.subcommands?.map(s => s.name)).toEqual(["list", "create", "delete"]);
	});

	test("create — derives a safe profileId from the name and persists it", async () => {
		await runCommand("/profile create Demo Agent");
		expect(output[0]).toBe('Created profile "demo" (Demo, worker, credit 50).');
		expect(ProfileRegistry.global().get("demo")?.identity.name).toBe("Demo");
		expect(await Bun.file(path.join(tmp.path(), ".stp", "profiles", "demo.json")).exists()).toBe(true);
	});

	test("list — renders a table containing the new profile", async () => {
		await runCommand("/profile create demo");
		await runCommand("/profile list");
		const table = lastOutput();
		expect(table).toContain("profileId");
		expect(table).toContain("credit");
		expect(table).toContain("demo");
	});

	test("create — honors --archetype and --domains", async () => {
		await runCommand("/profile create Auditor --archetype reviewer --domains typescript,backend");
		const profile = ProfileRegistry.global().get("auditor");
		expect(profile?.identity.archetype).toBe("reviewer");
		expect(profile?.expertise.domains).toEqual(["typescript", "backend"]);
	});

	test("create — rejects duplicate ids with an inline error", async () => {
		await runCommand("/profile create demo");
		await runCommand("/profile create demo");
		expect(lastOutput()).toContain('Profile "demo" already exists');
	});

	test("create — rejects names that cannot yield a safe id", async () => {
		await runCommand("/profile create @@@@");
		expect(lastOutput()).toContain("Invalid name");
	});

	test("delete — removes the profile and its index entry", async () => {
		await runCommand("/profile create demo");
		await runCommand("/profile delete demo");
		expect(output[1]).toBe('Deleted profile "demo".');
		expect(ProfileRegistry.global().has("demo")).toBe(false);
		await runCommand("/profile list");
		expect(lastOutput()).not.toContain("demo");
		expect(await Bun.file(path.join(tmp.path(), ".stp", "profiles", "demo.json")).exists()).toBe(false);
	});

	test("delete — reports unknown ids without erroring", async () => {
		await runCommand("/profile delete nope");
		expect(lastOutput()).toBe('No profile "nope".');
	});

	test("delete — rejects unsafe ids", async () => {
		await runCommand("/profile delete bad id");
		expect(lastOutput()).toContain("Invalid profile id");
	});

	test("usage — prints the usage line for unknown verbs", async () => {
		await runCommand("/profile frobnicate");
		expect(lastOutput()).toContain("Usage: /profile");
	});
});
