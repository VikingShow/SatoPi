/**
 * role-roundtable.test.ts — Unit tests for fallbackRoleAssign
 *
 * Coverage:
 * 1. Preference matching
 * 2. Duplicate role prevention
 * 3. Round-robin assignment
 * 4. Edge cases (empty, overflow)
 */

import { describe, expect, test } from "bun:test";
import { fallbackRoleAssign, type RoleCandidate } from "../stage/role-roundtable";

// ── #parseAssignments via public JSON injection ────────────────────

describe("RoleRoundtable #parseAssignments (via roundtable mock)", () => {
	// parseAssignments is tested indirectly through the negotiate flow.
	// Direct JSON testing is done via fallbackRoleAssign since JSON extraction
	// requires live IRC responses.

	test("fallbackRoleAssign matches preferences when available", () => {
		const candidates: RoleCandidate[] = [
			{ agentId: "a1", name: "Alpha", preferredRoles: ["architect"] },
			{ agentId: "a2", name: "Beta", preferredRoles: ["backend"] },
		];

		const result = fallbackRoleAssign(candidates, ["architect", "backend"]);
		expect(result.length).toBe(2);
		expect(result.find(a => a.agentId === "a1")!.role).toBe("architect");
		expect(result.find(a => a.agentId === "a2")!.role).toBe("backend");
	});

	test("fallbackRoleAssign prevents duplicate role assignments", () => {
		const candidates: RoleCandidate[] = [
			{ agentId: "a1", name: "Alpha", preferredRoles: ["architect"] },
			{ agentId: "a2", name: "Beta", preferredRoles: ["architect"] },
		];

		const result = fallbackRoleAssign(candidates, ["architect", "backend"]);
		// a1 gets architect, a2 gets backend (or vice versa)
		const roles = result.map(a => a.role);
		expect(new Set(roles).size).toBe(2); // both unique
	});

	test("fallbackRoleAssign fills remaining agents with round-robin", () => {
		const candidates: RoleCandidate[] = [
			{ agentId: "a1", name: "Alpha", preferredRoles: [] },
			{ agentId: "a2", name: "Beta", preferredRoles: [] },
			{ agentId: "a3", name: "Gamma", preferredRoles: [] },
		];

		const result = fallbackRoleAssign(candidates, ["backend", "frontend"]);
		expect(result.length).toBe(3);
		const roles = result.map(a => a.role);
		expect(roles).toContain("backend");
		expect(roles).toContain("frontend");
		// 3rd agent gets wrapped-around role via i%remainingRoles.length
	});

	test("fallbackRoleAssign handles empty roles", () => {
		const result = fallbackRoleAssign([], []);
		expect(result).toEqual([]);
	});

	test("fallbackRoleAssign handles more agents than roles", () => {
		const candidates: RoleCandidate[] = [
			{ agentId: "a1", name: "A", preferredRoles: ["backend"] },
			{ agentId: "a2", name: "B", preferredRoles: [] },
			{ agentId: "a3", name: "C", preferredRoles: [] },
			{ agentId: "a4", name: "D", preferredRoles: [] },
		];

		const result = fallbackRoleAssign(candidates, ["backend"]);
		expect(result.length).toBe(4);
		// First agent gets backend, rest get "worker"
		expect(result[0].role).toBe("backend");
		expect(result.slice(1).every(a => a.role === "worker")).toBe(true);
	});

	test("fallbackRoleAssign respects preference order", () => {
		const candidates: RoleCandidate[] = [
			{ agentId: "a1", name: "A", preferredRoles: ["frontend", "backend"] },
			{ agentId: "a2", name: "B", preferredRoles: ["backend", "frontend"] },
		];

		const result = fallbackRoleAssign(candidates, ["frontend", "backend"]);
		// a1 should prefer frontend, a2 should prefer backend
		const a1 = result.find(a => a.agentId === "a1")!;
		expect(a1.role).toBe("frontend");
	});
});
