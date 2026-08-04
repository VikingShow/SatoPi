/**
 * swarm-mode-controller-spawn.test.ts — Crew-member spawn wiring (Phase D2/D3).
 *
 * #spawnCrewMembers must pass the ACTIVE crew's CommChannel into
 * createAgentSession (so agent-channel tools resolve real crew members), grant
 * crew members the irc + agent_peers tools, and point them at their crew
 * roster. The spawn only runs from the profile-select dialog confirm path, so
 * this test drives that path and inspects the captured createAgentSession
 * options.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import type { Model } from "@satopi/pi-ai";
import { ProfileRegistry } from "@satopi/pi-coding-agent/agent/agent-profile";
import type { ModelRegistry } from "@satopi/pi-coding-agent/config/model-registry";
import type { Settings } from "@satopi/pi-coding-agent/config/settings";
import { IrcBus } from "@satopi/pi-coding-agent/irc/bus";
import type { ProfileSelectDialog } from "@satopi/pi-coding-agent/modes/components/swarm/profile-select-dialog";
import { SwarmModeController } from "@satopi/pi-coding-agent/modes/controllers/swarm-mode-controller";
import { initTheme, theme } from "@satopi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@satopi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@satopi/pi-coding-agent/sdk";
import * as sdkModule from "@satopi/pi-coding-agent/sdk";
import type { AgentSession } from "@satopi/pi-coding-agent/session/agent-session";
import { setProjectDir, TempDir } from "@satopi/pi-utils";

const model = { provider: "anthropic", id: "claude-sonnet-4-5" } as Model;

/** Minimal session surface #spawnCrewMembers drives: subscribe + beforeToolCall slot. */
function stubSession(): AgentSession {
	return {
		subscribe: vi.fn(),
		agent: {},
	} as unknown as AgentSession;
}

const originalCwd = process.cwd();

let tmp: TempDir;
let controller: SwarmModeController;
let captured: CreateAgentSessionOptions[];

/** Select both profiles in the pending dialog and confirm (Enter). */
function selectAndConfirm(): void {
	const dialog = controller.pendingDialog as unknown as ProfileSelectDialog;
	dialog.handleInput(" "); // toggle profile 0
	dialog.handleInput("j"); // move to profile 1
	dialog.handleInput(" "); // toggle profile 1
	dialog.handleInput("\n"); // confirm — fires the crew spawn path
}

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	ProfileRegistry.resetGlobalForTests();
	captured = [];
	tmp = TempDir.createSync("@swarm-spawn-");
	setProjectDir(tmp.path());
	await ProfileRegistry.initGlobal(tmp.path());
	// initGlobal seeds the 7 builtin role profiles (swarm-planner, ...); the
	// profile-select dialog lists them, and the first two are selected below.

	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
		captured.push(options);
		return { session: stubSession() } as unknown as CreateAgentSessionResult;
	});

	controller = new SwarmModeController({
		crewsDir: `${tmp.path()}/crews`,
		ircBus: IrcBus.global(),
		profileRegistry: ProfileRegistry.global(),
		modelRegistry: { getAvailable: () => [model] } as unknown as ModelRegistry,
		settings: { get: () => undefined } as unknown as Settings,
		theme,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	ProfileRegistry.resetGlobalForTests();
	setProjectDir(originalCwd);
	tmp.removeSync();
});

describe("SwarmModeController #spawnCrewMembers", () => {
	test("passes the active crew's commChannel, irc/agent_peers tools, and roster pointer", async () => {
		const crewIdPromise = controller.createCrewWithDialog("Test Crew");
		selectAndConfirm();
		const crewId = await crewIdPromise;

		const channel = controller.crewManager.getCrew(crewId)?.channel;
		expect(channel).toBeDefined();
		expect(captured.length).toBe(2);
		for (const options of captured) {
			// The ACTIVE crew's real CommChannel — not the global default channel.
			expect(options.commChannel).toBe(channel);
			// Crew members can discover peers and chat with them.
			expect(options.toolNames).toEqual(expect.arrayContaining(["irc", "agent_peers"]));
			// The crew prompt points members at their roster.
			expect(options.systemPrompt).toContain("<peer_roster>");
			expect(options.systemPrompt).toContain("address crewmates by @agent-id");
		}
	});
});
