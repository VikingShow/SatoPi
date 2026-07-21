import { describe, expect, it } from "bun:test";
import { parseSwarmYaml, resolveLoopConfig, validateSwarmDefinition } from "../schema";
import type { AgentToolRestriction } from "../schema";

// parseAgentRestrictions is not exported, but resolveLoopConfig internally calls it.
// We test write_allowlist parsing by providing it in the raw YAML config passed to
// parseSwarmYaml and then inspecting the resolved loop config.

describe("schema - loop mode", () => {
	it("parses a loop mode swarm YAML", () => {
		const yaml = `
swarm:
  name: test-loop
  workspace: /tmp/test
  mode: loop
  max_iterations: 3
  review_gate: atropos_veto
  auto_retry: true
  human_escalation: true
  roundtable:
    propose_timeout: 30000
    debate_timeout: 60000
    vote_timeout: 15000
  reviewers:
    core:
      - clotho
      - lachesis
      - atropos
    pool:
      - urania
      - daedalus
    max_optional: 2
    tag_mapping:
      api: urania
      algorithm: daedalus
  agents:
    worker-a:
      role: coder
      task: implement feature X
    worker-b:
      role: tester
      task: test feature X
`;
		const def = parseSwarmYaml(yaml);
		expect(def.mode).toBe("loop");
		expect(def.name).toBe("test-loop");
		expect(def.agents.size).toBe(2);
	});

	it("validates loop mode swarm definition", () => {
		const yaml = `
swarm:
  name: test-loop
  workspace: /tmp/test
  mode: loop
  agents:
    worker-a:
      role: coder
      task: do something
`;
		const def = parseSwarmYaml(yaml);
		const errors = validateSwarmDefinition(def);
		expect(errors).toEqual([]);
	});

	it("resolves loop config with defaults", () => {
		const raw = {};
		const config = resolveLoopConfig(raw);
		expect(config.maxIterations).toBe(5);
		expect(config.autoRetry).toBe(true);
		expect(config.humanEscalation).toBe(true);
		expect(config.workers.initial).toBe(5);
		expect(config.workers.min).toBe(1);
		expect(config.workers.max).toBe(12);
		expect(config.workers.maxRounds).toBe(5);
		expect(config.workers.roundsConvergenceThreshold).toBe(3);
		expect(config.workers.roundtablePrompt).toBeUndefined();
		expect(config.cloners.count).toBe(3);
	});

	it("resolves loop config with multi-round workers", () => {
		const raw: Record<string, unknown> = {
			workers: {
				initial: 4,
				max_rounds: 3,
				roundtable_prompt: "Critique the prior round's work and improve.",
			},
		};
		const config = resolveLoopConfig(raw);
		expect(config.workers.initial).toBe(4);
		expect(config.workers.maxRounds).toBe(3);
		expect(config.workers.roundtablePrompt).toBe("Critique the prior round's work and improve.");
	});

	it("resolves plan_debate config with defaults", () => {
		const raw = {};
		const config = resolveLoopConfig(raw);
		expect(config.planDebate.enabled).toBe(true);
		expect(config.planDebate.clonerCount).toBe(2);
		expect(config.planDebate.maxRounds).toBe(3);
		expect(config.planDebate.convergenceThreshold).toBe(2);
	});

	it("resolves plan_debate config with custom values", () => {
		const raw: Record<string, unknown> = {
			plan_debate: {
				enabled: false,
				cloner_count: 4,
				max_rounds: 5,
				convergence_threshold: 3,
			},
		};
		const config = resolveLoopConfig(raw);
		expect(config.planDebate.enabled).toBe(false);
		expect(config.planDebate.clonerCount).toBe(4);
		expect(config.planDebate.maxRounds).toBe(5);
		expect(config.planDebate.convergenceThreshold).toBe(3);
	});

	it("resolves loop config with custom values", () => {
		const raw = {
			max_iterations: 10,
			auto_retry: false,
			human_escalation: false,
			workers: {
				initial: 5,
				min: 2,
				max: 10,
			},
			cloners: {
				count: 3,
			},
		};
		const config = resolveLoopConfig(raw);
		expect(config.maxIterations).toBe(10);
		expect(config.autoRetry).toBe(false);
		expect(config.humanEscalation).toBe(false);
		expect(config.workers.initial).toBe(5);
		expect(config.workers.min).toBe(2);
		expect(config.workers.max).toBe(10);
		expect(config.cloners.count).toBe(3);
	});
});

describe("schema - backward compatibility", () => {
	it("still parses pipeline mode", () => {
		const yaml = `
swarm:
  name: test-pipe
  workspace: /tmp/test
  mode: pipeline
  target_count: 2
  agents:
    a:
      role: coder
      task: code
`;
		const def = parseSwarmYaml(yaml);
		expect(def.mode).toBe("pipeline");
		expect(def.targetCount).toBe(2);
	});

	it("still parses parallel mode", () => {
		const yaml = `
swarm:
  name: test-par
  workspace: /tmp/test
  mode: parallel
  agents:
    a:
      role: coder
      task: do a
    b:
      role: tester
      task: do b
`;
		const def = parseSwarmYaml(yaml);
		expect(def.mode).toBe("parallel");
		expect(def.agents.size).toBe(2);
	});

	it("still parses sequential mode (default)", () => {
		const yaml = `
swarm:
  name: test-seq
  workspace: /tmp/test
  agents:
    a:
      role: coder
      task: step 1
    b:
      role: tester
      task: step 2
`;
		const def = parseSwarmYaml(yaml);
		expect(def.mode).toBe("sequential");
	});
});

describe("schema - invalid modes", () => {
	it("rejects unknown modes", () => {
		const yaml = `
swarm:
  name: test-bad
  workspace: /tmp/test
  mode: magic
  agents:
    a:
      role: wizard
      task: cast spell
`;
		expect(() => parseSwarmYaml(yaml)).toThrow("Invalid mode");
	});
});

describe("schema - agent_restrictions with write_allowlist", () => {
	it("parses write_allowlist from agent_restrictions", () => {
		const raw: Record<string, unknown> = {
			workers: { initial: 3 },
			agent_restrictions: {
				socrates: {
					allowed: ["read", "write", "grep", "find", "glob"],
					write_allowlist: ["plan.md"],
				},
			},
		};
		const config = resolveLoopConfig(raw);
		const restrictions = config.agentRestrictions;
		expect(restrictions).toBeDefined();
		expect(restrictions!.socrates).toBeDefined();
		expect(restrictions!.socrates.allowed).toEqual(["read", "write", "grep", "find", "glob"]);
		expect(restrictions!.socrates.write_allowlist).toEqual(["plan.md"]);
	});

	it("write_allowlist accepts multiple paths", () => {
		const raw: Record<string, unknown> = {
			workers: { initial: 3 },
			agent_restrictions: {
				socrates: {
					write_allowlist: ["plan.md", "todo.md", "README.md"],
				},
			},
		};
		const config = resolveLoopConfig(raw);
		const restrictions = config.agentRestrictions;
		expect(restrictions!.socrates.write_allowlist).toEqual([
			"plan.md",
			"todo.md",
			"README.md",
		]);
	});

	it("agent_restrictions without write_allowlist still works (backward compat)", () => {
		const raw: Record<string, unknown> = {
			workers: { initial: 3 },
			agent_restrictions: {
				socrates: {
					allowed: ["read"],
				},
			},
		};
		const config = resolveLoopConfig(raw);
		const restrictions = config.agentRestrictions;
		expect(restrictions).toBeDefined();
		expect(restrictions!.socrates.allowed).toEqual(["read"]);
		expect(restrictions!.socrates.write_allowlist).toBeUndefined();
	});

	it("agent_restrictions entry with only write_allowlist is included", () => {
		const raw: Record<string, unknown> = {
			workers: { initial: 3 },
			agent_restrictions: {
				socrates: {
					write_allowlist: ["plan.md"],
				},
			},
		};
		const config = resolveLoopConfig(raw);
		const restrictions = config.agentRestrictions;
		expect(restrictions).toBeDefined();
		// write_allowlist alone is enough to include the restriction
		expect(restrictions!.socrates).toBeDefined();
		expect(restrictions!.socrates.write_allowlist).toEqual(["plan.md"]);
	});

	it("agent_restrictions with only write_allowlist and no allowed/blocked is valid", () => {
		// This tests that the condition in parseAgentRestrictions
		// (line 451: write_allowlist alone is sufficient)
		const raw: Record<string, unknown> = {
			workers: { initial: 3 },
			agent_restrictions: {
				socrates: {
					write_allowlist: ["plan.md"],
				},
			},
		};
		const config = resolveLoopConfig(raw);
		const restrictions = config.agentRestrictions;
		expect(restrictions).toBeDefined();
		expect(restrictions!.socrates.write_allowlist).toEqual(["plan.md"]);
		expect(restrictions!.socrates.allowed).toBeUndefined();
		expect(restrictions!.socrates.blocked).toBeUndefined();
	});
});

describe("schema - loop validation", () => {
	it("rejects maxRounds < 0", () => {
		const yaml = `
swarm:
  name: test-loop
  workspace: /tmp/test
  mode: loop
  max_iterations: 3
  workers:
    initial: 3
    max_rounds: -1
  agents: {}
`;
		const def = parseSwarmYaml(yaml);
		const errors = validateSwarmDefinition(def);
		expect(errors).toContain("workers.max_rounds must be >= 0 (0 = unlimited, convergence-driven)");
	});

	it("accepts maxRounds = 0 (unlimited, convergence-driven)", () => {
		const yaml = `
swarm:
  name: test-loop
  workspace: /tmp/test
  mode: loop
  max_iterations: 3
  workers:
    initial: 5
    max_rounds: 0
  agents: {}
`;
		const def = parseSwarmYaml(yaml);
		const errors = validateSwarmDefinition(def);
		expect(errors).toEqual([]);
	});
});
