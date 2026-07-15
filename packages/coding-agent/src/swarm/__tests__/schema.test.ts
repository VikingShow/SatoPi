import { describe, expect, it } from "bun:test";
import { parseSwarmYaml, validateSwarmDefinition, resolveLoopConfig } from "../schema";

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
		expect(config.mode).toBe("loop");
		expect(config.maxIterations).toBe(5);
		expect(config.reviewGate).toBe("atropos_veto");
		expect(config.autoRetry).toBe(true);
		expect(config.humanEscalation).toBe(true);
		expect(config.roundtable.proposeTimeout).toBe(60_000);
		expect(config.reviewers.core).toEqual(["clotho", "lachesis", "atropos"]);
		expect(config.reviewers.pool).toContain("urania");
	});

	it("resolves loop config with custom values", () => {
		const raw = {
			max_iterations: 10,
			review_gate: "atropos_veto",
			auto_retry: false,
			human_escalation: false,
			roundtable: {
				propose_timeout: 10_000,
				debate_timeout: 30_000,
				vote_timeout: 5_000,
			},
			reviewers: {
				core: ["clotho", "lachesis", "atropos"],
				pool: ["minerva", "vulcan"],
				max_optional: 3,
				tag_mapping: { ui: "minerva", infra: "vulcan" },
			},
		};
		const config = resolveLoopConfig(raw);
		expect(config.maxIterations).toBe(10);
		expect(config.autoRetry).toBe(false);
		expect(config.humanEscalation).toBe(false);
		expect(config.roundtable.proposeTimeout).toBe(10_000);
		expect(config.reviewers.maxOptional).toBe(3);
		expect(config.reviewers.pool).toEqual(["minerva", "vulcan"]);
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
