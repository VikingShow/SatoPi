/**
 * debate-node-behavior.test.ts — DebateNodeBehavior contracts (Phase E2).
 *
 * - enableDebate=false → plan passes through unchanged, factory never called.
 * - enableDebate=true + injected debateRoundtableFactory → the factory drives
 *   the debate (agentCount 2 / maxRounds 2 / convergenceThreshold 2) and the
 *   refined plan is persisted via onPlanUpdated.
 * - Debate failures degrade to a successful pass-through of the draft plan.
 */
import { describe, expect, test, vi } from "bun:test";
import type { Settings } from "../../config/settings";
import { DebateNodeBehavior } from "../behaviors/debate-node-behavior";
import type { DebateRoundtableResult } from "../behaviors/debate-roundtable";
import type { NodeBehaviorFactoryConfig } from "../node-behavior";
import type { NodeContext } from "../types";

// ============================================================================
// Fixtures
// ============================================================================

const DRAFT_PLAN = "# Draft plan\n\n## Phase 1\n- [ ] implement-login\n";

function makeConfig(
	_settings: Settings,
	factory: NodeBehaviorFactoryConfig["debateRoundtableFactory"],
): NodeBehaviorFactoryConfig {
	return {
		runtime: { spawn: vi.fn() } as never,
		hookPipeline: {} as never,
		contextPipeline: {} as never,
		workspace: "/tmp/ws",
		swarmDir: "/tmp/ws/.stp/sessions/swarm-theatre",
		loopConfig: {} as never,
		planContent: DRAFT_PLAN,
		debateRoundtableFactory: factory,
	};
}

function makeContext(
	overrides: Partial<{ onPlanUpdated: (content: string) => void; settings: Settings }>,
): NodeContext {
	return {
		node: {
			id: "debate",
			label: "Debate",
			description: "Refine the plan",
			role: "debater",
			tools: [],
			dependsOn: ["script"],
			type: "debate",
		},
		workspace: "/tmp/ws",
		modelRegistry: {} as never,
		settings: overrides.settings ?? ({ get: () => true } as unknown as Settings),
		upstreamOutputs: {},
		experience: "",
		signal: new AbortController().signal,
		runtime: { spawn: vi.fn() } as never,
		agentRegistry: {} as never,
		planContent: DRAFT_PLAN,
		onPlanUpdated: overrides.onPlanUpdated ?? vi.fn(),
	} as unknown as NodeContext;
}

function debateResult(overrides: Partial<DebateRoundtableResult> = {}): DebateRoundtableResult {
	return {
		converged: true,
		refinedPlan: "# Refined plan\n\n## Phase 1\n- [ ] implement-login (type: develop)",
		rounds: [{ round: 1, outputs: ["a"], similarity: null }],
		draftPlan: DRAFT_PLAN,
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("DebateNodeBehavior", () => {
	test("passes the plan through unchanged when debate is disabled", async () => {
		const factory = vi.fn();
		const onPlanUpdated = vi.fn();
		const behavior = new DebateNodeBehavior(
			makeConfig({ get: () => false } as unknown as Settings, factory as never),
		);
		const ctx = makeContext({ onPlanUpdated, settings: { get: () => false } as unknown as Settings });

		const result = await behavior.execute(ctx, await behavior.prepare(ctx));

		expect(result.success).toBe(true);
		expect(result.output).toContain("disabled");
		expect(factory).not.toHaveBeenCalled();
		expect(onPlanUpdated).not.toHaveBeenCalled();
	});

	test("drives the debate via the injected factory and persists the refined plan", async () => {
		const debate = { debate: vi.fn(async () => debateResult({ converged: true })) };
		const factory = vi.fn(() => debate);
		const onPlanUpdated = vi.fn();
		const behavior = new DebateNodeBehavior(makeConfig({ get: () => true } as unknown as Settings, factory as never));
		const ctx = makeContext({ onPlanUpdated });

		const result = await behavior.execute(ctx, await behavior.prepare(ctx));

		expect(factory).toHaveBeenCalledWith({
			agentCount: 2,
			maxRounds: 2,
			convergenceThreshold: 2,
			runtime: ctx.runtime,
		});
		expect(debate.debate).toHaveBeenCalledWith(
			DRAFT_PLAN,
			ctx.workspace,
			ctx.modelRegistry,
			ctx.settings,
			ctx.signal,
		);
		expect(onPlanUpdated).toHaveBeenCalledWith(debateResult().refinedPlan);
		expect(result.success).toBe(true);
		expect(result.metadata).toMatchObject({ converged: true, roundCount: 1 });
		expect(result.output).toContain("converged");
	});

	test("degrades to the draft plan when the debate throws", async () => {
		const debate = {
			debate: vi.fn(async () => {
				throw new Error("model timeout");
			}),
		};
		const factory = vi.fn(() => debate);
		const onPlanUpdated = vi.fn();
		const behavior = new DebateNodeBehavior(makeConfig({ get: () => true } as unknown as Settings, factory as never));
		const ctx = makeContext({ onPlanUpdated });

		const result = await behavior.execute(ctx, await behavior.prepare(ctx));

		expect(result.success).toBe(true);
		expect(result.output).toContain("model timeout");
		expect(onPlanUpdated).not.toHaveBeenCalled();
	});
});
