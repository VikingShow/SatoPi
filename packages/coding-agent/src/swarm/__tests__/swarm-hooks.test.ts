/**
 * swarm-hooks.test.ts — SwarmHooks 集成测试
 *
 * 覆盖：
 * 1. createSwarmHooks 返回 hooks + context getters
 * 2. beforeWorkerRound 注册 Profile + 放置 start Mark
 * 3. afterWorkerRound 记录任务完成 + 放置 artifact Mark
 * 4. afterClonerReview praise/criticism → 信用分变更 + 违规记录
 * 5. afterClonerReview FAIL → warning Mark
 * 6. context.getAgentContext → 组合 Profile + Mark 注入文本
 * 7. context.getSwarmCreditSummary → 信用排名
 * 8. onHookError 不崩溃
 * 9. disabled 模式跳过所有操作
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { ProfileRegistry } from "../agent-profile";
import { MarkEnvironment } from "../mark-environment";
import { createSwarmHooks } from "../swarm-hooks";
import type { LoopPipelineHooks, PipelineContext } from "../pipeline";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";

/** Empty pipeline context for test hooks */
function emptyCtx(): PipelineContext {
	return { waves: [], totalTokens: 0, totalRequests: 0 };
}

/** Create a mock SingleResult for a worker */
function mockResult(id: string, exitCode: number, output: string): SingleResult {
	return {
		id, exitCode,
		agent: id, agentSource: "project", task: "test",
		output, stderr: "", truncated: false, durationMs: 0,
		tokens: 0, requests: 0, index: 0,
	};
}

describe("createSwarmHooks", () => {
	let profileRegistry: ProfileRegistry;
	let markEnvironment: MarkEnvironment;
	let hooks: LoopPipelineHooks;
	let context: ReturnType<typeof createSwarmHooks>["context"];

	beforeEach(() => {
		profileRegistry = new ProfileRegistry();
		markEnvironment = new MarkEnvironment();
		const result = createSwarmHooks({
			enabled: true,
			profileRegistry,
			markEnvironment,
		});
		hooks = result.hooks;
		context = result.context;
	});

	// ── beforeWorkerRound ─────────────────────────────────────────────

	test("beforeWorkerRound — creates profiles for new workers", async () => {
		await hooks.beforeWorkerRound!(1, ["worker-1", "worker-2"], emptyCtx());

		expect(profileRegistry.has("worker-1")).toBe(true);
		expect(profileRegistry.has("worker-2")).toBe(true);
		expect(profileRegistry.get("worker-1")!.identity.archetype).toBe("worker");
	});

	test("beforeWorkerRound — idempotent profile creation", async () => {
		await hooks.beforeWorkerRound!(1, ["worker-1"], emptyCtx());
		await hooks.beforeWorkerRound!(2, ["worker-1"], emptyCtx());

		// Should not throw, should not create duplicate
		expect(profileRegistry.has("worker-1")).toBe(true);
	});

	test("beforeWorkerRound — places start-round signal marks", async () => {
		await hooks.beforeWorkerRound!(1, ["worker-1"], emptyCtx());

		const signals = markEnvironment.queryMarks({ types: ["signal"], agentId: "worker-1" });
		expect(signals.length).toBeGreaterThanOrEqual(1);
		expect(signals[0].message).toContain("round 1");
	});

	test("beforeWorkerRound — records collaboration", async () => {
		await hooks.beforeWorkerRound!(1, ["worker-1", "worker-2", "worker-3"], emptyCtx());

		const w1 = profileRegistry.get("worker-1")!;
		expect(w1.social.collaborationCount).toBe(1);
		expect(w1.social.collaborators).toContain("worker-2");
		expect(w1.social.collaborators).toContain("worker-3");
	});

	// ── afterWorkerRound ──────────────────────────────────────────────

	test("afterWorkerRound — records task success", async () => {
		await hooks.beforeWorkerRound!(1, ["worker-1"], emptyCtx());
		await hooks.afterWorkerRound!(1, [
			mockResult("worker-1", 0, "Task completed successfully"),
		], emptyCtx());

		const w1 = profileRegistry.get("worker-1")!;
		expect(w1.credit.score).toBe(53); // 50 + 3
		expect(w1.credit.successRate).toBe(1);
	});

	test("afterWorkerRound — records task failure", async () => {
		await hooks.beforeWorkerRound!(1, ["worker-1"], emptyCtx());
		await hooks.afterWorkerRound!(1, [
			mockResult("worker-1", 1, "Build failed"),
		], emptyCtx());

		const w1 = profileRegistry.get("worker-1")!;
		expect(w1.credit.score).toBe(50); // unchanged
		expect(w1.credit.successRate).toBe(0);
	});

	test("afterWorkerRound — places artifact marks", async () => {
		await hooks.beforeWorkerRound!(1, ["worker-1"], emptyCtx());
		await hooks.afterWorkerRound!(1, [
			mockResult("worker-1", 0, "Refactored auth module"),
		], emptyCtx());

		const artifacts = markEnvironment.queryMarks({ types: ["artifact"] });
		expect(artifacts.length).toBeGreaterThanOrEqual(1);
		expect(artifacts[0].message).toContain("Refactored auth module");
	});

	// ── afterClonerReview ─────────────────────────────────────────────

	test("afterClonerReview PASS — records praise for praised workers", async () => {
		// Create profiles first
		await hooks.beforeWorkerRound!(1, ["worker-1", "worker-2"], emptyCtx());

		await hooks.afterClonerReview!(1, {
			passed: true,
			approvalCount: 2,
			totalCount: 2,
			findings: [
				"Praise: worker-1 delivered excellent work",
				"worker-2 output approved",
			],
		}, emptyCtx());

		const w1 = profileRegistry.get("worker-1")!;
		expect(w1.credit.praiseCount).toBe(1);
		expect(w1.credit.score).toBeGreaterThanOrEqual(55); // 50 + 5
	});

	test("afterClonerReview FAIL — records violations", async () => {
		await hooks.beforeWorkerRound!(1, ["worker-1"], emptyCtx());

		await hooks.afterClonerReview!(1, {
			passed: false,
			approvalCount: 0,
			totalCount: 2,
			findings: [
				"FAIL: worker-1 has critical bug in auth flow",
				"FAIL: worker-1 incorrect output format",
			],
		}, emptyCtx());

		const w1 = profileRegistry.get("worker-1")!;
		expect(w1.credit.violationCount).toBeGreaterThanOrEqual(1);
		expect(w1.credit.violationHistory.length).toBeGreaterThanOrEqual(1);
	});

	test("afterClonerReview FAIL — places warning mark", async () => {
		await hooks.beforeWorkerRound!(1, ["worker-1"], emptyCtx());

		await hooks.afterClonerReview!(1, {
			passed: false,
			approvalCount: 0,
			totalCount: 2,
			findings: ["FAIL: critical issue"],
		}, emptyCtx());

		const warnings = markEnvironment.queryMarks({ types: ["warning"] });
		expect(warnings.length).toBeGreaterThanOrEqual(1);
		expect(warnings[0].priority).toBe("high");
	});

	test("afterClonerReview — handles null verdict gracefully", async () => {
		// Should not throw
		await hooks.afterClonerReview!(1, null, emptyCtx());
		// No profile changes expected
		expect(profileRegistry.list()).toHaveLength(0);
	});

	// ── context.getAgentContext ───────────────────────────────────────

	test("context.getAgentContext — returns combined profile + mark context", async () => {
		await hooks.beforeWorkerRound!(1, ["worker-1", "worker-2"], emptyCtx());

		// Place a warning mark from w2
		markEnvironment.placeMark({
			markId: "warn-test",
			type: "warning",
			agentId: "worker-2",
			message: "Database migration conflict detected",
			priority: "high",
		});

		// Record some credit for w1
		profileRegistry.recordTaskCompleted("worker-1", true);
		profileRegistry.recordTaskCompleted("worker-1", true);

		const ctx = context.getAgentContext("worker-1");
		expect(ctx).not.toBeNull();
		expect(ctx!).toContain("<agent_profile");
		expect(ctx!).toContain("Database migration conflict");
	});

	// ── context.getSwarmCreditSummary ─────────────────────────────────

	test("context.getSwarmCreditSummary — returns ranked agents", async () => {
		await hooks.beforeWorkerRound!(1, ["worker-1", "worker-2", "worker-3"], emptyCtx());

		profileRegistry.recordTaskCompleted("worker-1", true);
		profileRegistry.recordTaskCompleted("worker-1", true);
		profileRegistry.recordTaskCompleted("worker-1", true);

		const summary = context.getSwarmCreditSummary();
		expect(summary).toContain("<swarm_credit_ranking>");
		expect(summary).toContain("worker-1");
		expect(summary).toContain("worker-2");
		expect(summary).toContain("worker-3");
	});

	// ── onHookError ───────────────────────────────────────────────────

	test("onHookError — does not throw", () => {
		expect(() =>
			hooks.onHookError!("test-hook", new Error("simulated error")),
		).not.toThrow();
	});

	// ── Disabled mode ─────────────────────────────────────────────────

	test("disabled mode — skips all profile operations", async () => {
		const disabled = createSwarmHooks({
			enabled: false,
			profileRegistry: new ProfileRegistry(),
			markEnvironment: new MarkEnvironment(),
		});

		await disabled.hooks.beforeWorkerRound!(1, ["worker-1"], emptyCtx());
		await disabled.hooks.afterWorkerRound!(1, [
			mockResult("worker-1", 0, "done"),
		], emptyCtx());

		// No profiles should be created
		expect(profileRegistry.has("worker-1")).toBe(false);
	});

	// ── beforePipeline ────────────────────────────────────────────────

	test("beforePipeline — runs without error", async () => {
		// Just ensure it doesn't throw
		await expect(hooks.beforePipeline!(emptyCtx())).resolves.toBeUndefined();
	});
});
