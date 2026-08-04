/**
 * tool-context-comm-channel.test.ts — ToolContextStore.commChannel seam (Phase D2).
 *
 * createAgentSession calls ToolContextStore.setCommChannel(options.commChannel);
 * the store's getContext() then exposes that channel on every AgentToolContext
 * handed to session tools. These tests pin that seam and prove the resulting
 * context actually drives the agent-channel tools (agent_peers) against a real
 * channel's members.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TextContent } from "@satopi/pi-ai";
import { CommChannel } from "@satopi/pi-coding-agent/comm/comm-channel";
import type { CustomToolContext } from "@satopi/pi-coding-agent/extensibility/custom-tools/types";
import { IrcBus } from "@satopi/pi-coding-agent/irc/bus";
import { AgentPeersTool } from "@satopi/pi-coding-agent/tools/agent-channel-tools";
import { ToolContextStore } from "@satopi/pi-coding-agent/tools/context";

function makeChannel(bus: IrcBus, agentIds: string[]): CommChannel {
	return new CommChannel(bus, agentIds, []);
}

function makeStore(): ToolContextStore {
	return new ToolContextStore(() => ({}) as unknown as CustomToolContext);
}

describe("ToolContextStore.commChannel", () => {
	let bus: IrcBus;

	beforeEach(() => {
		IrcBus.resetGlobalForTests();
		bus = IrcBus.global();
	});

	afterEach(() => {
		IrcBus.resetGlobalForTests();
	});

	test("context exposes no commChannel until setCommChannel is called", () => {
		expect(makeStore().getContext().commChannel).toBeUndefined();
	});

	test("setCommChannel exposes the channel on subsequent tool contexts", () => {
		const store = makeStore();
		const channel = makeChannel(bus, ["agent-x", "agent-y"]);
		store.setCommChannel(channel);
		expect(store.getContext().commChannel).toBe(channel);
	});

	test("agent-channel tools resolve a real channel's members via the store context", async () => {
		const store = makeStore();
		store.setCommChannel(makeChannel(bus, ["agent-x", "agent-y", "agent-z"]));
		const ctx = store.getContext();

		const tool = new AgentPeersTool();
		const result = await tool.execute("t1", {}, undefined, undefined, ctx);

		expect(result.isError).toBeUndefined();
		expect((result.content[0] as TextContent).text).toContain("3 peer");
		expect(result.details!.map(d => d.id).sort()).toEqual(["agent-x", "agent-y", "agent-z"]);
	});
});
