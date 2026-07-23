/**
 * mark-environment.test.ts — MarkEnvironment 单元测试
 *
 * 覆盖：
 * 1. Mark 放置与查询（所有 5 种类型）
 * 2. 索引加速查询（by agent, by path）
 * 3. 惰性衰减（过期 Marks 自动清理）
 * 4. Agent 可见性过滤（自身 Marks 不返回）
 * 5. 路径锁查询
 * 6. 上下文注入格式
 * 7. forceRemove 权限检查
 * 8. acknowledge 幂等性
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { MarkEnvironment } from "../mark-environment";

describe("MarkEnvironment", () => {
	let env: MarkEnvironment;

	beforeEach(() => {
		env = new MarkEnvironment();
	});

	// ── Place + Query ─────────────────────────────────────────────────

	test("placeMark — creates a mark and returns it", () => {
		const mark = env.placeMark({
			markId: "lock-1",
			type: "lock",
			agentId: "worker-1",
			path: "/src/app.ts",
			message: "Working on auth module",
			priority: "high",
		});

		expect(mark.markId).toBe("lock-1");
		expect(mark.type).toBe("lock");
		expect(mark.agentId).toBe("worker-1");
		expect(mark.path).toBe("/src/app.ts");
	});

	test("placeMark — throws on duplicate markId", () => {
		env.placeMark({ markId: "m1", type: "signal", agentId: "w1", message: "hello" });
		expect(() =>
			env.placeMark({ markId: "m1", type: "signal", agentId: "w2", message: "world" }),
		).toThrow('Mark "m1" already exists');
	});

	test("queryMarks — returns all marks when no filters", () => {
		env.placeMark({ markId: "a", type: "signal", agentId: "w1", message: "a" });
		env.placeMark({ markId: "b", type: "lock", agentId: "w1", path: "/x.ts", message: "b" });
		expect(env.queryMarks()).toHaveLength(2);
	});

	test("queryMarks — filters by type", () => {
		env.placeMark({ markId: "a", type: "signal", agentId: "w1", message: "a" });
		env.placeMark({ markId: "b", type: "lock", agentId: "w1", path: "/x.ts", message: "b" });

		const signals = env.queryMarks({ types: ["signal"] });
		expect(signals).toHaveLength(1);
		expect(signals[0].type).toBe("signal");
	});

	test("queryMarks — filters by agentId", () => {
		env.placeMark({ markId: "a", type: "signal", agentId: "w1", message: "a" });
		env.placeMark({ markId: "b", type: "signal", agentId: "w2", message: "b" });

		const w1Marks = env.queryMarks({ agentId: "w1" });
		expect(w1Marks).toHaveLength(1);
		expect(w1Marks[0].agentId).toBe("w1");
	});

	test("queryMarks — filters by minPriority", () => {
		env.placeMark({ markId: "a", type: "signal", agentId: "w1", message: "low", priority: "low" });
		env.placeMark({ markId: "b", type: "warning", agentId: "w1", message: "critical!", priority: "critical" });

		const high = env.queryMarks({ minPriority: "high" });
		expect(high).toHaveLength(1);
		expect(high[0].priority).toBe("critical");
	});

	test("queryMarks — filters by tags", () => {
		env.placeMark({ markId: "a", type: "signal", agentId: "w1", message: "a", tags: ["round-1", "urgent"] });
		env.placeMark({ markId: "b", type: "signal", agentId: "w1", message: "b", tags: ["round-2"] });

		const tagged = env.queryMarks({ tags: ["urgent"] });
		expect(tagged).toHaveLength(1);
		expect(tagged[0].markId).toBe("a");
	});

	test("queryMarks — respects limit", () => {
		for (let i = 0; i < 5; i++) {
			env.placeMark({ markId: `m${i}`, type: "signal", agentId: "w1", message: `msg${i}` });
		}
		expect(env.queryMarks({ limit: 2 })).toHaveLength(2);
	});

	// ── Decay ─────────────────────────────────────────────────────────

	test("expired marks are removed on query (lazy decay)", async () => {
		env.placeMark({
			markId: "ephemeral",
			type: "signal",
			agentId: "w1",
			message: "will expire",
			ttlMs: 5, // 5ms TTL
		});

		// Wait for mark to expire
		await Bun.sleep(10);

		const marks = env.queryMarks();
		expect(marks).toHaveLength(0); // auto-cleaned
	});

	test("non-expired marks survive decay", () => {
		env.placeMark({
			markId: "persistent",
			type: "signal",
			agentId: "w1",
			message: "stays",
			ttlMs: 3600000, // 1 hour
		});

		expect(env.queryMarks()).toHaveLength(1);
	});

	// ── Agent visibility ──────────────────────────────────────────────

	test("getActiveMarksFor — excludes self marks", () => {
		env.placeMark({ markId: "self", type: "signal", agentId: "w1", message: "mine" });
		env.placeMark({ markId: "other", type: "signal", agentId: "w2", message: "theirs" });

		const forW1 = env.getActiveMarksFor("w1");
		expect(forW1).toHaveLength(1);
		expect(forW1[0].agentId).toBe("w2");
	});

	test("getActiveMarksFor — filters by minPriority", () => {
		env.placeMark({ markId: "low", type: "signal", agentId: "w2", message: "low", priority: "low" });
		env.placeMark({ markId: "high", type: "warning", agentId: "w2", message: "high", priority: "high" });

		const forW1 = env.getActiveMarksFor("w1", { minPriority: "high" });
		expect(forW1).toHaveLength(1);
		expect(forW1[0].markId).toBe("high");
	});

	// ── Path locks ────────────────────────────────────────────────────

	test("getPathLocks — returns lock/claim marks on a path", () => {
		env.placeMark({ markId: "l1", type: "lock", agentId: "w1", path: "/src/a.ts", message: "locked" });
		env.placeMark({ markId: "c1", type: "claim", agentId: "w2", path: "/src/a.ts", message: "claiming" });
		env.placeMark({ markId: "s1", type: "signal", agentId: "w3", path: "/src/a.ts", message: "signal" });

		const locks = env.getPathLocks("/src/a.ts");
		expect(locks).toHaveLength(2); // lock + claim only
	});

	test("getPathLocks — excludes specified agent", () => {
		env.placeMark({ markId: "l1", type: "lock", agentId: "w1", path: "/src/a.ts", message: "locked" });

		const locks = env.getPathLocks("/src/a.ts", "w1");
		expect(locks).toHaveLength(0);
	});

	test("isPathLocked — true when another agent has a lock", () => {
		env.placeMark({ markId: "l1", type: "lock", agentId: "w2", path: "/src/a.ts", message: "locked" });
		expect(env.isPathLocked("/src/a.ts", "w1")).toBe(true);
	});

	// ── forceRemove ───────────────────────────────────────────────────

	test("forceRemove — only owner can remove own mark", () => {
		env.placeMark({ markId: "m1", type: "signal", agentId: "w1", message: "mine" });

		expect(env.forceRemove("m1", "w2")).toBe(false); // wrong owner
		expect(env.forceRemove("m1", "w1")).toBe(true);  // correct owner
		expect(env.queryMarks()).toHaveLength(0);
	});

	// ── Acknowledge ───────────────────────────────────────────────────

	test("acknowledge — marks agent as aware of the mark", () => {
		const m = env.placeMark({ markId: "m1", type: "signal", agentId: "w1", message: "hello" });
		expect(m.acknowledged.size).toBe(0);

		env.acknowledge("m1", "w2");
		expect(m.acknowledged.has("w2")).toBe(true);
	});

	test("acknowledge — idempotent", () => {
		env.placeMark({ markId: "m1", type: "signal", agentId: "w1", message: "hello" });
		env.acknowledge("m1", "w2");
		env.acknowledge("m1", "w2"); // repeat
		expect(env.queryMarks()[0].acknowledged.size).toBe(1);
	});

	// ── Context injection ─────────────────────────────────────────────

	test("getContextForAgent — returns formatted XML with active marks", () => {
		env.placeMark({ markId: "warn", type: "warning", agentId: "w2", message: "Broken test!", priority: "high" });
		env.placeMark({ markId: "lock", type: "lock", agentId: "w2", path: "/src/db.ts", message: "Refactoring DB", priority: "medium" });
		env.placeMark({ markId: "sig", type: "signal", agentId: "w2", message: "I'm done with auth", priority: "medium" });

		const ctx = env.getContextForAgent("w1");
		expect(ctx).toContain("<stigmergic_environment>");
		expect(ctx).toContain("Broken test!");
		expect(ctx).toContain("Refactoring DB");
	});

	test("getContextForAgent — returns empty string when no marks", () => {
		expect(env.getContextForAgent("w1")).toBe("");
	});

	// ── Summary ───────────────────────────────────────────────────────

	test("getSummary — returns accurate counts", () => {
		env.placeMark({ markId: "a", type: "signal", agentId: "w1", message: "a" });
		env.placeMark({ markId: "b", type: "lock", agentId: "w1", path: "/x", message: "b" });
		env.placeMark({ markId: "c", type: "lock", agentId: "w2", path: "/y", message: "c" });

		const summary = env.getSummary();
		expect(summary.total).toBe(3);
		expect(summary.byType.signal).toBe(1);
		expect(summary.byType.lock).toBe(2);
	});

	// ── clear (for tests) ─────────────────────────────────────────────

	test("clear — removes all marks", () => {
		env.placeMark({ markId: "a", type: "signal", agentId: "w1", message: "a" });
		env.placeMark({ markId: "b", type: "lock", agentId: "w1", path: "/x", message: "b" });
		env.clear();
		expect(env.queryMarks()).toHaveLength(0);
		expect(env.getSummary().total).toBe(0);
	});

	// ── Serialization ─────────────────────────────────────────────────

	test("serialize → deserialize restores marks correctly", () => {
		env.placeMark({ markId: "m1", type: "lock", agentId: "w1", path: "/src/a.ts", message: "a", priority: "high", tags: ["urgent"] });
		env.placeMark({ markId: "m2", type: "warning", agentId: "w2", message: "watch out", priority: "critical" });
		env.acknowledge("m1", "w3");
		env.acknowledge("m2", "w1");

		const snapshot = env.serialize();
		expect(snapshot.marks).toHaveLength(2);

		const env2 = new MarkEnvironment();
		env2.deserialize(snapshot);
		expect(env2.queryMarks()).toHaveLength(2);
		expect(env2.getSummary().total).toBe(2);

		const locks = env2.getPathLocks("/src/a.ts");
		expect(locks).toHaveLength(1);
		expect(locks[0].markId).toBe("m1");
		expect(locks[0].acknowledged.has("w3")).toBe(true);
	});

	test("serialize → deserialize skips expired marks", async () => {
		env.placeMark({ markId: "alive", type: "signal", agentId: "w1", message: "alive", ttlMs: 60000 });
		env.placeMark({ markId: "dead", type: "signal", agentId: "w2", message: "dead", ttlMs: 5 });

		await Bun.sleep(10);
		const snapshot = env.serialize();

		const env2 = new MarkEnvironment();
		env2.deserialize(snapshot);
		expect(env2.queryMarks()).toHaveLength(1);
		expect(env2.queryMarks()[0].markId).toBe("alive");
	});
});
