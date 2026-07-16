import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileTracker } from "../file-tracker";

/**
 * FileTracker unit tests.
 *
 * Focuses on the two contracts:
 *  1. File path extraction from worker output (extractFilePaths)
 *  2. Conflict report formatting (formatConflictReport)
 *
 * The git-diff path is integration-tested via the existing smoke test
 * and manually in the swarm pipeline.
 */

describe("FileTracker — conflict report formatting", () => {
	it("returns empty string for no conflicts", () => {
		const result = FileTracker.formatConflictReport({
			changedFiles: [],
			conflicts: [],
		});
		expect(result).toBe("");
	});

	it("returns empty string for zero-overlap, zero-unattributed", () => {
		const result = FileTracker.formatConflictReport({
			changedFiles: ["src/a.ts", "src/b.ts"],
			conflicts: [
				{ file: "src/a.ts", writers: ["worker-1"], severity: "single" },
				{ file: "src/b.ts", writers: ["worker-2"], severity: "single" },
			],
		});
		// No overlap, no unattributed → no report
		expect(result).toBe("");
	});

	it("reports overlap conflicts with file and writer names", () => {
		const result = FileTracker.formatConflictReport({
			changedFiles: ["src/conflict.ts"],
			conflicts: [
				{
					file: "src/conflict.ts",
					writers: ["worker-1", "worker-3"],
					severity: "overlap",
				},
			],
		});
		expect(result).toContain("src/conflict.ts");
		expect(result).toContain("worker-1");
		expect(result).toContain("worker-3");
		expect(result).toContain("multiple workers");
		expect(result).toContain("IRC");
	});

	it("reports unattributed changed files", () => {
		const result = FileTracker.formatConflictReport({
			changedFiles: ["src/mystery.ts"],
			conflicts: [{ file: "src/mystery.ts", writers: [], severity: "single" }],
		});
		expect(result).toContain("src/mystery.ts");
		expect(result).toContain("could not be attributed");
	});

	it("reports both overlap and unattributed together", () => {
		const result = FileTracker.formatConflictReport({
			changedFiles: ["src/hot.ts", "src/unknown.ts"],
			conflicts: [
				{
					file: "src/hot.ts",
					writers: ["worker-1", "worker-2"],
					severity: "overlap",
				},
				{ file: "src/unknown.ts", writers: [], severity: "single" },
			],
		});
		expect(result).toContain("multiple workers");
		expect(result).toContain("could not be attributed");
	});

	it("includes coordination advice for multiple conflicts", () => {
		const result = FileTracker.formatConflictReport({
			changedFiles: ["src/a.ts", "src/b.ts"],
			conflicts: [
				{
					file: "src/a.ts",
					writers: ["worker-1", "worker-2"],
					severity: "overlap",
				},
				{
					file: "src/b.ts",
					writers: ["worker-3", "worker-4"],
					severity: "overlap",
				},
			],
		});
		expect(result).toContain("Pro-tip");
	});
});

describe("FileTracker — round lifecycle (git-dependent)", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = path.join(os.tmpdir(), `file-tracker-test-${Date.now()}`);
		await fs.mkdir(tmpDir, { recursive: true });

		// Initialize git repo
		const { $ } = await import("bun");
		await $`git init`.cwd(tmpDir).quiet();
		await $`git config user.email "test@test"`.cwd(tmpDir).quiet();
		await $`git config user.name "Test"`.cwd(tmpDir).quiet();
		// Empty initial commit so HEAD exists
		await $`git commit --allow-empty -m "init"`.cwd(tmpDir).quiet();
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("startRound + endRound with no changes returns empty", async () => {
		const tracker = new FileTracker();
		await tracker.startRound(tmpDir);

		const summary = await tracker.endRound(new Map());
		expect(summary.changedFiles).toEqual([]);
		expect(summary.conflicts).toEqual([]);
	});

	it("endRound with unattributed changes reports them", async () => {
		const tracker = new FileTracker();
		await tracker.startRound(tmpDir);

		// Create a file that changed but no worker output claims it
		await fs.writeFile(path.join(tmpDir, "unattributed.txt"), "content");
		const { $ } = await import("bun");
		await $`git add unattributed.txt && git commit -m "add file"`.cwd(tmpDir).quiet();

		const summary = await tracker.endRound(new Map());
		// Should have 1 changed file, 1 unattributed conflict
		expect(summary.changedFiles).toContain("unattributed.txt");
		const unattributed = summary.conflicts.filter(c => c.writers.length === 0);
		expect(unattributed.length).toBe(1);
		expect(unattributed[0].file).toBe("unattributed.txt");
	});

	it("endRound attributes changes to workers from their output", async () => {
		const tracker = new FileTracker();
		await tracker.startRound(tmpDir);

		// Create dir structure and file
		await fs.mkdir(path.join(tmpDir, "src/lib"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, "src/lib/auth.ts"), "// auth module");
		const { $ } = await import("bun");
		await $`git add src/lib/auth.ts && git commit -m "add auth"`.cwd(tmpDir).quiet();

		// Worker output that references the file
		const summary = await tracker.endRound(
			new Map([
				["worker-1", "I modified src/lib/auth.ts to add login flow"],
				["worker-2", "I worked on src/lib/db.ts"],
			]),
		);
		expect(summary.changedFiles).toContain("src/lib/auth.ts");
		// worker-1's output mentions auth.ts, worker-2 mentions db.ts → only worker-1
		const authConflict = summary.conflicts.find(c => c.file === "src/lib/auth.ts");
		expect(authConflict).toBeDefined();
		expect(authConflict!.writers).toContain("worker-1");
		expect(authConflict!.severity).toBe("single");
	});

	it("endRound detects overlap when multiple workers reference same file", async () => {
		const tracker = new FileTracker();
		await tracker.startRound(tmpDir);
		await fs.mkdir(path.join(tmpDir, "src/lib"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, "src/lib/shared.ts"), "// shared");
		const { $ } = await import("bun");
		await $`git add src/lib/shared.ts && git commit -m "add shared"`.cwd(tmpDir).quiet();

		const summary = await tracker.endRound(
			new Map([
				["worker-1", "Updated src/lib/shared.ts — added export"],
				["worker-3", "Refactored src/lib/shared.ts — cleaned imports"],
			]),
		);
		const overlap = summary.conflicts.find(c => c.file === "src/lib/shared.ts");
		expect(overlap).toBeDefined();
		expect(overlap!.severity).toBe("overlap");
		expect(overlap!.writers).toContain("worker-1");
		expect(overlap!.writers).toContain("worker-3");
	});

	it("endRound gracefully handles non-git workspace", async () => {
		const tracker = new FileTracker();
		await tracker.startRound(tmpDir);
		// No changes, no git issues → empty
		const summary = await tracker.endRound(new Map());
		expect(summary.changedFiles).toEqual([]);
		expect(summary.conflicts).toEqual([]);
	});

	it("startRound survives empty/null workspace", async () => {
		const tracker = new FileTracker();
		// Should not throw when workspace is empty
		await tracker.startRound("");
		const summary = await tracker.endRound(new Map());
		expect(summary.changedFiles).toEqual([]);
	});
});
