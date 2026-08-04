/**
 * profile-registry-persistence.test.ts — ProfileRegistry persistence +
 * validation contracts (Phase C of the crew-discovery TUI plan):
 *
 * - create / list / delete round trip through the on-disk format
 *   ({workspace}/.stp/profiles/{profileId}.json + _index.json)
 * - duplicate-id and invalid-id rejection
 * - exported validateProfileId / deriveProfileId / validateProfile helpers
 * - initGlobal builtin seeding and the ensureProfileRegistry no-reseed guard
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AgentProfile,
	deriveProfileId,
	ensureProfileRegistry,
	ProfileRegistry,
	validateProfile,
	validateProfileId,
} from "@satopi/pi-coding-agent/agent/agent-profile";
import { TempDir } from "@satopi/pi-utils";

/** Bun's fs.promises.access resolves `null` on success — assert existence instead. */
const fileExists = async (p: string): Promise<boolean> => Bun.file(p).exists();
const profilesDir = (dir: TempDir): string => path.join(dir.path(), ".stp", "profiles");

describe("ProfileRegistry — create/list/delete round trip", () => {
	let registry: ProfileRegistry;

	beforeEach(() => {
		registry = new ProfileRegistry();
	});

	test("createProfile — rejects duplicate profileIds", () => {
		registry.createProfile({ profileId: "dup", name: "A", archetype: "worker" });
		expect(() => registry.createProfile({ profileId: "dup", name: "B", archetype: "worker" })).toThrow(
			'Profile "dup" already exists',
		);
	});

	test("createProfile — rejects invalid (path-unsafe) profileIds", () => {
		for (const bad of ["", "with space", "a/b", "../escape", "a.b", "a:b", "a\\b"]) {
			expect(() => registry.createProfile({ profileId: bad, name: "X", archetype: "worker" })).toThrow(
				"Invalid profileId",
			);
		}
	});

	test("createProfile — rejects empty name / archetype (validateProfile early failure)", () => {
		expect(() => registry.createProfile({ profileId: "no-name", name: "", archetype: "worker" })).toThrow(
			'missing a name',
		);
		expect(() => registry.createProfile({ profileId: "no-arch", name: "X", archetype: "" })).toThrow(
			'missing an archetype',
		);
	});

	test("deleteProfile — removes from the registry and returns true only when present", () => {
		registry.createProfile({ profileId: "a", name: "A", archetype: "worker" });
		registry.createProfile({ profileId: "b", name: "B", archetype: "reviewer" });
		expect(registry.deleteProfile("a")).toBe(true);
		expect(registry.deleteProfile("a")).toBe(false);
		expect(registry.deleteProfile("missing")).toBe(false);
		expect(registry.list().map(p => p.profileId)).toEqual(["b"]);
	});
});

describe("ProfileRegistry — on-disk persistence", () => {
	let tmp: TempDir;

	beforeEach(() => {
		tmp = TempDir.createSync("@profile-registry-");
	});

	afterEach(() => {
		tmp.removeSync();
	});

	test("save/load — round trips profiles through .stp/profiles", async () => {
		const registry = new ProfileRegistry();
		registry.createProfile({
			profileId: "demo-agent",
			name: "Demo Agent",
			archetype: "reviewer",
			domains: ["typescript"],
		});
		registry.createProfile({ profileId: "solo", name: "Solo", archetype: "worker" });

		await registry.save(tmp.path());

		const dir = profilesDir(tmp);
		expect(await fileExists(path.join(dir, "demo-agent.json"))).toBe(true);
		expect(await fileExists(path.join(dir, "solo.json"))).toBe(true);
		expect(await fileExists(path.join(dir, "_index.json"))).toBe(true);

		const loaded = await ProfileRegistry.load(tmp.path());
		expect(loaded.list().map(p => p.profileId).sort()).toEqual(["demo-agent", "solo"]);
		expect(loaded.get("demo-agent")?.identity.archetype).toBe("reviewer");
		expect(loaded.get("demo-agent")?.credit.score).toBe(50);
	});

	test("deleteProfile + save — drops the profile from the index and unlinks its file", async () => {
		const registry = new ProfileRegistry();
		registry.createProfile({ profileId: "keep", name: "Keep", archetype: "worker" });
		registry.createProfile({ profileId: "drop", name: "Drop", archetype: "worker" });
		await registry.save(tmp.path());

		registry.deleteProfile("drop", tmp.path());
		await registry.save(tmp.path());

		const reloaded = await ProfileRegistry.load(tmp.path());
		expect(reloaded.list().map(p => p.profileId)).toEqual(["keep"]);
		expect(await fileExists(path.join(profilesDir(tmp), "drop.json"))).toBe(false);
		// Stale entries never resurrect: the on-disk index is rewritten from the registry.
		const index = JSON.parse(await fs.readFile(path.join(profilesDir(tmp), "_index.json"), "utf-8")) as {
			profileId: string;
		}[];
		expect(index.map(e => e.profileId)).toEqual(["keep"]);
	});
});

describe("ProfileRegistry — global singleton lifecycle", () => {
	let tmp: TempDir;

	beforeEach(() => {
		ProfileRegistry.resetGlobalForTests();
		tmp = TempDir.createSync("@profile-global-");
	});

	afterEach(() => {
		ProfileRegistry.resetGlobalForTests();
		tmp.removeSync();
	});

	test("initGlobal — seeds the builtin role profiles into an empty workspace", async () => {
		const registry = await ProfileRegistry.initGlobal(tmp.path());
		const ids = registry.list().map(p => p.profileId);
		expect(ids).toContain("swarm-planner");
		expect(ids).toContain("swarm-reviewer");
		expect(ids.length).toBeGreaterThanOrEqual(7);
	});

	test("ensureProfileRegistry — initializes once and never re-seeds after full deletion", async () => {
		const registry = await ensureProfileRegistry(tmp.path());
		expect(registry.list().length).toBeGreaterThanOrEqual(7);

		// User deletes every profile mid-session, then the command runs again:
		// the guard flag must NOT re-seed the builtins.
		for (const p of registry.list()) registry.deleteProfile(p.profileId, tmp.path());
		await registry.save(tmp.path());

		const again = await ensureProfileRegistry(tmp.path());
		expect(again).toBe(registry);
		expect(again.list()).toHaveLength(0);
	});
});

describe("validateProfileId / deriveProfileId / validateProfile", () => {
	test("validateProfileId — accepts path-safe ids only", () => {
		expect(validateProfileId("demo-agent")).toBe(true);
		expect(validateProfileId("Demo_Agent2")).toBe(true);
		expect(validateProfileId("")).toBe(false);
		expect(validateProfileId("with space")).toBe(false);
		expect(validateProfileId("../escape")).toBe(false);
		expect(validateProfileId("a.b")).toBe(false);
	});

	test("deriveProfileId — slugs display names into path-safe ids", () => {
		expect(deriveProfileId("Demo Agent!")).toBe("demo-agent");
		expect(deriveProfileId("  My-Agent_2  ")).toBe("my-agent_2");
		expect(deriveProfileId("UPPER Case")).toBe("upper-case");
		// No usable characters → empty string, which validateProfileId rejects.
		expect(deriveProfileId("!!!@@@")).toBe("");
		expect(validateProfileId(deriveProfileId("!!!@@@"))).toBe(false);
	});

	test("validateProfile — passes complete profiles, rejects incomplete ones", () => {
		const complete: AgentProfile = {
			profileId: "p",
			identity: { name: "P", archetype: "worker", description: "d", createdAt: 1 },
			expertise: { domains: [], proficiency: {}, specialties: [] },
			credit: {
				score: 50,
				totalTasks: 0,
				successRate: 0,
				praiseCount: 0,
				criticismCount: 0,
				violationCount: 0,
				violationHistory: [],
				lastActiveAt: 1,
			},
			social: { collaborators: [], collaborationCount: 0, citedBy: [] },
			stats: {
				avgTaskCompletionTime: 0,
				tasksCompletedByDomain: {},
				preferredRoles: [],
				rolePerformance: {},
			},
			offloadRefs: { l1History: [], l2Attributions: [], l3GraphRefs: [] },
		};
		expect(() => validateProfile(complete)).not.toThrow();
		expect(() => validateProfile({ ...complete, profileId: "bad id" })).toThrow("Invalid profileId");
		expect(() => validateProfile({ ...complete, identity: { ...complete.identity, name: "" } })).toThrow(
			"missing a name",
		);
		expect(() => validateProfile({ ...complete, identity: { ...complete.identity, archetype: "" } })).toThrow(
			"missing an archetype",
		);
	});
});
