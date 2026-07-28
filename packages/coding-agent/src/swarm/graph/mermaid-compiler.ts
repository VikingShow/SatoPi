import type { GraphDefinition, GraphEdge, GraphNode } from "./schema";

// ── Error types ──────────────────────────────────────────────

export interface MermaidValidationError {
	path: string;
	message: string;
	severity: "error" | "warning";
	line?: number;
}

export class MermaidCompileError extends Error {
	readonly errors: MermaidValidationError[];

	constructor(errors: MermaidValidationError[]) {
		const messages = errors.map(e => `${e.severity}: ${e.message}`).join("; ");
		super(`Mermaid compilation failed: ${messages}`);
		this.name = "MermaidCompileError";
		this.errors = errors;
	}
}

// ── Types ────────────────────────────────────────────────────

interface MermaidNode {
	id: string;
	label: string;
	shape: "rect" | "diamond" | "circle" | "rounded" | "asymmetric";
	line: number;
}

interface MermaidEdge {
	from: string;
	to: string;
	label: string | null;
	line: number;
}

interface MermaidSubgraph {
	name: string;
	nodeIds: string[];
}

interface ParseResult {
	direction: "TD" | "LR" | "TB" | "BT" | "RL";
	nodes: MermaidNode[];
	edges: MermaidEdge[];
	subgraphs: MermaidSubgraph[];
	errors: MermaidValidationError[];
}

// ── Regex patterns ───────────────────────────────────────────

// Node shapes: A[rect], B{decision}, C((circle)), D(rounded), E>asymmetric]
const NODE_RE = /^([A-Za-z_]\w*)\s*(\[(.*?)\]|\{(.*?)\}|\(\((.*?)\)\)|\((.*?)\)|>(.*?)\])/;

// Edge: A --> B, A -->|"label"| B, A --- B, A -.-> B, A ==> B
const EDGE_RE = /^([A-Za-z_]\w*)\s*(-->|---|==>|-\.->|-\.-)\s*(\|"(.*?)"\|\s*)?([A-Za-z_]\w*)$/;

// Subgraph boundaries
const SUBGRAPH_START_RE = /^subgraph\s+(.+)$/i;
const SUBGRAPH_END_RE = /^end$/i;

// Direction line
const DIRECTION_RE = /^graph\s+(TD|LR|TB|BT|RL)\s*$/i;

// Comment
const COMMENT_RE = /^%%/;

// ── Parser ───────────────────────────────────────────────────

function parseMermaid(mermaid: string, name: string): ParseResult {
	const errors: MermaidValidationError[] = [];
	const nodes: MermaidNode[] = [];
	const edges: MermaidEdge[] = [];
	const subgraphs: MermaidSubgraph[] = [];

	const lines = mermaid.split("\n");
	let direction: "TD" | "LR" | "TB" | "BT" | "RL" = "TD";

	// Find the direction line
	let firstNonComment = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "" || COMMENT_RE.test(line)) continue;
		firstNonComment = i;
		break;
	}

	if (firstNonComment === -1) {
		errors.push({
			path: name,
			message: "Empty Mermaid input — no direction line found",
			severity: "error",
		});
		return { direction, nodes, edges, subgraphs, errors };
	}

	const dirMatch = DIRECTION_RE.exec(lines[firstNonComment].trim());
	if (!dirMatch) {
		errors.push({
			path: name,
			message: `Expected "graph TD|LR|TB|BT|RL" on first non-comment line, got "${lines[firstNonComment].trim()}"`,
			severity: "error",
			line: firstNonComment + 1,
		});
	} else {
		direction = dirMatch[1].toUpperCase() as "TD" | "LR" | "TB" | "BT" | "RL";
	}

	// Parse remaining lines
	let currentSubgraph: MermaidSubgraph | null = null;

	for (let i = firstNonComment + 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "" || COMMENT_RE.test(line)) continue;

		// Subgraph start
		const subStart = SUBGRAPH_START_RE.exec(line);
		if (subStart) {
			if (currentSubgraph) {
				errors.push({
					path: name,
					message: `Nested subgraph "${subStart[1].trim()}" inside "${currentSubgraph.name}" — subgraphs are flattened in v1`,
					severity: "warning",
					line: i + 1,
				});
			}
			currentSubgraph = {
				name: subStart[1].trim(),
				nodeIds: [],
			};
			continue;
		}

		// Subgraph end
		if (SUBGRAPH_END_RE.test(line)) {
			if (currentSubgraph) {
				subgraphs.push(currentSubgraph);
				currentSubgraph = null;
			} else {
				errors.push({
					path: name,
					message: "Unexpected `end` without matching `subgraph`",
					severity: "error",
					line: i + 1,
				});
			}
			continue;
		}

		// Try node match first (more specific: it requires shape brackets)
		const nodeMatch = NODE_RE.exec(line);
		if (nodeMatch) {
			const id = nodeMatch[1];
			let label: string;
			let shape: MermaidNode["shape"];

			if (nodeMatch[2]?.startsWith("[")) {
				label = nodeMatch[3] ?? id;
				shape = "rect";
			} else if (nodeMatch[2]?.startsWith("{")) {
				label = nodeMatch[4] ?? id;
				shape = "diamond";
			} else if (nodeMatch[2]?.startsWith("((")) {
				label = nodeMatch[5] ?? id;
				shape = "circle";
			} else if (nodeMatch[2]?.startsWith("(")) {
				label = nodeMatch[6] ?? id;
				shape = "rounded";
			} else {
				label = nodeMatch[7] ?? id;
				shape = "asymmetric";
			}

			// Check for duplicate node ID
			if (nodes.some(n => n.id === id)) {
				errors.push({
					path: `${name}.nodes.${id}`,
					message: `Duplicate node ID "${id}"`,
					severity: "error",
					line: i + 1,
				});
			}

			nodes.push({ id, label, shape, line: i + 1 });
			if (currentSubgraph) {
				currentSubgraph.nodeIds.push(id);
			}
			continue;
		}

		// Try edge match
		const edgeMatch = EDGE_RE.exec(line);
		if (edgeMatch) {
			const from = edgeMatch[1];
			const to = edgeMatch[5];
			const label = edgeMatch[4] ?? null;
			edges.push({ from, to, label, line: i + 1 });
			continue;
		}

		// Unrecognized line
		errors.push({
			path: name,
			message: `Unrecognized Mermaid syntax: "${line}"`,
			severity: "error",
			line: i + 1,
		});
	}

	// Unclosed subgraph
	if (currentSubgraph) {
		errors.push({
			path: name,
			message: `Unclosed subgraph "${currentSubgraph.name}" — missing "end"`,
			severity: "error",
		});
	}

	// Validate edge endpoints reference known nodes
	const nodeIds = new Set(nodes.map(n => n.id));
	for (const edge of edges) {
		if (!nodeIds.has(edge.from)) {
			errors.push({
				path: `${name}.edges`,
				message: `Edge references unknown source node "${edge.from}"`,
				severity: "error",
				line: edge.line,
			});
		}
		if (!nodeIds.has(edge.to)) {
			errors.push({
				path: `${name}.edges`,
				message: `Edge references unknown target node "${edge.to}"`,
				severity: "error",
				line: edge.line,
			});
		}
	}

	return { direction, nodes, edges, subgraphs, errors };
}

// ── Compiler ─────────────────────────────────────────────────

const DEFAULT_TOOLS: GraphNode["tools"] = ["read", "write", "edit", "grep", "bash"];

function buildGraphNode(node: MermaidNode): GraphNode {
	return {
		label: node.label,
		description: `Node "${node.id}" from Mermaid flowchart`,
		type: "custom",
		role: "developer",
		tools: [...DEFAULT_TOOLS],
		depends_on: [],
	};
}

/**
 * Compile a Mermaid flowchart string into a GraphDefinition.
 *
 * Throws `MermaidCompileError` for malformed input (fatal errors).
 * Non-fatal warnings are included as returned `MermaidValidationError[]`.
 */
export function compileMermaidToGraph(mermaid: string, name: string): GraphDefinition {
	const result = parseMermaid(mermaid, name);

	const fatalErrors = result.errors.filter(e => e.severity === "error");
	if (fatalErrors.length > 0) {
		throw new MermaidCompileError(result.errors);
	}

	// Build nodes map
	const nodes: Record<string, GraphNode> = {};
	for (const node of result.nodes) {
		nodes[node.id] = buildGraphNode(node);
	}

	// Derive depends_on from edges
	for (const edge of result.edges) {
		const target = nodes[edge.to];
		if (target && !target.depends_on.includes(edge.from)) {
			target.depends_on.push(edge.from);
		}
	}

	// Build edges array with artifacts from edge labels
	const graphEdges: GraphEdge[] = result.edges.map(e => ({
		from: e.from,
		to: e.to,
		artifacts: e.label ? [e.label] : undefined,
		label: e.label ?? undefined,
	}));

	return {
		name,
		description: `Mermaid flowchart: ${name}`,
		version: 1,
		revision: 0,
		nodes,
		edges: graphEdges.length > 0 ? graphEdges : undefined,
	};
}

// ── Reverse compiler ─────────────────────────────────────────

const SHAPE_MAP: Record<string, string> = {
	custom: "[]",
	stage: "()",
	curtain: "{}",
	script: "(())",
};

function escapeLabel(label: string): string {
	// Escape double quotes in labels
	return label.replace(/"/g, '\\"');
}

/**
 * Convert a GraphDefinition to a Mermaid flowchart string.
 *
 * Node types map to shapes:
 *   - "custom"  → `[label]`  (rectangle)
 *   - "stage"   → `(label)`  (rounded rectangle)
 *   - "curtain" → `{label}`  (diamond)
 *   - "script"  → `((label))` (circle)
 */
export function graphToMermaid(graph: GraphDefinition): string {
	const lines: string[] = [];

	// Direction line — always TD
	lines.push("graph TD");

	// Node declarations
	for (const [id, node] of Object.entries(graph.nodes)) {
		const shape = SHAPE_MAP[node.type ?? "custom"] ?? SHAPE_MAP.custom;
		const open = shape[0];
		const close = shape[2] ?? shape[1];
		const label = escapeLabel(node.label ?? id);
		lines.push(`    ${id}${open}${label}${close}`);
	}

	// Edge declarations
	if (graph.edges && graph.edges.length > 0) {
		lines.push("");

		for (const edge of graph.edges) {
			const label =
				edge.artifacts && edge.artifacts.length > 0
					? `|"${escapeLabel(edge.artifacts[0])}"| `
					: edge.label
						? `|"${escapeLabel(edge.label)}"| `
						: "";
			lines.push(`    ${edge.from} --> ${label}${edge.to}`);
		}
	}

	return `${lines.join("\n")}\n`;
}
