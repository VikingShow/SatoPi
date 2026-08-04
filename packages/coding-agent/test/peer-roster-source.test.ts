/**
 * peer-roster-source.test.ts — PeerRosterSource contract tests (Phase D1 of the
 * crew-discovery TUI plan):
 *
 * - fragment is a well-formed-ish <peer_roster> block listing every peer's
 *   id / displayName / role / status
 * - the agent itself is excluded; advisor refs are never listed as peers
 * - empty registry renders a "no peers" note, not a crash or empty string
 * - the entry cap is respected (custom cap and the default 32)
 * - XML attribute escaping keeps displayNames with markup/entities safe
 * - registered on a ContextPipeline, the roster lands in the assembled
 *   systemPrompt (the production injection path)
 */
import { describe, expect, test } from "bun:test";
import {
	type AgentSpecLike,
	type BuildContext,
	ContextPipeline,
	type PhaseInfo,
} from "@satopi/pi-coding-agent/context/context-pipeline";
import { DEFAULT_PEER_ROSTER_CAP, PeerRosterSource } from "@satopi/pi-coding-agent/context/sources/peer-roster-source";
import { AgentRegistry } from "@satopi/pi-coding-agent/registry/agent-registry";

// ============================================================================
// Helpers
// ============================================================================

const SPEC: AgentSpecLike = { id: "Main", role: "lead", task: "coordinate the crew" };

const PHASE: PhaseInfo = { phase: "stage", multiAgent: true, humanMode: "observer" };

const BASE: BuildContext = {
	taskDescription: "Ship the feature",
	workspace: "/tmp/test-workspace",
	swarmDir: "/tmp/test-workspace/.stp",
	turnNumber: 1,
	phase: PHASE,
	accumulated: {},
};

function register(
	registry: AgentRegistry,
	id: string,
	displayName: string,
	extra: Partial<Record<"kind" | "role" | "status", string>> = {},
): void {
	registry.register({
		id,
		displayName,
		kind: (extra.kind ?? "sub") as "sub",
		session: null,
		role: extra.role,
		status: (extra.status ?? "idle") as "idle",
	});
}

function countPeerEntries(text: string | undefined): number {
	return (text?.match(/<peer /g) ?? []).length;
}

// ============================================================================
// Tests
// ============================================================================

describe("PeerRosterSource", () => {
	test("lists every registered peer with id, displayName, role and status", async () => {
		const registry = new AgentRegistry();
		register(registry, "WorkerA", "Worker A", { role: "reviewer", status: "running" });
		register(registry, "WorkerB", "Worker B", { role: "worker", status: "idle" });

		const fragment = await new PeerRosterSource(registry).build(SPEC, BASE);

		expect(fragment.systemPromptAddition).toContain("<peer_roster>");
		expect(fragment.systemPromptAddition).toContain("</peer_roster>");
		expect(fragment.systemPromptAddition).toContain('id="WorkerA"');
		expect(fragment.systemPromptAddition).toContain('name="Worker A"');
		expect(fragment.systemPromptAddition).toContain('role="reviewer"');
		expect(fragment.systemPromptAddition).toContain('status="running"');
		expect(fragment.systemPromptAddition).toContain('id="WorkerB"');
		expect(fragment.systemPromptAddition).toContain('status="idle"');
	});

	test("orders peers deterministically by id regardless of registration order", async () => {
		const registry = new AgentRegistry();
		register(registry, "WorkerB", "Worker B");
		register(registry, "WorkerA", "Worker A");

		const fragment = await new PeerRosterSource(registry).build(SPEC, BASE);
		const text = fragment.systemPromptAddition!;

		expect(text.indexOf('id="WorkerA"')).toBeLessThan(text.indexOf('id="WorkerB"'));
	});

	test("excludes the agent itself", async () => {
		const registry = new AgentRegistry();
		register(registry, "Main", "Main", { kind: "main", status: "running" });
		register(registry, "WorkerA", "Worker A");

		const fragment = await new PeerRosterSource(registry).build(SPEC, BASE);

		expect(fragment.systemPromptAddition).not.toContain('id="Main"');
		expect(fragment.systemPromptAddition).toContain("collaborating with 1 other agent");
		expect(countPeerEntries(fragment.systemPromptAddition)).toBe(1);
	});

	test("never lists advisor refs as peers", async () => {
		const registry = new AgentRegistry();
		register(registry, "Main/advisor", "advisor", { kind: "advisor" });
		register(registry, "WorkerA", "Worker A");

		const fragment = await new PeerRosterSource(registry).build(SPEC, BASE);

		expect(fragment.systemPromptAddition).not.toContain("Main/advisor");
		expect(countPeerEntries(fragment.systemPromptAddition)).toBe(1);
	});

	test("empty registry renders an explicit no-peers note", async () => {
		const registry = new AgentRegistry();

		const fragment = await new PeerRosterSource(registry).build(SPEC, BASE);

		expect(fragment.systemPromptAddition).toContain("<peer_roster>");
		expect(fragment.systemPromptAddition).toContain("No peers currently registered.");
		expect(countPeerEntries(fragment.systemPromptAddition)).toBe(0);
	});

	test("respects a custom cap and reports the truncated remainder", async () => {
		const registry = new AgentRegistry();
		for (let i = 0; i < 12; i++) {
			register(registry, `Worker${String(i).padStart(2, "0")}`, `Worker ${i}`);
		}

		const fragment = await new PeerRosterSource(registry, { cap: 5 }).build(SPEC, BASE);

		expect(countPeerEntries(fragment.systemPromptAddition)).toBe(5);
		expect(fragment.systemPromptAddition).toContain("... and 7 more");
	});

	test(`caps at the default ${DEFAULT_PEER_ROSTER_CAP} entries`, async () => {
		const registry = new AgentRegistry();
		for (let i = 0; i < DEFAULT_PEER_ROSTER_CAP + 8; i++) {
			register(registry, `Worker${String(i).padStart(2, "0")}`, `Worker ${i}`);
		}

		const fragment = await new PeerRosterSource(registry).build(SPEC, BASE);

		expect(countPeerEntries(fragment.systemPromptAddition)).toBe(DEFAULT_PEER_ROSTER_CAP);
		expect(fragment.systemPromptAddition).toContain(`... and 8 more`);
	});

	test("escapes XML-special characters in displayName and role", async () => {
		const registry = new AgentRegistry();
		register(registry, "Weird", 'A & B <dev> "qa"', { role: 'tester & "x" <y>' });

		const fragment = await new PeerRosterSource(registry).build(SPEC, BASE);

		expect(fragment.systemPromptAddition).toContain('name="A &amp; B &lt;dev&gt; &quot;qa&quot;"');
		expect(fragment.systemPromptAddition).toContain('role="tester &amp; &quot;x&quot; &lt;y&gt;"');
	});

	test("defaults to the global singleton when no registry is injected", async () => {
		const source = new PeerRosterSource();
		expect(source).toBeInstanceOf(PeerRosterSource);
	});

	test("interface contract: name, priority, appliesTo all phases and roles", async () => {
		const source = new PeerRosterSource(new AgentRegistry());

		expect(source.name).toBe("peer-roster");
		expect(source.priority).toBe(8);
		for (const phase of ["script", "stage", "curtain", "idle"]) {
			expect(source.appliesTo(phase as never, "worker")).toBe(true);
			expect(source.appliesTo(phase as never, "reviewer")).toBe(true);
		}
	});

	test("registered on a ContextPipeline, the roster lands in the assembled systemPrompt", async () => {
		const registry = new AgentRegistry();
		register(registry, "WorkerA", "Worker A", { role: "worker", status: "running" });

		const pipeline = new ContextPipeline();
		pipeline.register(new PeerRosterSource(registry));

		const assembled = await pipeline.assemble(SPEC, PHASE, BASE);

		expect(assembled.systemPrompt).toContain("<peer_roster>");
		expect(assembled.systemPrompt).toContain('id="WorkerA"');
		expect(assembled.metadata["peer-roster"]).toContain("systemPrompt");
	});
});
