/**
 * Persisted-agent scan contracts (agent-hub.ts Phase 1 shared layer):
 * collectPersistedAgents / summarizePersistedAgents / registerPersistedSubagents.
 *
 * Disk layout under test:
 *   <sessionDir>.jsonl                ← session file (path only, not walked)
 *   <sessionDir>/<agentId>.jsonl      ← direct subagent
 *   <sessionDir>/<agentId>/<nested>.jsonl ← nested subagents
 *   <sessionDir>/swarm-<name>/agents/<id>.jsonl ← swarm agents (walked)
 *   <sessionDir>/swarm-<name>/crews/<id>.jsonl  ← crew transcripts (NOT walked)
 *   <sessionDir>/__advisor.jsonl      ← advisor transcripts (collected, kind advisor)
 *   *.jsonl.bak                       ← skipped
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	collectPersistedAgents,
	registerPersistedSubagents,
	summarizePersistedAgents,
} from "@satopi/pi-coding-agent/modes/components/agent-hub";
import { AgentRegistry, MAIN_AGENT_ID } from "@satopi/pi-coding-agent/registry/agent-registry";
import { TempDir } from "@satopi/pi-utils";

describe("collectPersistedAgents", () => {
	let dir: TempDir;

	afterEach(() => {
		dir?.removeSync();
	});

	async function makeFixture(): Promise<string> {
		dir = TempDir.createSync("@pi-persisted-agents-");
		const sessionDir = path.join(dir.path(), "session");
		const mkdir = (p: string) => fs.mkdir(path.join(sessionDir, p), { recursive: true });
		await Promise.all([mkdir("a"), mkdir("swarm-x/agents"), mkdir("swarm-x/crews")]);
		await Bun.write(path.join(sessionDir, "a.jsonl"), "{}");
		await Bun.write(path.join(sessionDir, "a", "b.jsonl"), "{}");
		await Bun.write(path.join(sessionDir, "swarm-x", "agents", "s1.jsonl"), "{}");
		await Bun.write(path.join(sessionDir, "swarm-x", "crews", "c1.jsonl"), "{}");
		await Bun.write(path.join(sessionDir, "__advisor.jsonl"), "{}");
		await Bun.write(path.join(sessionDir, "a", "__advisor.jsonl"), "{}");
		await Bun.write(path.join(sessionDir, "skip.jsonl.bak"), "{}");
		// sessionFile itself (the sibling .jsonl) need not exist — only its dir is walked
		return path.join(dir.path(), "session.jsonl");
	}

	it("collects direct, nested, and swarm agents with correct parents; skips crews, advisors-in-count, and .bak", async () => {
		const sessionFile = await makeFixture();
		const agents = await collectPersistedAgents(sessionFile);

		const byId = new Map(agents.map(a => [a.id, a]));
		expect(agents).toHaveLength(5);
		expect(byId.get("a")).toMatchObject({ kind: "sub", parentId: MAIN_AGENT_ID });
		expect(byId.get("b")).toMatchObject({ kind: "sub", parentId: "a" });
		expect(byId.get("s1")).toMatchObject({ kind: "sub", parentId: MAIN_AGENT_ID });
		expect(byId.get(`${MAIN_AGENT_ID}/advisor`)).toMatchObject({ kind: "advisor", parentId: MAIN_AGENT_ID });
		expect(byId.get("a/advisor")).toMatchObject({ kind: "advisor", parentId: "a" });
		expect(byId.has("c1")).toBe(false);
		expect(byId.has("skip")).toBe(false);
		expect(byId.get("a")?.sessionFile.endsWith(path.join("session", "a.jsonl"))).toBe(true);
	});

	it("returns [] for a missing or non-jsonl session file", async () => {
		expect(await collectPersistedAgents(null)).toEqual([]);
		expect(await collectPersistedAgents("/nonexistent/session.jsonl")).toEqual([]);
		expect(await collectPersistedAgents("/some/session.txt")).toEqual([]);
	});
});

describe("summarizePersistedAgents", () => {
	let dir: TempDir;

	afterEach(() => {
		dir?.removeSync();
	});

	it("counts subagents only and reports the newest mtime", async () => {
		dir = TempDir.createSync("@pi-persisted-summary-");
		const sessionDir = path.join(dir.path(), "session");
		await fs.mkdir(sessionDir, { recursive: true });
		await Bun.write(path.join(sessionDir, "a.jsonl"), "{}");
		await Bun.write(path.join(sessionDir, "b.jsonl"), "{}");
		await Bun.write(path.join(sessionDir, "__advisor.jsonl"), "{}");
		await Bun.write(path.join(sessionDir, "stale.jsonl.bak"), "{}");
		const old = path.join(sessionDir, "a.jsonl");
		const fresh = path.join(sessionDir, "b.jsonl");
		const past = Date.now() - 60_000;
		await fs.utimes(old, new Date(past), new Date(past));

		const summary = await summarizePersistedAgents(path.join(dir.path(), "session.jsonl"));

		expect(summary.count).toBe(2);
		const freshStat = await fs.stat(fresh);
		expect(Math.abs(summary.latestMtime - freshStat.mtimeMs)).toBeLessThan(2_000);
	});
});

describe("registerPersistedSubagents", () => {
	let dir: TempDir;

	afterEach(() => {
		dir?.removeSync();
	});

	it("registers parked refs idempotently and never clobbers a same-id live ref", async () => {
		dir = TempDir.createSync("@pi-persisted-register-");
		const sessionDir = path.join(dir.path(), "session");
		await fs.mkdir(path.join(sessionDir, "a"), { recursive: true });
		await Bun.write(path.join(sessionDir, "a.jsonl"), "{}");
		await Bun.write(path.join(sessionDir, "__advisor.jsonl"), "{}");
		const sessionFile = path.join(dir.path(), "session.jsonl");

		const registry = new AgentRegistry();
		// Pre-existing live ref named exactly like an advisor id: must not be clobbered.
		registry.register({
			id: `${MAIN_AGENT_ID}/advisor`,
			displayName: "not-an-advisor",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: "/elsewhere.jsonl",
			status: "running",
		});

		await registerPersistedSubagents(registry, sessionFile);
		await registerPersistedSubagents(registry, sessionFile);

		const sub = registry.get("a");
		expect(sub).toMatchObject({ kind: "sub", status: "parked", session: null });
		expect(sub?.sessionFile?.endsWith(path.join("session", "a.jsonl"))).toBe(true);
		// Same-id live ref untouched; no advisor dupes.
		expect(registry.get(`${MAIN_AGENT_ID}/advisor`)?.kind).toBe("sub");
		expect(registry.list().filter(r => r.kind === "advisor")).toHaveLength(0);
		// Exactly one "a" ref after two registration passes.
		expect(registry.list().filter(r => r.id === "a")).toHaveLength(1);
	});
});
