import * as fs from "node:fs/promises";
import * as path from "node:path";

/** VCS metadata directories that must never be treated as benchmark output. */
const VCS_DIRS: Record<string, true> = {
	".git": true,
	".svn": true,
	".hg": true,
	".bzr": true,
};

export async function listFiles(rootDir: string, subPath = ""): Promise<string[]> {
	const entries = await fs.readdir(path.join(rootDir, subPath), { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const relativePath = path.join(subPath, entry.name);
		if (entry.isDirectory()) {
			if (VCS_DIRS[entry.name]) {
				continue;
			}
			files.push(...(await listFiles(rootDir, relativePath)));
		} else if (entry.isFile()) {
			files.push(relativePath);
		}
	}

	return files.sort();
}
