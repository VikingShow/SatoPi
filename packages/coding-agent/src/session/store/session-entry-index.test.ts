import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@satopi/pi-agent-core";
import type { SessionEntry, SessionTreeNode } from "../session-entries";
import { SessionEntryIndex } from "./session-entry-index";

/** Shape of the usage payload consumed by SessionEntryIndex.addUsage(). */
type UsageLike = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	orchestration?: { input: number; output: number; cacheRead: number };
	premiumRequests?: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

function messageEntry(
	id: string,
	parentId: string | null,
	role: AgentMessage["role"] = "user",
	usage?: UsageLike,
): SessionEntry {
	const message = { role, content: [], usage } as unknown as AgentMessage;
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2026-08-03T00:00:0${id.length}.000Z`,
		message,
	};
}

function labelEntry(id: string, parentId: string | null, targetId: string, label: string | undefined): SessionEntry {
	return {
		type: "label",
		id,
		parentId,
		timestamp: "2026-08-03T00:00:00.000Z",
		targetId,
		label,
	};
}

function modelChangeEntry(id: string, parentId: string | null): SessionEntry {
	return {
		type: "model_change",
		id,
		parentId,
		timestamp: "2026-08-03T00:00:00.000Z",
		model: "anthropic/claude-sonnet-4-5",
	};
}

function usage(overrides: Partial<UsageLike> = {}): UsageLike {
	return {
		input: 10,
		output: 5,
		cacheRead: 1,
		cacheWrite: 2,
		totalTokens: 18,
		orchestration: { input: 3, output: 1, cacheRead: 0 },
		premiumRequests: 1,
		cost: { input: 60, output: 30, cacheRead: 5, cacheWrite: 5, total: 100 },
		...overrides,
	};
}

describe("SessionEntryIndex", () => {
	it("inserts entries and answers id lookups", () => {
		const index = new SessionEntryIndex();
		const e1 = messageEntry("m1", null);
		const e2 = messageEntry("m2", "m1");
		index.insert(e1);
		index.insert(e2);

		expect(index.has("m1")).toBe(true);
		expect(index.has("nope")).toBe(false);
		expect(index.get("m2")).toBe(e2);
		expect(index.leafId()).toBe("m2");
		expect(index.leafEntry()).toBe(e2);
	});

	it("tracks the active leaf as entries are appended and via setLeaf", () => {
		const index = new SessionEntryIndex();
		index.insert(messageEntry("a", null));
		index.insert(messageEntry("b", "a"));
		expect(index.leafId()).toBe("b");

		index.setLeaf("a");
		expect(index.leafId()).toBe("a");
		index.setLeaf(null);
		expect(index.leafId()).toBe(null);
	});

	it("builds the parent→children adjacency", () => {
		const index = new SessionEntryIndex();
		const root = messageEntry("root", null);
		const c1 = messageEntry("c1", "root");
		const c2 = messageEntry("c2", "root");
		index.insert(root);
		index.insert(c1);
		index.insert(c2);

		expect(index.childrenOf("root")).toEqual([c1, c2]);
		expect(index.childrenOf("missing")).toEqual([]);
	});

	it("resolves labels and removes them when cleared", () => {
		const index = new SessionEntryIndex();
		const target = messageEntry("m1", null);
		index.insert(target);
		index.insert(labelEntry("l1", "m1", "m1", "reviewed"));
		expect(index.labelFor("m1")).toBe("reviewed");
		expect(index.labelsInEffect()).toEqual(new Map([["m1", "reviewed"]]).entries());

		index.insert(labelEntry("l2", "m1", "m1", undefined));
		expect(index.labelFor("m1")).toBeUndefined();
		expect([...index.labelsInEffect()]).toEqual([]);
	});

	it("sums usage from assistant messages and task tool results", () => {
		const index = new SessionEntryIndex();
		index.insert(messageEntry("u1", null, "user"));
		index.insert(messageEntry("a1", "u1", "assistant", usage()));
		index.insert(messageEntry("t1", "a1", "toolResult", undefined));

		const snapshot = index.usageSnapshot();
		expect(snapshot.input).toBe(10);
		expect(snapshot.output).toBe(5);
		expect(snapshot.cacheRead).toBe(1);
		expect(snapshot.cost).toBe(100);
		expect(snapshot.totalTokens).toBe(18);
	});

	it("rebuild resets all derived views", () => {
		const index = new SessionEntryIndex();
		index.insert(messageEntry("a", null, "assistant", usage()));
		index.insert(labelEntry("l", "a", "a", "tag"));
		expect(index.usageSnapshot().cost).toBe(100);

		index.rebuild([
			messageEntry(
				"b",
				null,
				"assistant",
				usage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 7 } }),
			),
		]);
		expect(index.usageSnapshot().cost).toBe(7);
		expect(index.has("a")).toBe(false);
		expect(index.labelFor("a")).toBeUndefined();
		expect(index.leafId()).toBe("b");
	});

	it("pathTo returns the branch from root to the requested entry", () => {
		const index = new SessionEntryIndex();
		const r = messageEntry("r", null);
		const c = messageEntry("c", "r");
		const g = messageEntry("g", "c");
		index.insert(r);
		index.insert(c);
		index.insert(g);

		const path = index.pathTo("g");
		expect(path.map(e => e.id)).toEqual(["r", "c", "g"]);

		// Defaults to the leaf.
		index.insert(messageEntry("h", "g"));
		expect(index.pathTo().map(e => e.id)).toEqual(["r", "c", "g", "h"]);
	});

	it("tree builds a timestamp-sorted hierarchy with labels", () => {
		const index = new SessionEntryIndex();
		const r = messageEntry("r", null);
		const c1 = { ...messageEntry("c1", "r"), timestamp: "2026-08-03T00:00:02.000Z" };
		const c2 = { ...messageEntry("c2", "r"), timestamp: "2026-08-03T00:00:01.000Z" };
		const model = modelChangeEntry("mc", "r");
		index.insert(r);
		index.insert(c1);
		index.insert(c2);
		index.insert(model);
		index.insert(labelEntry("l", "c1", "c1", "done"));

		const tree = index.tree([r, c1, c2, model]);
		expect(tree).toHaveLength(1);
		const root = tree[0] as SessionTreeNode;
		expect(root.entry.id).toBe("r");

		// Children sorted by timestamp ascending: mc (t00) < c2 (t01) < c1 (t02).
		const childIds = root.children.map(n => n.entry.id);
		expect(childIds).toEqual(["mc", "c2", "c1"]);

		// Label resolved onto the node.
		const c1Node = root.children.find(n => n.entry.id === "c1");
		expect(c1Node?.label).toBe("done");
	});

	it("clear empties every view", () => {
		const index = new SessionEntryIndex();
		index.insert(messageEntry("a", null, "assistant", usage()));
		index.clear();

		expect(index.has("a")).toBe(false);
		expect(index.leafId()).toBe(null);
		expect(index.usageSnapshot().input).toBe(0);
		expect(index.childrenOf("a")).toEqual([]);
	});
});
