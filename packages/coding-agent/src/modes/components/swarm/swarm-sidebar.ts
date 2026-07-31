import type { Component } from "@satopi/pi-tui";
import type { CrewManager } from "../../../crew/crew-manager";
import { AgentRegistry } from "../../../registry/agent-registry";
import { formatStatusIcon } from "../../../tools/render-utils";
import { getTreeBranch, getTreeContinuePrefix } from "../../../tui/utils";
import type { Theme } from "../../theme/theme";
import { swarmPanel } from "./swarm-panel-block";

type ToolUIStatus = "done" | "error" | "aborted" | "running" | "pending";

const AGENT_STATUS_ICON: Record<string, ToolUIStatus> = {
	completed: "done",
	failed: "error",
	aborted: "aborted",
	running: "running",
	idle: "done",
	parked: "done",
	pending: "pending",
};

// ── Tree node model ────────────────────────────────────────────────────────

interface TreeNode {
	type: "session" | "agent" | "crew" | "crew-member" | "swarm" | "action";
	id: string;
	label: string;
	status?: string;
	crewId?: string;
	agentId?: string;
	children?: TreeNode[];
	expanded?: boolean;
	depth: number;
}

// ── Config & Limits ────────────────────────────────────────────────────────

const MIN_SIDEBAR_WIDTH_PCT = 15;
const MAX_SIDEBAR_WIDTH_PCT = 60;
const RESIZE_STEP_PCT = 5;
const DEFAULT_SIDEBAR_WIDTH_PCT = 35;

export interface SwarmSidebarConfig {
	onSelectAgent?: (agentId: string) => void;
	onClose?: () => void;
	onRequestRender?: () => void;
	crewManager?: CrewManager;
	sessionName?: string;
	/** Called when Tab is pressed to return focus to transcript. */
	onFocusTranscript?: () => void;
	/** Called when Enter is pressed on "+ Add Member" action node. */
	onAddMember?: () => void;
	/** Called when Enter is pressed on "- Remove Member" action node. */
	onRemoveMember?: (agentId: string) => void;
}

export class SwarmSidebar implements Component {
	readonly #config: SwarmSidebarConfig;
	readonly #theme: Theme;
	#sidebarWidthPct = DEFAULT_SIDEBAR_WIDTH_PCT;
	#selectedPath: string[] = []; // breadcrumb of node ids
	#expandedCrews = new Set<string>();
	#expandedSwarms = new Set<string>();
	#unreadAgents = new Set<string>();
	#multiSelected = new Set<string>();
	#unsubscribe?: () => void;

	constructor(config: SwarmSidebarConfig, theme: Theme) {
		this.#config = config;
		this.#theme = theme;
		this.#unsubscribe = AgentRegistry.global().onChange(() => {
			this.#config.onRequestRender?.();
		});
	}

	/** Mark an agent as having unread output. Requests a render to show the dot. */
	markUnread(agentId: string): void {
		if (this.#unreadAgents.has(agentId)) return;
		this.#unreadAgents.add(agentId);
		this.#config.onRequestRender?.();
	}

	get sidebarWidthPct(): number {
		return this.#sidebarWidthPct;
	}

	// ── Tree building ──────────────────────────────────────────────────────

	#buildTree(): TreeNode[] {
		const nodes: TreeNode[] = [];

		// Root: Session name
		const sessionName = this.#config.sessionName ?? "Session";
		nodes.push({ type: "session", id: "session", label: sessionName, depth: 0 });

		const allRefs = AgentRegistry.global()
			.list()
			.filter(r => r.kind !== "advisor");
		const mainRefs = allRefs.filter(r => r.kind === "main");
		const subRefs = allRefs.filter(r => r.kind === "sub");

		// Main agent at root (e.g. the orchestrator)
		for (const ref of mainRefs) {
			nodes.push({
				type: "agent",
				id: ref.id,
				label: ref.displayName,
				status: ref.status,
				agentId: ref.id,
				depth: 0,
			});
		}

		// Swarms node: groups sub-agents under a collapsible tree node
		if (subRefs.length > 0) {
			const swarmsExpanded = this.#expandedSwarms.has("swarms");
			const swarmsNode: TreeNode = {
				type: "swarm",
				id: "swarms",
				label: "Swarms",
				expanded: swarmsExpanded,
				depth: 0,
				children: [],
			};
			if (swarmsExpanded) {
				for (const ref of subRefs) {
					swarmsNode.children!.push({
						type: "agent",
						id: ref.id,
						label: ref.displayName,
						status: ref.status,
						agentId: ref.id,
						depth: 1,
					});
				}
			}
			nodes.push(swarmsNode);
		}
		// Crews
		const crews = this.#config.crewManager?.listCrews() ?? [];
		for (const crew of crews) {
			const expanded = this.#expandedCrews.has(crew.id);
			const crewNode: TreeNode = {
				type: "crew",
				id: `crew:${crew.id}`,
				label: crew.name,
				crewId: crew.id,
				expanded,
				depth: 0,
				children: [],
			};
			if (expanded) {
				const entry = this.#config.crewManager?.getCrew(crew.id);
				if (entry) {
					for (const member of entry.state.members) {
						const agentRef = AgentRegistry.global().get(member.agentId);
						crewNode.children!.push({
							type: "crew-member",
							id: `crew:${crew.id}:member:${member.agentId}`,
							label: agentRef?.displayName ?? member.agentId,
							status: agentRef?.status ?? "idle",
							agentId: member.agentId,
							depth: 1,
						});
					}
					crewNode.children!.push({
						type: "action",
						id: `crew:${crew.id}:action-add`,
						label: "+ Add Member",
						depth: 1,
					});
					crewNode.children!.push({
						type: "action",
						id: `crew:${crew.id}:action-remove`,
						label: "- Remove Member (d on member)",
						depth: 1,
					});
				}
			}
			nodes.push(crewNode);
		}

		return nodes;
	}

	// ── Flatten tree with branch prefixes ─────────────────────────────────

	#flattenTree(nodes: TreeNode[], ancestors: boolean[] = []): FlatNode[] {
		const result: FlatNode[] = [];
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			const isLast = i === nodes.length - 1;
			const branch = getTreeBranch(isLast, this.#theme);
			const continuePrefix = getTreeContinuePrefix(isLast, this.#theme);
			const depthPrefix = ancestors
				.map(hasNext => (hasNext ? `${this.#theme.fg("dim", this.#theme.tree.vertical)}  ` : "   "))
				.join("");
			const prefix = `${depthPrefix}${this.#theme.fg("dim", branch)} `;

			result.push({ node, prefix, continuePrefix: `${depthPrefix}${continuePrefix}`, flatIndex: result.length });

			if (node.children && node.expanded) {
				const childResults = this.#flattenTree(node.children, [...ancestors, !isLast]);
				result.push(...childResults);
			}
		}
		return result;
	}

	// ── Render ─────────────────────────────────────────────────────────────

	render(width: number): readonly string[] {
		const panel = swarmPanel(
			"Agents",
			({ innerWidth, theme: t }) => {
				const tree = this.#buildTree();
				const lines: string[] = [];

				if (tree.length === 0) {
					return [t.fg("dim", "  No active agents or crews")];
				}

				const flat = this.#flattenTree(tree);
				const maxVisible = Math.min(flat.length, 20);

				for (let i = 0; i < maxVisible; i++) {
					const { node, prefix } = flat[i];
					const isSelected =
						this.#selectedPath.length > 0 && this.#selectedPath[this.#selectedPath.length - 1] === node.id;

					if (node.type === "session") {
						const cursor = isSelected ? t.fg("accent", "*") : " ";
						lines.push(`${cursor}${t.bold(node.label)}`);
						continue;
					}

					const multiMark = this.#multiSelected.has(node.id) ? t.fg("accent", "\u2713 ") : "";
					const cursor = isSelected ? t.fg("accent", "\u25b6 ") : "  ";

					if (node.type === "agent" || node.type === "crew-member") {
						const iconStatus = AGENT_STATUS_ICON[node.status ?? "idle"] ?? "done";
						const glyph = formatStatusIcon(iconStatus, t);
						const color = iconStatus === "running" ? "accent" : iconStatus === "error" ? "error" : "dim";
						const icon = t.fg(color as "accent" | "error" | "dim", glyph);
						const maxName = Math.max(4, innerWidth - 20);
						const name = node.label.length > maxName ? `${node.label.slice(0, maxName - 1)}\u2026` : node.label;
						const unreadDot = this.#unreadAgents.has(node.agentId ?? "") ? t.fg("accent", "\u25cf ") : "";
						lines.push(`${prefix}${cursor}${multiMark}${icon} ${unreadDot}${name}`);
					} else if (node.type === "crew" || node.type === "swarm") {
						const expandIcon = node.expanded ? "\u25bc" : "\u25b6";
						const expandGlyph = t.fg("dim", expandIcon);
						const countHint = t.fg("dim", ` (${node.children?.length ?? 0})`);
						lines.push(`${prefix}${cursor}${multiMark}${expandGlyph} ${t.fg("accent", node.label)}${countHint}`);
					} else if (node.type === "action") {
						const actionIcon = node.label.startsWith("+") ? "+" : "-";
						const icon = t.fg("accent", actionIcon + " ");
						lines.push(`${prefix}${cursor}${multiMark}${icon}${t.fg("dim", node.label.slice(2).trim())}`);
					}
				}

				if (flat.length > maxVisible) {
					lines.push(t.fg("dim", `  +${flat.length - maxVisible} more`));
				}

				lines.push("");
				lines.push(t.fg("dim", ` j/k nav  Enter sel/open  Space select  Ctrl+B close  \u2190\u2192 resize`));
				return lines;
			},
			this.#theme,
		);
		return panel.render(width);
	}

	// ── Input handling ─────────────────────────────────────────────────────

	handleInput(data: string): void {
		const tree = this.#buildTree();
		const flat = this.#flattenTree(tree);

		// Tab: return focus to transcript
		if (data === "\t" || data === "Tab") {
			this.#config.onFocusTranscript?.();
			return;
		}

		// Ctrl+B / Esc: close sidebar
		if (data === "\x02" || data === "escape" || data === "q" || data === "\x1b") {
			this.#config.onClose?.();
			return;
		}

		// Ctrl+Left: shrink
		if (data === "\x1b[1;5D" || data === "\x1b[1;3D") {
			this.#sidebarWidthPct = Math.max(MIN_SIDEBAR_WIDTH_PCT, this.#sidebarWidthPct - RESIZE_STEP_PCT);
			this.#config.onRequestRender?.();
			return;
		}

		// Ctrl+Right: expand
		if (data === "\x1b[1;5C" || data === "\x1b[1;3C") {
			this.#sidebarWidthPct = Math.min(MAX_SIDEBAR_WIDTH_PCT, this.#sidebarWidthPct + RESIZE_STEP_PCT);
			this.#config.onRequestRender?.();
			return;
		}

		// Find current selected index
		const currentId = this.#selectedPath.length > 0 ? this.#selectedPath[this.#selectedPath.length - 1] : undefined;
		const currentIdx = currentId ? flat.findIndex(f => f.node.id === currentId) : -1;

		switch (data) {
			case "j":
			case "ArrowDown":
				if (flat.length > 0) {
					const next = Math.min(flat.length - 1, currentIdx + 1);
					this.#selectedPath = [flat[next].node.id];
					this.#config.onRequestRender?.();
				}
				break;
			case "k":
			case "ArrowUp":
				if (flat.length > 0) {
					const prev = Math.max(0, currentIdx - 1);
					this.#selectedPath = [flat[prev].node.id];
					this.#config.onRequestRender?.();
				}
				break;
			case " ": // Space: toggle multi-select
				if (currentIdx >= 0) {
					const node = flat[currentIdx].node;
					if (
						node.type === "agent" ||
						node.type === "crew-member" ||
						node.type === "crew" ||
						node.type === "swarm"
					) {
						if (this.#multiSelected.has(node.id)) {
							this.#multiSelected.delete(node.id);
						} else {
							this.#multiSelected.add(node.id);
						}
						this.#config.onRequestRender?.();
					}
				}
			case "d":
				if (currentIdx >= 0) {
					const node = flat[currentIdx].node;
					if (node.type === "crew-member" && node.agentId) {
						this.#config.onRemoveMember?.(node.agentId);
					}
				}
				break;
			case "Enter":
				if (currentIdx >= 0) {
					const node = flat[currentIdx].node;
					if (node.type === "crew") {
						// Toggle crew expand/collapse
						const crewId = node.crewId;
						if (crewId) {
							if (this.#expandedCrews.has(crewId)) {
								this.#expandedCrews.delete(crewId);
							} else {
								this.#expandedCrews.add(crewId);
							}
							this.#config.onRequestRender?.();
						}
					} else if (node.type === "swarm") {
						// Toggle swarm expand/collapse
						if (this.#expandedSwarms.has(node.id)) {
							this.#expandedSwarms.delete(node.id);
						} else {
							this.#expandedSwarms.add(node.id);
						}
						this.#config.onRequestRender?.();
					} else if (node.type === "agent" || node.type === "crew-member") {
						if (node.agentId) {
							this.#unreadAgents.delete(node.agentId);
							this.#config.onSelectAgent?.(node.agentId);
							if (this.#multiSelected.size === 0) {
								this.#config.onClose?.();
							}
						}
					} else if (node.type === "session") {
						// Focus main session
						this.#config.onClose?.();
					} else if (node.type === "action") {
						if (node.id.includes(":action-add")) {
							this.#config.onAddMember?.();
						} else if (node.id.includes(":action-remove")) {
							// Prompt user: select a member by focusing them, then press d
						}
					}
				}
				break;
		}
	}

	dispose(): void {
		this.#unsubscribe?.();
	}
}

interface FlatNode {
	node: TreeNode;
	prefix: string;
	continuePrefix: string;
	flatIndex: number;
}
