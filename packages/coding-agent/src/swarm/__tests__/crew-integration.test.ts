/**
 * crew-integration.test.ts — Integration tests for Swarm Crew Architecture.
 *
 * Covers the core data flow: parse → route → persist → render
 *
 * Tests:
 *   1. parseMentions: @mention splitting and broadcast extraction
 *   2. parseMentions: broadcast-only (no @mentions)
 *   3. createCrewMentionResolver: exact ID match
 *   4. createCrewMentionResolver: rejection of non-members
 *   5. CrewManager: create and restore crews
 *   6. CrewManager: addMember and removeMember
 *   7. SwarmModeController.createCrew: rejects <2 agents
 *   8. CrewEntryBlock: renders collapsed by default
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ProfileRegistry as ProfileRegistryType } from "../../agent/agent-profile";
import { ProfileRegistry } from "../../agent/agent-profile";
import type { AgentRef, AgentKind, AgentStatus } from "../../registry/agent-registry";
import { CrewManager } from "../../crew/crew-manager";
import { IrcBus } from "../../irc/bus";
import {
	parseMentions,
	createCrewMentionResolver,
} from "../../modes/mention-parser";
import { SwarmModeController, type SwarmModeControllerDeps } from "../../modes/controllers/swarm-mode-controller";
import { CrewEntryBlock, type CrewEntryBlockInput } from "../../modes/components/swarm/crew-entry-block";
import { getThemeByName, setThemeInstance, type Theme } from "../../modes/theme/theme";

// ============================================================================
// Helpers
// ============================================================================

/** Create a minimal AgentRef stub. Only id + displayName are used by the resolver. */
function makeRef(id: string, displayName: string): AgentRef {
	return {
		id,
		displayName,
		kind: "sub" as AgentKind,
		status: "idle" as AgentStatus,
		session: null,
		sessionFile: null,
		createdAt: Date.now(),
		lastActivity: Date.now(),
	};
}

// ============================================================================
// parseMentions
// ============================================================================

describe("parseMentions", () => {
	test("splits @agent mentions and leaves no broadcast when text starts with @mention", () => {
		const resolveAgent = (mention: string): string | null =>
			mention === "architect" ? "architect"
			: mention === "impl" ? "impl"
			: null;

		const result = parseMentions("@architect design API @impl start coding", resolveAgent);

		expect(result.mentions).toHaveLength(2);
		expect(result.mentions[0]).toEqual({ agentId: "architect", text: "design API" });
		expect(result.mentions[1]).toEqual({ agentId: "impl", text: "start coding" });
		expect(result.broadcast).toBe("");
	});

	test("extracts broadcast text before the first @mention", () => {
		const resolveAgent = (mention: string): string | null =>
			mention === "reviewer" ? "reviewer" : null;

		const result = parseMentions("hello everyone @reviewer please check this", resolveAgent);

		expect(result.mentions).toHaveLength(1);
		expect(result.mentions[0]).toEqual({ agentId: "reviewer", text: "please check this" });
		expect(result.broadcast).toBe("hello everyone");
	});

	test("returns broadcast only when no @mentions match", () => {
		const resolveAgent = () => null;

		const result = parseMentions("hello everyone", resolveAgent);

		expect(result.mentions).toEqual([]);
		expect(result.broadcast).toBe("hello everyone");
	});

	test("strips @mentions inside backtick code blocks", () => {
		const resolveAgent = (mention: string): string | null =>
			mention === "architect" ? "architect" : null;

		const result = parseMentions("run `@architect` please", resolveAgent);

		expect(result.mentions).toEqual([]);
		expect(result.broadcast).toBe("run `@architect` please");
	});

	test("handles empty input", () => {
		const resolveAgent = () => null;
		const result = parseMentions("", resolveAgent);

		expect(result.mentions).toEqual([]);
		expect(result.broadcast).toBe("");
	});

	test("trims whitespace from broadcast", () => {
		const resolveAgent = () => null;
		const result = parseMentions("   hello world   ", resolveAgent);

		expect(result.broadcast).toBe("hello world");
	});
});

// ============================================================================
// createCrewMentionResolver
// ============================================================================

describe("createCrewMentionResolver", () => {
	test("matches exact agent ID", () => {
		const memberIds = new Set(["architect", "reviewer"]);
		const agentRefs = new Map<string, AgentRef>([
			["architect", makeRef("architect", "Architect")],
			["reviewer", makeRef("reviewer", "Code Reviewer")],
		]);

		const resolve = createCrewMentionResolver(memberIds, agentRefs);

		expect(resolve("architect")).toBe("architect");
		expect(resolve("reviewer")).toBe("reviewer");
	});

	test("matches case-insensitive agent ID", () => {
		const memberIds = new Set(["architect"]);
		const agentRefs = new Map<string, AgentRef>([
			["architect", makeRef("architect", "Architect")],
		]);

		const resolve = createCrewMentionResolver(memberIds, agentRefs);

		expect(resolve("ARCHITECT")).toBe("architect");
		expect(resolve("Architect")).toBe("architect");
	});

	test("matches by display name (case-insensitive)", () => {
		const memberIds = new Set(["agent-1"]);
		const agentRefs = new Map<string, AgentRef>([
			["agent-1", makeRef("agent-1", "Senior Architect")],
		]);

		const resolve = createCrewMentionResolver(memberIds, agentRefs);

		expect(resolve("Senior Architect")).toBe("agent-1");
		expect(resolve("senior architect")).toBe("agent-1");
	});

	test("matches by unambiguous ID prefix", () => {
		const memberIds = new Set(["architect-v2"]);
		const agentRefs = new Map<string, AgentRef>([
			["architect-v2", makeRef("architect-v2", "Architect v2")],
		]);

		const resolve = createCrewMentionResolver(memberIds, agentRefs);

		expect(resolve("architect")).toBe("architect-v2");
	});

	test("returns null for non-members", () => {
		const memberIds = new Set(["architect"]);
		const agentRefs = new Map<string, AgentRef>([
			["architect", makeRef("architect", "Architect")],
		]);

		const resolve = createCrewMentionResolver(memberIds, agentRefs);

		expect(resolve("outsider")).toBeNull();
		expect(resolve("unknown")).toBeNull();
	});

	test("returns null for ambiguous prefix match", () => {
		const memberIds = new Set(["architect-v1", "architect-v2"]);
		const agentRefs = new Map<string, AgentRef>([
			["architect-v1", makeRef("architect-v1", "Architect v1")],
			["architect-v2", makeRef("architect-v2", "Architect v2")],
		]);

		const resolve = createCrewMentionResolver(memberIds, agentRefs);

		// "architect" is an ambiguous prefix of both IDs
		expect(resolve("architect")).toBeNull();
	});

	test("handles empty member set", () => {
		const resolve = createCrewMentionResolver(new Set(), new Map());

		expect(resolve("anyone")).toBeNull();
	});
});

// ============================================================================
// CrewManager
// ============================================================================

describe("CrewManager", () => {
	let crewsDir: string;

	beforeEach(async () => {
		IrcBus.resetGlobalForTests();
		crewsDir = await fs.mkdtemp(path.join(os.tmpdir(), "crew-test-"));
	});

	afterEach(async () => {
		IrcBus.resetGlobalForTests();
		await fs.rm(crewsDir, { recursive: true, force: true });
	});

	test("creates and restores crews", async () => {
		const bus = IrcBus.global();
		const mgr = new CrewManager(crewsDir, bus);

		// Create a crew
		const crewId = await mgr.createCrew("Test Crew", ["agent-1", "agent-2"]);

		// Verify crew exists in the manager
		const crew = mgr.getCrew(crewId);
		expect(crew).toBeDefined();
		expect(crew!.state.name).toBe("Test Crew");
		expect(crew!.state.members.length).toBe(3); // 2 agents + human observer

		// Verify human is auto-added as observer
		const human = crew!.state.members.find(m => m.agentId === "human");
		expect(human).toBeDefined();
		expect(human!.role).toBe("observer");

		// Verify summary
		const summaries = mgr.listCrews();
		expect(summaries).toHaveLength(1);
		expect(summaries[0].id).toBe(crewId);
		expect(summaries[0].name).toBe("Test Crew");
		expect(summaries[0].memberCount).toBe(3);

		// Create a second CrewManager and restore
		const mgr2 = new CrewManager(crewsDir, bus);
		await mgr2.restore();

		const restored = mgr2.getCrew(crewId);
		expect(restored).toBeDefined();
		expect(restored!.state.name).toBe("Test Crew");
		expect(restored!.state.members.length).toBe(3);
	});

	test("addMember and removeMember", async () => {
		const bus = IrcBus.global();
		const mgr = new CrewManager(crewsDir, bus);

		const crewId = await mgr.createCrew("Membership Test", ["agent-1"]);

		// Add a member
		await mgr.addMember(crewId, "agent-3");
		let crew = mgr.getCrew(crewId);
		expect(crew!.state.members.some(m => m.agentId === "agent-3")).toBe(true);

		// Remove a member
		await mgr.removeMember(crewId, "agent-1");
		crew = mgr.getCrew(crewId);
		expect(crew!.state.members.some(m => m.agentId === "agent-1")).toBe(false);
		expect(crew!.state.members.some(m => m.agentId === "agent-3")).toBe(true);

		// Human observer should remain
		expect(crew!.state.members.some(m => m.agentId === "human")).toBe(true);
	});

	test("addMember is idempotent", async () => {
		const bus = IrcBus.global();
		const mgr = new CrewManager(crewsDir, bus);

		const crewId = await mgr.createCrew("Dedup Test", ["agent-1"]);
		await mgr.addMember(crewId, "agent-1"); // already exists
		const crew = mgr.getCrew(crewId);
		// Should not duplicate
		const count = crew!.state.members.filter(m => m.agentId === "agent-1").length;
		expect(count).toBe(1);
	});

	test("disposeCrew removes crew from memory and disk", async () => {
		const bus = IrcBus.global();
		const mgr = new CrewManager(crewsDir, bus);

		const crewId = await mgr.createCrew("Disposable", ["agent-1"]);

		// Verify file exists
		const crewFile = path.join(crewsDir, `${crewId}.json`);
		await expect(fs.access(crewFile)).resolves.toBeNull();

		await mgr.disposeCrew(crewId);

		// Crew should be gone from memory
		expect(mgr.getCrew(crewId)).toBeUndefined();

		// File should be deleted
		await expect(fs.access(crewFile)).rejects.toThrow();
	});

	test("disposeAll cleans up all crews", async () => {
		const bus = IrcBus.global();
		const mgr = new CrewManager(crewsDir, bus);

		const id1 = await mgr.createCrew("Crew A", ["agent-1"]);
		const id2 = await mgr.createCrew("Crew B", ["agent-2"]);

		expect(mgr.listCrews()).toHaveLength(2);

		await mgr.disposeAll();

		expect(mgr.listCrews()).toHaveLength(0);
		expect(mgr.getCrew(id1)).toBeUndefined();
		expect(mgr.getCrew(id2)).toBeUndefined();
	});
});

// ============================================================================
// SwarmModeController.createCrew validation
// ============================================================================

describe("SwarmModeController.createCrew", () => {
	let crewsDir: string;
	let bus: IrcBus;
	let theme: Theme;
	let registry: ProfileRegistryType;

	beforeAll(async () => {
		const loaded = await getThemeByName("satopi");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
		theme = loaded;
	});

	beforeEach(async () => {
		IrcBus.resetGlobalForTests();
		ProfileRegistry.resetGlobalForTests();
		bus = IrcBus.global();
		registry = ProfileRegistry.global();
		crewsDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-ctrl-test-"));
	});

	afterEach(async () => {
		IrcBus.resetGlobalForTests();
		ProfileRegistry.resetGlobalForTests();
		await fs.rm(crewsDir, { recursive: true, force: true });
	});

	function makeController(overrides?: Partial<SwarmModeControllerDeps>): SwarmModeController {
		return new SwarmModeController({
			crewsDir,
			ircBus: bus,
			profileRegistry: registry,
			theme,
			...overrides,
		});
	}

	test("rejects fewer than 2 agents", async () => {
		const ctrl = makeController();
		await expect(ctrl.createCrew("Solo Crew", ["agent-1"])).rejects.toThrow(
			"A crew requires at least 2 agents",
		);
	});

	test("rejects empty agent list", async () => {
		const ctrl = makeController();
		await expect(ctrl.createCrew("Empty Crew", [])).rejects.toThrow(
			"A crew requires at least 2 agents",
		);
	});

	test("creates crew with 2+ agents and focuses it", async () => {
		// Register profiles via ProfileRegistry so credit check passes
		registry.createProfile({ profileId: "agent-1", name: "Agent One", archetype: "architect" });
		registry.createProfile({ profileId: "agent-2", name: "Agent Two", archetype: "implementer" });

		const ctrl = makeController();
		const crewId = await ctrl.createCrew("Valid Crew", ["agent-1", "agent-2"]);

		expect(crewId).toBeTruthy();
		expect(ctrl.activeCrewId).toBe(crewId);
		expect(ctrl.isCrewActive()).toBe(true);

		const activeCrew = ctrl.getActiveCrew();
		expect(activeCrew).toBeDefined();
		expect(activeCrew!.name).toBe("Valid Crew");
		expect(activeCrew!.members.length).toBe(3); // 2 agents + human
	});

	test("addMember and removeMember via controller", async () => {
		registry.createProfile({ profileId: "agent-1", name: "Agent One", archetype: "architect" });
		registry.createProfile({ profileId: "agent-2", name: "Agent Two", archetype: "implementer" });
		registry.createProfile({ profileId: "agent-3", name: "Agent Three", archetype: "reviewer" });

		const ctrl = makeController();
		await ctrl.createCrew("Expandable Crew", ["agent-1", "agent-2"]);

		// Add via controller
		await ctrl.addMember("agent-3");
		let crew = ctrl.getActiveCrew();
		expect(crew!.members.some(m => m.agentId === "agent-3")).toBe(true);

		// Remove via controller
		await ctrl.removeMember("agent-1");
		crew = ctrl.getActiveCrew();
		expect(crew!.members.some(m => m.agentId === "agent-1")).toBe(false);
	});
});

// ============================================================================
// CrewEntryBlock rendering
// ============================================================================

describe("CrewEntryBlock", () => {
	let theme: Theme;

	beforeAll(async () => {
		const loaded = await getThemeByName("satopi");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
		theme = loaded;
	});

	function makeInput(overrides?: Partial<CrewEntryBlockInput>): CrewEntryBlockInput {
		return {
			agentId: "test-agent",
			displayName: "Test Agent",
			body: "This is a test response.\nIt has multiple lines.",
			timestamp: Date.now(),
			...overrides,
		};
	}

	test("renders collapsed by default", () => {
		const block = new CrewEntryBlock(makeInput(), theme);
		const lines = block.render(80);

		expect(lines.length).toBeGreaterThan(0);
		// Collapsed view shows a truncated preview (first 2 lines of body)
		const joined = lines.join("\n");
		expect(joined).toContain("This is a test response.");

		// Should contain an expand hint
		expect(joined).toContain("Expand");
	});

	test("renders full body when expanded", () => {
		const block = new CrewEntryBlock(makeInput(), theme);

		// Toggle to expanded via handleInput (Enter key)
		block.handleInput("\r");

		const lines = block.render(80);
		const joined = lines.join("\n");

		expect(joined).toContain("This is a test response.");
		expect(joined).toContain("It has multiple lines.");
		// Expanded view should NOT have expand hint
		expect(joined).not.toContain("Expand");
	});

	test("renders tool call summary in collapsed view", () => {
		const input = makeInput({
			toolCalls: [
				{ name: "read", summary: "read file.ts" },
				{ name: "grep", summary: "search for pattern" },
			],
		});
		const block = new CrewEntryBlock(input, theme);
		const lines = block.render(80);
		const joined = lines.join("\n");

		expect(joined).toContain("2 tool calls");
		expect(joined).toContain("read()");
		expect(joined).toContain("grep()");
	});

	test("renders tool calls in expanded view", () => {
		const input = makeInput({
			toolCalls: [
				{ name: "bash", summary: "npm install" },
			],
		});
		const block = new CrewEntryBlock(input, theme);
		block.handleInput("\r"); // expand

		const lines = block.render(80);
		const joined = lines.join("\n");

		expect(joined).toContain("bash()");
		expect(joined).toContain("npm install");
	});

	test("renders credit badge when creditScore is provided", () => {
		const input = makeInput({ creditScore: 85 });
		const block = new CrewEntryBlock(input, theme);
		const lines = block.render(80);
		const joined = lines.join("\n");

		expect(joined).toContain("credit:85");
	});

	test("renders without error with minimal input", () => {
		const input: CrewEntryBlockInput = {
			agentId: "minimal-agent",
			displayName: "Minimal",
			body: "",
			timestamp: 0,
		};
		const block = new CrewEntryBlock(input, theme);
		const lines = block.render(40);

		expect(lines.length).toBeGreaterThan(0);
	});

	test("handleInput toggles collapse state on Enter", () => {
		const block = new CrewEntryBlock(makeInput(), theme);

		// Initially collapsed
		let lines = block.render(80);
		expect(lines.join("\n")).toContain("Expand");

		// Expand on Enter
		block.handleInput("\r");
		lines = block.render(80);
		expect(lines.join("\n")).not.toContain("Expand");

		// Collapse on Enter again
		block.handleInput("\r");
		lines = block.render(80);
		expect(lines.join("\n")).toContain("Expand");
	});

	test("renders status icons correctly", () => {
		const statuses: Array<CrewEntryBlockInput["status"]> = ["completed", "running", "failed", "pending"];
		for (const status of statuses) {
			const input = makeInput({ status });
			const block = new CrewEntryBlock(input, theme);
			const lines = block.render(80);
			expect(lines.length).toBeGreaterThan(0);
		}
	});
});
