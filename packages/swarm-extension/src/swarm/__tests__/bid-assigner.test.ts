import { describe, expect, it } from "bun:test";
import { BidAssigner } from "../bid-assigner";
import type { KnightCapability, TaskItem } from "../bid-assigner";

describe("BidAssigner", () => {
	const knights: KnightCapability[] = [
		{ id: "lancelot", capabilities: ["architecture", "coding", "patterns"], confidence: 0.9 },
		{ id: "gawain", capabilities: ["testing", "ci-cd", "reliability"], confidence: 0.85 },
		{ id: "galahad", capabilities: ["security", "compliance", "audit"], confidence: 0.95 },
		{ id: "bors", capabilities: ["database", "infrastructure", "storage"], confidence: 0.8 },
	];

	it("assigns tasks by best match", () => {
		const tasks: TaskItem[] = [
			{ id: "t1", description: "Design API schema", tags: ["architecture", "coding"], priority: 1 },
			{ id: "t2", description: "Write tests", tags: ["testing"], priority: 2 },
			{ id: "t3", description: "Security audit", tags: ["security"], priority: 1 },
		];

		const assigner = new BidAssigner();
		const result = assigner.assign(knights, tasks);

		expect(result.assignments.length).toBe(3);
		expect(result.orphanedTasks.length).toBe(0);

		// t1 should go to lancelot (architecture+coding match)
		const t1 = result.assignments.find((a) => a.taskId === "t1");
		expect(t1?.knightId).toBe("lancelot");

		// t3 should go to galahad (security match)
		const t3 = result.assignments.find((a) => a.taskId === "t3");
		expect(t3?.knightId).toBe("galahad");
	});

	it("orphans tasks when no knight matches", () => {
		const tasks: TaskItem[] = [
			{ id: "t1", description: "Quantum computing", tags: ["quantum", "physics"], priority: 1 },
		];

		const assigner = new BidAssigner();
		const result = assigner.assign(knights, tasks);

		expect(result.assignments.length).toBe(0);
		expect(result.orphanedTasks.length).toBe(1);
		expect(result.orphanedTasks[0].id).toBe("t1");
	});

	it("handles more tasks than knights (priority-based)", () => {
		const tasks: TaskItem[] = [
			{ id: "t1", description: "Top priority", tags: ["architecture"], priority: 1 },
			{ id: "t2", description: "Also top priority", tags: ["security"], priority: 1 },
			{ id: "t3", description: "Lower priority", tags: ["architecture"], priority: 3 },
			{ id: "t4", description: "Another", tags: ["testing"], priority: 2 },
			{ id: "t5", description: "Last", tags: ["database"], priority: 2 },
		];

		const assigner = new BidAssigner();
		const result = assigner.assign(knights, tasks);

		expect(result.assignments.length).toBe(4);
		expect(result.orphanedTasks.length).toBe(1);
		expect(result.unassignedKnights.length).toBe(0);
	});

	it("computes emergence report", () => {
		const tasks: TaskItem[] = [
			{ id: "t1", description: "Design API", tags: ["architecture", "coding"], priority: 1 },
			{ id: "t2", description: "Write tests", tags: ["testing"], priority: 2 },
			{ id: "t3", description: "Security audit", tags: ["security"], priority: 1 },
			{ id: "t4", description: "DB migration", tags: ["database"], priority: 2 },
		];

		const assigner = new BidAssigner();
		const result = assigner.assign(knights, tasks);
		const report = assigner.observeEmergence(result, knights, tasks);

		expect(report.loadBalanceVariance).toBeGreaterThanOrEqual(0);
		expect(report.orphanedTasks).toEqual([]);
		expect(typeof report.crossCapabilityTasks).toBe("object");
	});
});
