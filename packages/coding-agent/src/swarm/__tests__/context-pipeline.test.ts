/**
 * context-pipeline.test.ts — Unit tests for ContextPipeline system.
 *
 * Covers:
 * 1. Priority ordering — sources execute in priority order
 * 2. Phase filtering — sources with appliesTo=false are skipped
 * 3. Fragment merging — systemPrompt additions are joined correctly
 * 4. toTransformContext — returned function prepends injectedMessages
 * 5. Empty pipeline — assemble with no sources returns base context
 * 6. Multiple sources — all applicable sources contribute
 * 7. Error isolation — one source failing doesn't crash the pipeline
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import {
	type AgentSpecLike,
	type BuildContext,
	type ContextFragment,
	ContextPipeline,
	type ContextSource,
	type PhaseInfo,
} from "../context-manager/context-pipeline";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a mock ContextSource for testing.
 */
function mockSource(opts: {
	name: string;
	priority: number;
	appliesTo?: (phase: string, agentRole: string) => boolean;
	build?: (spec: AgentSpecLike, base: BuildContext) => Promise<ContextFragment>;
	/** If true, build() throws an error (for error-isolation tests). */
	throws?: boolean;
}): ContextSource {
	return {
		name: opts.name,
		priority: opts.priority,
		appliesTo: opts.appliesTo ?? (() => true),
		build:
			opts.build ??
			(async (_spec, _base) => ({
				systemPromptAddition: `[${opts.name}] system prompt`,
				taskPromptAddition: `[${opts.name}] task prompt`,
				tools: [`tool-${opts.name}`],
				injectedMessages: [{ role: "user", content: `[${opts.name}] injected message`, timestamp: 0 }],
			})),
		...(opts.throws
			? {
					build: async () => {
						throw new Error(`Source "${opts.name}" intentionally failed`);
					},
				}
			: {}),
	};
}

const DEFAULT_PHASE: PhaseInfo = {
	phase: "script",
	multiAgent: true,
	humanMode: "dialogue",
};

const DEFAULT_SPEC: AgentSpecLike = {
	id: "agent-1",
	role: "planner",
	task: "Create a plan.md for the project",
};

const DEFAULT_BUILD_CONTEXT: BuildContext = {
	taskDescription: "Build a REST API for user management",
	workspace: "/tmp/test-workspace",
	swarmDir: "/tmp/test-workspace/.swarm_test",
	planContent: "## Tasks\n- [ ] implement-auth",
	turnNumber: 1,
	phase: DEFAULT_PHASE,
	accumulated: {},
};

// ============================================================================
// Tests
// ============================================================================

describe("ContextPipeline", () => {
	let pipeline: ContextPipeline;

	beforeEach(() => {
		pipeline = new ContextPipeline();
	});

	// ── Empty pipeline ──────────────────────────────────────────────────

	test("assemble with no sources returns base context", async () => {
		const result = await pipeline.assemble(DEFAULT_SPEC, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);

		expect(result.systemPrompt).toBe("");
		expect(result.taskPrompt).toBe(DEFAULT_BUILD_CONTEXT.taskDescription);
		expect(result.tools).toEqual([]);
		expect(result.injectedMessages).toEqual([]);
		expect(Object.keys(result.metadata)).toHaveLength(0);
	});

	test("listSources returns empty array for empty pipeline", () => {
		expect(pipeline.listSources()).toEqual([]);
	});

	// ── Priority ordering ──────────────────────────────────────────────

	test("sources execute in priority order", async () => {
		const executionOrder: string[] = [];

		pipeline.register(
			mockSource({
				name: "low-priority",
				priority: 10,
				build: async () => {
					executionOrder.push("low-priority");
					return {};
				},
			}),
		);
		pipeline.register(
			mockSource({
				name: "high-priority",
				priority: 1,
				build: async () => {
					executionOrder.push("high-priority");
					return {};
				},
			}),
		);
		pipeline.register(
			mockSource({
				name: "mid-priority",
				priority: 5,
				build: async () => {
					executionOrder.push("mid-priority");
					return {};
				},
			}),
		);

		await pipeline.assemble(DEFAULT_SPEC, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);

		expect(executionOrder).toEqual(["high-priority", "mid-priority", "low-priority"]);
	});

	test("listSources returns sources sorted by priority", () => {
		pipeline.register(mockSource({ name: "low", priority: 10 }));
		pipeline.register(mockSource({ name: "high", priority: 1 }));
		pipeline.register(mockSource({ name: "mid", priority: 5 }));

		const list = pipeline.listSources();
		expect(list).toEqual([
			{ name: "high", priority: 1 },
			{ name: "mid", priority: 5 },
			{ name: "low", priority: 10 },
		]);
	});

	// ── Phase filtering ────────────────────────────────────────────────

	test("sources with appliesTo=false are skipped", async () => {
		const executed: string[] = [];

		pipeline.register(
			mockSource({
				name: "script-only",
				priority: 1,
				appliesTo: phase => phase === "script",
				build: async () => {
					executed.push("script-only");
					return { systemPromptAddition: "script context" };
				},
			}),
		);
		pipeline.register(
			mockSource({
				name: "stage-only",
				priority: 2,
				appliesTo: phase => phase === "stage",
				build: async () => {
					executed.push("stage-only");
					return { systemPromptAddition: "stage context" };
				},
			}),
		);

		const stagePhase: PhaseInfo = {
			phase: "stage",
			multiAgent: true,
			humanMode: "observer",
		};

		const result = await pipeline.assemble(DEFAULT_SPEC, stagePhase, {
			...DEFAULT_BUILD_CONTEXT,
			phase: stagePhase,
		});

		expect(executed).toEqual(["stage-only"]);
		expect(result.systemPrompt).toContain("stage context");
		expect(result.systemPrompt).not.toContain("script context");
	});

	test("appliesTo receives agentRole for role-based filtering", async () => {
		const capturedRoles: string[] = [];

		pipeline.register(
			mockSource({
				name: "architect-only",
				priority: 1,
				appliesTo: (_phase, agentRole) => {
					capturedRoles.push(agentRole);
					return agentRole === "architect";
				},
				build: async () => ({ systemPromptAddition: "architect context" }),
			}),
		);

		const devSpec: AgentSpecLike = {
			id: "agent-2",
			role: "backend-dev",
			task: "Implement auth",
		};

		const result = await pipeline.assemble(devSpec, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);

		expect(capturedRoles).toEqual(["backend-dev"]);
		expect(result.systemPrompt).not.toContain("architect context");
	});

	// ── Fragment merging ───────────────────────────────────────────────

	test("systemPrompt additions are joined with newlines", async () => {
		pipeline.register(
			mockSource({
				name: "source-a",
				priority: 1,
				build: async () => ({ systemPromptAddition: "System part A" }),
			}),
		);
		pipeline.register(
			mockSource({
				name: "source-b",
				priority: 2,
				build: async () => ({ systemPromptAddition: "System part B" }),
			}),
		);

		const result = await pipeline.assemble(DEFAULT_SPEC, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);

		expect(result.systemPrompt).toBe("System part A\nSystem part B");
	});

	test("taskPrompt additions are joined with source content", async () => {
		pipeline.register(
			mockSource({
				name: "guidance",
				priority: 1,
				build: async () => ({ taskPromptAddition: "=== Guidance ===\nBe thorough." }),
			}),
		);

		const result = await pipeline.assemble(DEFAULT_SPEC, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);

		expect(result.taskPrompt).toContain(DEFAULT_BUILD_CONTEXT.taskDescription);
		expect(result.taskPrompt).toContain("=== Guidance ===");
	});

	test("tools from multiple sources are unioned (no duplicates)", async () => {
		pipeline.register(
			mockSource({
				name: "source-a",
				priority: 1,
				build: async () => ({ tools: ["read_file", "write_file"] }),
			}),
		);
		pipeline.register(
			mockSource({
				name: "source-b",
				priority: 2,
				build: async () => ({ tools: ["write_file", "execute_command"] }),
			}),
		);

		const result = await pipeline.assemble(DEFAULT_SPEC, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);

		expect(result.tools).toContain("read_file");
		expect(result.tools).toContain("write_file");
		expect(result.tools).toContain("execute_command");
		// No duplicates
		expect(result.tools.filter(t => t === "write_file")).toHaveLength(1);
	});

	test("injectedMessages from multiple sources are concatenated in order", async () => {
		pipeline.register(
			mockSource({
				name: "source-a",
				priority: 1,
				build: async (_spec, _base) => ({
					injectedMessages: [
						{ role: "user", content: "Message A1", timestamp: 0 },
						{ role: "user", content: "Message A2", timestamp: 0 },
					],
				}),
			}),
		);
		pipeline.register(
			mockSource({
				name: "source-b",
				priority: 2,
				build: async (_spec, _base) => ({
					injectedMessages: [{ role: "user", content: "Message B1", timestamp: 0 }],
				}),
			}),
		);

		const result = await pipeline.assemble(DEFAULT_SPEC, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);

		expect(result.injectedMessages).toHaveLength(3);
		expect((result.injectedMessages[0] as UserMessage).content).toBe("Message A1");
		expect((result.injectedMessages[1] as UserMessage).content).toBe("Message A2");
		expect((result.injectedMessages[2] as UserMessage).content).toBe("Message B1");
	});

	test("metadata tracks contributions from each source", async () => {
		pipeline.register(
			mockSource({
				name: "role-source",
				priority: 0,
				build: async () => ({
					systemPromptAddition: "role system",
					tools: ["tool-a"],
				}),
			}),
		);
		pipeline.register(
			mockSource({
				name: "empty-source",
				priority: 1,
				build: async () => ({}),
			}),
		);

		const result = await pipeline.assemble(DEFAULT_SPEC, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);

		expect(result.metadata["role-source"]).toContain("systemPrompt");
		expect(result.metadata["role-source"]).toContain("tools");
		expect(result.metadata["empty-source"]).toBe("(no additions)");
	});

	// ── toTransformContext ──────────────────────────────────────────────

	test("toTransformContext prepends injectedMessages to the message array", async () => {
		pipeline.register(
			mockSource({
				name: "injector",
				priority: 1,
				build: async (_spec, _base) => ({
					injectedMessages: [
						{ role: "user", content: "Injected context 1", timestamp: 0 },
						{ role: "user", content: "Injected context 2", timestamp: 0 },
					],
				}),
			}),
		);

		const assembled = await pipeline.assemble(DEFAULT_SPEC, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);
		const transform = pipeline.toTransformContext(assembled);

		const originalMessages = [
			{ role: "user" as const, content: "Original message 1", timestamp: 0 },
			{ role: "assistant" as const, content: "Original response", timestamp: 0 },
		] as AgentMessage[];

		const result = await transform(originalMessages);

		expect(result).toHaveLength(4);
		expect((result[0] as UserMessage).content).toBe("Injected context 1");
		expect((result[1] as UserMessage).content).toBe("Injected context 2");
		expect((result[2] as UserMessage).content).toBe("Original message 1");
		expect((result[3] as { content: string }).content).toBe("Original response");
	});

	test("toTransformContext returns original messages when no injectedMessages", async () => {
		const assembled = {
			systemPrompt: "",
			taskPrompt: "test task",
			tools: [],
			injectedMessages: [],
			metadata: {},
		};

		const transform = pipeline.toTransformContext(assembled);

		const originalMessages = [{ role: "user", content: "hello", timestamp: 0 }] as AgentMessage[];

		const result = await transform(originalMessages);

		expect(result).toBe(originalMessages);
	});

	test("toTransformContext returns a Promise-based function", async () => {
		const assembled = {
			systemPrompt: "test",
			taskPrompt: "test",
			tools: [],
			injectedMessages: [{ role: "user", content: "injected", timestamp: 0 }] as AgentMessage[],
			metadata: {},
		};

		const transform = pipeline.toTransformContext(assembled);

		// Verify it returns a Promise (is async)
		const result = transform([]);
		expect(result).toBeInstanceOf(Promise);
		const resolved = await result;
		expect(resolved).toHaveLength(1);
	});

	// ── Multiple sources ────────────────────────────────────────────────

	test("all applicable sources contribute to the assembled context", async () => {
		pipeline.register(
			mockSource({
				name: "role",
				priority: 0,
				build: async () => ({
					systemPromptAddition: "<!-- role definition -->",
					tools: ["tool-1"],
				}),
			}),
		);
		pipeline.register(
			mockSource({
				name: "profile",
				priority: 1,
				build: async () => ({
					systemPromptAddition: "<!-- profile context -->",
				}),
			}),
		);
		pipeline.register(
			mockSource({
				name: "turn-guidance",
				priority: 3,
				build: async () => ({
					taskPromptAddition: "<!-- turn 1 guidance -->",
				}),
			}),
		);

		const result = await pipeline.assemble(DEFAULT_SPEC, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);

		expect(result.systemPrompt).toContain("role definition");
		expect(result.systemPrompt).toContain("profile context");
		expect(result.taskPrompt).toContain("turn 1 guidance");
		expect(result.tools).toContain("tool-1");
		expect(Object.keys(result.metadata)).toHaveLength(3);
	});

	// ── Error isolation ─────────────────────────────────────────────────

	test("one source failing does not crash the pipeline", async () => {
		pipeline.register(
			mockSource({
				name: "good-source",
				priority: 1,
				build: async () => ({ systemPromptAddition: "I work fine" }),
			}),
		);
		pipeline.register(
			mockSource({
				name: "bad-source",
				priority: 2,
				throws: true,
			}),
		);
		pipeline.register(
			mockSource({
				name: "also-good",
				priority: 3,
				build: async () => ({ systemPromptAddition: "I also work" }),
			}),
		);

		const result = await pipeline.assemble(DEFAULT_SPEC, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);

		expect(result.systemPrompt).toContain("I work fine");
		expect(result.systemPrompt).toContain("I also work");
		expect(result.metadata["good-source"]).toBeDefined();
		expect(result.metadata["bad-source"]).toContain("ERROR");
		expect(result.metadata["also-good"]).toBeDefined();
	});

	test("error metadata captures the error message", async () => {
		pipeline.register(
			mockSource({
				name: "failing-source",
				priority: 1,
				throws: true,
			}),
		);

		const result = await pipeline.assemble(DEFAULT_SPEC, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);

		expect(result.metadata["failing-source"]).toMatch(/ERROR.*intentionally failed/);
	});

	test("all sources failing produces empty context with error metadata", async () => {
		pipeline.register(mockSource({ name: "fail-a", priority: 1, throws: true }));
		pipeline.register(mockSource({ name: "fail-b", priority: 2, throws: true }));

		const result = await pipeline.assemble(DEFAULT_SPEC, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);

		expect(result.systemPrompt).toBe("");
		expect(result.tools).toEqual([]);
		expect(result.injectedMessages).toEqual([]);
		expect(result.metadata["fail-a"]).toContain("ERROR");
		expect(result.metadata["fail-b"]).toContain("ERROR");
	});

	// ── Edge cases ─────────────────────────────────────────────────────

	test("sources see previously accumulated context via base.accumulated", async () => {
		const seenAccumulated: string[] = [];

		pipeline.register(
			mockSource({
				name: "first",
				priority: 1,
				build: async (_spec, base) => {
					seenAccumulated.push(`first saw systemPrompt: "${base.accumulated.systemPrompt ?? ""}"`);
					return { systemPromptAddition: "first-content" };
				},
			}),
		);
		pipeline.register(
			mockSource({
				name: "second",
				priority: 2,
				build: async (_spec, base) => {
					seenAccumulated.push(`second saw systemPrompt: "${base.accumulated.systemPrompt ?? ""}"`);
					return { systemPromptAddition: "second-content" };
				},
			}),
		);

		await pipeline.assemble(DEFAULT_SPEC, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);

		expect(seenAccumulated[0]).toContain('first saw systemPrompt: ""');
		expect(seenAccumulated[1]).toContain('second saw systemPrompt: "first-content"');
	});

	test("source returning empty fragment contributes nothing", async () => {
		pipeline.register(
			mockSource({
				name: "empty",
				priority: 1,
				build: async () => ({}),
			}),
		);

		const result = await pipeline.assemble(DEFAULT_SPEC, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);

		expect(result.systemPrompt).toBe("");
		expect(result.tools).toEqual([]);
		expect(result.injectedMessages).toEqual([]);
		expect(result.metadata["empty"]).toBe("(no additions)");
	});

	test("null/undefined fragment fields are handled gracefully", async () => {
		pipeline.register(
			mockSource({
				name: "sparse",
				priority: 1,
				build: async () => ({
					systemPromptAddition: undefined,
					taskPromptAddition: undefined,
					tools: undefined,
					injectedMessages: undefined,
				}),
			}),
		);

		const result = await pipeline.assemble(DEFAULT_SPEC, DEFAULT_PHASE, DEFAULT_BUILD_CONTEXT);

		// Should not crash
		expect(result.systemPrompt).toBe("");
		expect(result.metadata["sparse"]).toBe("(no additions)");
	});
});
