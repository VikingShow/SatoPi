/**
 * agent-profile.test.ts — AgentProfile + ProfileRegistry 单元测试
 *
 * 覆盖：
 * 1. Profile 创建与幂等性
 * 2. 信用分变更（praise/criticism/success/violation）
 * 3. 违规审计链不可逆性
 * 4. Prompt 上下文注入
 * 5. 信用排名摘要
 * 6. 信用分边界（不超 [1, 100]）
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { ProfileRegistry } from "../agent/agent-profile";

describe("ProfileRegistry", () => {
	let registry: ProfileRegistry;

	beforeEach(() => {
		registry = new ProfileRegistry();
	});

	// ── Create ───────────────────────────────────────────────────────

	test("createProfile — creates a new AgentProfile with default credit=50", () => {
		const p = registry.createProfile({
			profileId: "worker-architect",
			name: "Architect Alpha",
			archetype: "architect",
			domains: ["typescript", "backend"],
		});

		expect(p.profileId).toBe("worker-architect");
		expect(p.identity.archetype).toBe("architect");
		expect(p.credit.score).toBe(50);
		expect(p.credit.violationCount).toBe(0);
		expect(p.credit.violationHistory).toEqual([]);
		expect(p.expertise.domains).toEqual(["typescript", "backend"]);
	});

	test("createProfile — throws on duplicate profileId", () => {
		registry.createProfile({ profileId: "dup", name: "A", archetype: "worker" });
		expect(() =>
			registry.createProfile({ profileId: "dup", name: "B", archetype: "worker" }),
		).toThrow('Profile "dup" already exists');
	});

	test("getOrCreate — returns existing profile", () => {
		const a = registry.getOrCreate({ profileId: "w1", name: "W1", archetype: "worker" });
		const b = registry.getOrCreate({ profileId: "w1", name: "W1", archetype: "worker" });
		expect(a).toBe(b);
	});

	test("getOrCreate — creates new if absent", () => {
		const p = registry.getOrCreate({ profileId: "w2", name: "W2", archetype: "worker" });
		expect(p).toBeDefined();
		expect(p.profileId).toBe("w2");
	});

	// ── Credit — success / praise / criticism ─────────────────────────

	test("recordTaskCompleted — success increases credit score", () => {
		const p = registry.createProfile({ profileId: "w1", name: "W1", archetype: "worker" });
		const updated = registry.recordTaskCompleted("w1", true);
		expect(updated!.credit.score).toBe(53); // 50 + 3
		expect(updated!.credit.successRate).toBe(1);
		expect(updated!.credit.totalTasks).toBe(1);
	});

	test("recordTaskCompleted — failure keeps score unchanged", () => {
		const p = registry.createProfile({ profileId: "w1", name: "W1", archetype: "worker" });
		const updated = registry.recordTaskCompleted("w1", false);
		expect(updated!.credit.score).toBe(50); // unchanged
		expect(updated!.credit.successRate).toBe(0);
	});

	test("recordReviewFeedback — praise increases, criticism decreases", () => {
		registry.createProfile({ profileId: "w1", name: "A", archetype: "worker" });
		registry.createProfile({ profileId: "w2", name: "B", archetype: "worker" });

		registry.recordReviewFeedback(["w1", "w2"], ["w1"], ["w2"]);

		const w1 = registry.get("w1")!;
		const w2 = registry.get("w2")!;
		expect(w1.credit.score).toBe(55); // 50 + 5
		expect(w1.credit.praiseCount).toBe(1);
		expect(w2.credit.score).toBe(45); // 50 - 5
		expect(w2.credit.criticismCount).toBe(1);
	});

	test("recordReviewFeedback — only updates mentioned worker IDs", () => {
		registry.createProfile({ profileId: "w1", name: "A", archetype: "worker" });
		registry.recordReviewFeedback(["w1"], [], []);
		expect(registry.get("w1")!.credit.score).toBe(50); // unchanged
	});

	// ── Credit — violations (不可逆) ──────────────────────────────────

	test("recordViolation — minor decreases credit by 5", () => {
		registry.createProfile({ profileId: "w1", name: "W1", archetype: "worker" });
		const updated = registry.recordViolation("w1", {
			type: "test_not_run",
			severity: "minor",
			description: "forgot to run tests",
			iteration: 1,
		});
		expect(updated!.credit.score).toBe(45); // 50 - 5
		expect(updated!.credit.violationCount).toBe(1);
		expect(updated!.credit.violationHistory).toHaveLength(1);
	});

	test("recordViolation — major decreases credit by 20", () => {
		registry.createProfile({ profileId: "w1", name: "W1", archetype: "worker" });
		const updated = registry.recordViolation("w1", {
			type: "wrong_output",
			severity: "major",
			description: "produced incorrect API contract",
			iteration: 2,
		});
		expect(updated!.credit.score).toBe(30); // 50 - 20
	});

	test("recordViolation — critical decreases credit by 50", () => {
		registry.createProfile({ profileId: "w1", name: "W1", archetype: "worker" });
		const updated = registry.recordViolation("w1", {
			type: "overwrite_others_work",
			severity: "critical",
			description: "overwrote peer's locked file",
			iteration: 3,
		});
		expect(updated!.credit.score).toBe(1); // 50 - 50, clamped to min 1
	});

	test("recordViolation — audit trail preserves all violations", () => {
		registry.createProfile({ profileId: "w1", name: "W1", archetype: "worker" });
		registry.recordViolation("w1", { type: "a", severity: "minor", description: "1", iteration: 1 });
		registry.recordViolation("w1", { type: "b", severity: "major", description: "2", iteration: 2 });
		registry.recordViolation("w1", { type: "c", severity: "critical", description: "3", iteration: 3 });

		const p = registry.get("w1")!;
		expect(p.credit.violationHistory).toHaveLength(3);
		expect(p.credit.violationCount).toBe(3);
	});

	// ── Credit limits ─────────────────────────────────────────────────

	test("credit score clamped to [1, 100] — cannot go below 1", () => {
		registry.createProfile({ profileId: "w1", name: "W1", archetype: "worker" });
		// Apply 2 consecutive critical violations
		registry.recordViolation("w1", { type: "a", severity: "critical", description: "!", iteration: 1 });
		registry.recordViolation("w1", { type: "b", severity: "critical", description: "!", iteration: 2 });
		expect(registry.get("w1")!.credit.score).toBe(1); // floor
	});

	test("credit score clamped to [1, 100] — cannot exceed 100", () => {
		registry.createProfile({ profileId: "w1", name: "W1", archetype: "worker" });
		// Apply many successes
		for (let i = 0; i < 30; i++) registry.recordTaskCompleted("w1", true);
		expect(registry.get("w1")!.credit.score).toBeLessThanOrEqual(100);
	});

	// ── Social graph ──────────────────────────────────────────────────

	test("recordCollaboration — updates mutual collaborators", () => {
		registry.createProfile({ profileId: "w1", name: "A", archetype: "worker" });
		registry.createProfile({ profileId: "w2", name: "B", archetype: "worker" });

		registry.recordCollaboration(["w1", "w2"]);

		expect(registry.get("w1")!.social.collaborators).toContain("w2");
		expect(registry.get("w2")!.social.collaborators).toContain("w1");
		expect(registry.get("w1")!.social.collaborationCount).toBe(1);
	});

	test("recordCitation — adds citer to cited's citedBy", () => {
		registry.createProfile({ profileId: "w2", name: "B", archetype: "worker" });
		registry.recordCitation("w2", "w1");
		expect(registry.get("w2")!.social.citedBy).toContain("w1");
	});

	// ── Prompt context injection ──────────────────────────────────────

	test("getPromptContext — returns XML block with profile data", () => {
		registry.createProfile({
			profileId: "w1", name: "Alice",
			archetype: "implementer",
			domains: ["typescript", "react"],
			specialties: ["refactoring"],
		});
		registry.recordTaskCompleted("w1", true);

		const ctx = registry.getPromptContext("w1");
		expect(ctx).not.toBeNull();
		expect(ctx!).toContain("<agent_profile");
		expect(ctx!).toContain('id="w1"');
		expect(ctx!).toContain("archetype=\"implementer\"");
		expect(ctx!).toContain("domains: typescript, react");
	});

	test("getPromptContext — shows warning for low credit", () => {
		registry.createProfile({ profileId: "w1", name: "Bad", archetype: "worker" });
		registry.recordViolation("w1", { type: "a", severity: "major", description: "bad", iteration: 1 });
		registry.recordViolation("w1", { type: "b", severity: "major", description: "bad", iteration: 2 });
		// score = 50 - 40 = 10

		const ctx = registry.getPromptContext("w1")!;
		expect(ctx).toContain("LOW CREDIT");
	});

	test("getPromptContext — shows restricted for 3+ violations", () => {
		registry.createProfile({ profileId: "w1", name: "Bad", archetype: "worker" });
		registry.recordViolation("w1", { type: "a", severity: "minor", description: "1", iteration: 1 });
		registry.recordViolation("w1", { type: "b", severity: "minor", description: "2", iteration: 2 });
		registry.recordViolation("w1", { type: "c", severity: "minor", description: "3", iteration: 3 });

		const ctx = registry.getPromptContext("w1")!;
		expect(ctx).toContain("RESTRICTED");
	});

	test("getPromptContext — returns null for unknown profile", () => {
		expect(registry.getPromptContext("unknown")).toBeNull();
	});

	// ── Credit ranking ────────────────────────────────────────────────

	test("getSwarmCreditSummary — returns ranked score list", () => {
		registry.createProfile({ profileId: "w1", name: "High", archetype: "worker" });
		registry.createProfile({ profileId: "w2", name: "Mid", archetype: "worker" });
		registry.createProfile({ profileId: "w3", name: "Low", archetype: "debugger" });

		registry.recordReviewFeedback(["w1", "w2", "w3"], ["w1"], ["w3"]); // w1: +5, w3: -5
		registry.recordTaskCompleted("w1", true); // +3

		const summary = registry.getSwarmCreditSummary(["w1", "w2", "w3"]);
		expect(summary).toContain("<swarm_credit_ranking>");
		expect(summary).toContain("w1"); // highest score
		expect(summary).toContain("w3"); // lowest
	});

	// ── Expertise ─────────────────────────────────────────────────────

	test("updateProficiency — adds domain and updates proficiency", () => {
		registry.createProfile({ profileId: "w1", name: "W1", archetype: "worker" });
		registry.updateProficiency("w1", "rust", 0.75);
		const p = registry.get("w1")!;
		expect(p.expertise.proficiency["rust"]).toBe(0.75);
		expect(p.expertise.domains).toContain("rust");
	});

	// ── Version tracking ──────────────────────────────────────────────

	test("getVersion — increments on credit mutations", () => {
		registry.createProfile({ profileId: "w1", name: "W1", archetype: "worker" });
		expect(registry.getVersion("w1")).toBe(1);
		registry.recordTaskCompleted("w1", true);
		expect(registry.getVersion("w1")).toBe(2);
	});

	// ── list / has ────────────────────────────────────────────────────

	test("list — returns all profiles", () => {
		registry.createProfile({ profileId: "a", name: "A", archetype: "worker" });
		registry.createProfile({ profileId: "b", name: "B", archetype: "reviewer" });
		expect(registry.list()).toHaveLength(2);
	});

	test("has — checks existence", () => {
		registry.createProfile({ profileId: "x", name: "X", archetype: "worker" });
		expect(registry.has("x")).toBe(true);
		expect(registry.has("y")).toBe(false);
	});

	test("listLowCredit — returns profiles below threshold", () => {
		registry.createProfile({ profileId: "good", name: "G", archetype: "worker" });
		registry.createProfile({ profileId: "bad", name: "B", archetype: "worker" });
		registry.recordViolation("bad", { type: "x", severity: "critical", description: "!", iteration: 1 });
		// bad score = 1

		const low = registry.listLowCredit(30);
		expect(low).toHaveLength(1);
		expect(low[0].profileId).toBe("bad");
	});
});
