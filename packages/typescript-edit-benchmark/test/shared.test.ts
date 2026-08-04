import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@satopi/pi-utils";
import { listFiles } from "@satopi/typescript-edit-benchmark/shared";

describe("listFiles", () => {
	it("excludes VCS metadata directories like .git", async () => {
		const tempDir = await TempDir.create("@reach-benchmark-listfiles-");
		try {
			const root = tempDir.absolute();
			await fs.mkdir(path.join(root, ".git", "objects"), { recursive: true });
			await fs.mkdir(path.join(root, ".svn"), { recursive: true });
			await fs.mkdir(path.join(root, "src"), { recursive: true });
			await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
			await fs.writeFile(path.join(root, ".svn", "entries"), "12\n");
			await fs.writeFile(path.join(root, "src", "index.ts"), "export const x = 1;\n");
			await fs.writeFile(path.join(root, "README.md"), "# demo\n");

			const files = await listFiles(root);
			expect(files).toEqual(["README.md", "src/index.ts"]);
			expect(files.some(f => f.includes(".git"))).toBe(false);
			expect(files.some(f => f.includes(".svn"))).toBe(false);
		} finally {
			await tempDir.remove();
		}
	});

	it("excludes nested VCS directories", async () => {
		const tempDir = await TempDir.create("@reach-benchmark-listfiles-");
		try {
			const root = tempDir.absolute();
			await fs.mkdir(path.join(root, "pkg", ".git"), { recursive: true });
			await fs.writeFile(path.join(root, "pkg", ".git", "config"), "[core]\n");
			await fs.writeFile(path.join(root, "pkg", "main.ts"), "export const y = 2;\n");

			const files = await listFiles(root);
			expect(files).toEqual(["pkg/main.ts"]);
		} finally {
			await tempDir.remove();
		}
	});
});
