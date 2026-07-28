/**
 * Build a dependency map: agent name → set of agents it depends on.
 *
 * Dependencies come from:
 * 1. Explicit `waits_for` declarations
 * 2. Implicit from `reports_to` (if A reports_to B, then B depends on A)
 * 3. For pipeline/sequential mode with no explicit deps: chain by YAML declaration order
 */

/**
 * Detect cycles in the dependency graph.
 * Returns the names of agents involved in cycles, or null if acyclic.
 */
export function detectCycles(deps: Map<string, Set<string>>): string[] | null {
	// Kahn's algorithm: if topological sort doesn't include all nodes, cycles exist
	const inDegree = new Map<string, number>();
	const forward = new Map<string, string[]>(); // dependency → its dependents

	for (const [node, nodeDeps] of deps) {
		inDegree.set(node, nodeDeps.size);
		for (const dep of nodeDeps) {
			const list = forward.get(dep) ?? [];
			list.push(node);
			forward.set(dep, list);
		}
	}

	const queue: string[] = [];
	for (const [node, degree] of inDegree) {
		if (degree === 0) queue.push(node);
	}

	const sorted: string[] = [];
	while (queue.length > 0) {
		const node = queue.shift()!;
		sorted.push(node);
		for (const dependent of forward.get(node) ?? []) {
			const newDegree = inDegree.get(dependent)! - 1;
			inDegree.set(dependent, newDegree);
			if (newDegree === 0) queue.push(dependent);
		}
	}

	if (sorted.length < deps.size) {
		return [...deps.keys()].filter(k => !sorted.includes(k));
	}

	return null;
}

/**
 * Build execution waves from dependency graph via topological sort.
 *
 * Each wave contains agents whose dependencies are all in earlier waves.
 * Agents within a wave can execute in parallel.
 */
export function buildExecutionWaves(deps: Map<string, Set<string>>): string[][] {
	const waves: string[][] = [];
	const completed = new Set<string>();
	const remaining = new Set(deps.keys());

	while (remaining.size > 0) {
		const wave: string[] = [];

		for (const node of remaining) {
			const nodeDeps = deps.get(node)!;
			let ready = true;
			for (const dep of nodeDeps) {
				if (!completed.has(dep)) {
					ready = false;
					break;
				}
			}
			if (ready) {
				wave.push(node);
			}
		}

		if (wave.length === 0) {
			throw new Error(
				`Deadlock: agents [${[...remaining].join(", ")}] cannot make progress. This indicates a bug in cycle detection.`,
			);
		}

		// Sort for deterministic execution order
		wave.sort();

		for (const node of wave) {
			remaining.delete(node);
			completed.add(node);
		}

		waves.push(wave);
	}

	return waves;
}
