import * as path from "node:path";
import { type Component, visibleWidth } from "@satopi/pi-tui";
import { matchesKey } from "@satopi/pi-tui/keys";
import { formatAge } from "@satopi/pi-utils";
import type { CrewManager } from "../../../crew/crew-manager";
import { AgentRegistry, MAIN_AGENT_ID } from "../../../registry/agent-registry";
import type { SessionInfo } from "../../../session/store/session-listing";
import { formatStatusIcon } from "../../../tools/render-utils";
import { Ellipsis, getTreeBranch, getTreeContinuePrefix, truncateToWidth } from "../../../tui/utils";
import type { Theme } from "../../theme/theme";
import { type PersistedAgentInfo, summarizePersistedAgents } from "../agent-hub";
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

/** Relative time for a persisted-agent tree's latest mtime, e.g. "2h ago". */
function formatRelativeMtime(mtimeMs: number): string {
	return formatAge((Date.now() - mtimeMs) / 1000);
}

// ── Tree node model ────────────────────────────────────────────────────────

interface TreeNode {
	type: "session" | "agent" | "crew" | "crew-member" | "swarm" | "action" | "history" | "history-session";
	id: string;
	label: string;
	status?: string;
	crewId?: string;
	agentId?: string;
	/** For history rows: the session file the row represents or opens. */
	sessionFile?: string;
	/** For history session rows: persisted subagent count (once summarized). */
	agentCount?: number;
	/** For history session rows: latest persisted agent mtime in ms (once summarized). */
	agentMtime?: number;
	children?: TreeNode[];
	expanded?: boolean;
	depth: number;
}

// ── Config & Limits ────────────────────────────────────────────────────────

const MIN_SIDEBAR_WIDTH_PCT = 15;
const MAX_SIDEBAR_WIDTH_PCT = 60;
const RESIZE_STEP_PCT = 5;
const DEFAULT_SIDEBAR_WIDTH_PCT = 40;
const HISTORY_SESSION_CAP = 10;
/**
 * Keybinding hint variants, longest first. render() picks the first whose
 * visible width fits the sidebar's innerWidth so the hint never wraps onto a
 * second terminal row — a wrapped hint inflates the framed panel past the
 * overlay budget and the engine's clip amputates the bottom border.
 */
const FOOTER_HINTS: readonly string[] = [
	` j/k nav  Enter open  r resume  Space select  Ctrl+B close  \u2190\u2192 resize`,
	` j/k Enter  Esc close  \u2190\u2192 resize`,
	` j/k \u2190\u2192 resize`,
	` q close`,
];

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
	/** Current session file, used to exclude it from the History section. */
	sessionFile?: string | null;
	/** Enumerates sessions for the History section (resume targets). */
	listSessions?: () => Promise<SessionInfo[]>;
	/** Called when Enter is pressed on a History session row. */
	onResumeSession?: (sessionFile: string) => void;
	/** Called when Enter is pressed on a persisted agent inside a History session. */
	onOpenHistoryAgent?: (agent: PersistedAgentInfo) => void;
	/** Lazily loads a session's persisted agent tree when its row is expanded. */
	loadSessionAgents?: (sessionFile: string) => Promise<PersistedAgentInfo[]>;
}

export class SwarmSidebar implements Component {
	readonly #config: SwarmSidebarConfig;
	readonly #theme: Theme;
	#sidebarWidthPct = DEFAULT_SIDEBAR_WIDTH_PCT;
	#selectedPath: string[] = []; // breadcrumb of node ids
	#expandedCrews = new Set<string>();
	#expandedSwarms = new Set<string>();
	#expandedHistory = new Set<string>();
	#expandedHistoryAgents = new Set<string>();
	#otherSessions: SessionInfo[] = [];
	#sessionSummaries = new Map<string, { count: number; latestMtime: number }>();
	#historyAgents = new Map<string, PersistedAgentInfo[]>();
	#historyAgentsPending = new Set<string>();
	#unreadAgents = new Set<string>();
	#multiSelected = new Set<string>();
	#unsubscribe?: () => void;

	constructor(config: SwarmSidebarConfig, theme: Theme) {
		this.#config = config;
		this.#theme = theme;
		this.#unsubscribe = AgentRegistry.global().onChange(() => {
			this.#config.onRequestRender?.();
		});
		void this.#loadSessions();
	}

	/**
	 * Load the History section's session list (other sessions, newest first,
	 * capped), then fetch each session's persisted-agent summary sequentially.
	 */
	async #loadSessions(): Promise<void> {
		try {
			const all = (await this.#config.listSessions?.()) ?? [];
			const current = this.#config.sessionFile ?? null;
			const others = all.filter(s => s.path !== current);
			others.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			this.#otherSessions = others.slice(0, HISTORY_SESSION_CAP);
			this.#config.onRequestRender?.();
			for (const session of this.#otherSessions) {
				try {
					this.#sessionSummaries.set(session.path, await summarizePersistedAgents(session.path));
					this.#config.onRequestRender?.();
				} catch {
					// Artifacts unreadable — show the session without a badge.
				}
			}
		} catch {
			// Session listing failed — leave the History section empty.
		}
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

		// History: other sessions as resume targets, each expandable to its
		// persisted agent tree.
		if (this.#otherSessions.length > 0) {
			const historyExpanded = this.#expandedHistory.has("history");
			const historyNode: TreeNode = {
				type: "history",
				id: "history",
				label: "History",
				expanded: historyExpanded,
				depth: 0,
				children: [],
			};
			if (historyExpanded) {
				for (const session of this.#otherSessions) {
					const sessionExpanded = this.#expandedHistory.has(session.path);
					const summary = this.#sessionSummaries.get(session.path);
					const sessionNode: TreeNode = {
						type: "history-session",
						id: `history:session:${session.path}`,
						label: session.title ?? path.basename(session.path),
						sessionFile: session.path,
						agentCount: summary?.count,
						agentMtime: summary?.latestMtime,
						expanded: sessionExpanded,
						depth: 1,
						children: [],
					};
					if (sessionExpanded) {
						const agents = this.#historyAgents.get(session.path);
						if (agents) {
							// Persisted agents form a nested tree keyed by
							// parentId (a sub-session's own sub-sessions). Roots
							// are agents whose parent is the main agent or has no
							// transcript in this session (orphans). Advisors are
							// observability-only and never join the tree.
							const subs = agents.filter(a => a.kind === "sub");
							const agentIds = new Set(subs.map(a => a.id));
							const childrenByParent = new Map<string, PersistedAgentInfo[]>();
							for (const agent of subs) {
								const parent = agent.parentId ?? MAIN_AGENT_ID;
								// Orphans (parent has no transcript in this session)
								// group under MAIN so the walk below reaches them.
								const effectiveParent =
									parent === MAIN_AGENT_ID || agentIds.has(parent) ? parent : MAIN_AGENT_ID;
								const list = childrenByParent.get(effectiveParent);
								if (list) list.push(agent);
								else childrenByParent.set(effectiveParent, [agent]);
							}
							const buildAgentTree = (parentId: string, depth: number): TreeNode[] => {
								const kids = childrenByParent.get(parentId) ?? [];
								return kids.map(agent => {
									const hasChildren = childrenByParent.has(agent.id);
									const expanded = hasChildren
										? this.#expandedHistoryAgents.has(`${session.path}:${agent.id}`)
										: undefined;
									const node: TreeNode = {
										type: "agent",
										id: `history:agent:${session.path}:${agent.id}`,
										label: agent.displayName,
										status: "parked",
										agentId: agent.id,
										// The session path (the #historyAgents map key)
										// so Enter can look the agent up and toggle
										// container expansion per session.
										sessionFile: session.path,
										depth,
										expanded,
									};
									if (hasChildren && expanded) {
										node.children = buildAgentTree(agent.id, depth + 1);
									}
									return node;
								});
							};
							sessionNode.children = buildAgentTree(MAIN_AGENT_ID, 2);
						} else {
							// Lazy load in flight — show a dim placeholder row.
							sessionNode.children!.push({
								type: "agent",
								id: `history:session:${session.path}:loading`,
								label: "Loading\u2026",
								status: "pending",
								depth: 2,
							});
							this.#ensureHistoryAgents(session.path);
						}
					}
					historyNode.children!.push(sessionNode);
				}
			}
			nodes.push(historyNode);
		}

		return nodes;
	}

	/** Kick off the lazy load of a session's persisted agents (idempotent). */
	#ensureHistoryAgents(sessionFile: string): void {
		if (this.#historyAgents.has(sessionFile) || this.#historyAgentsPending.has(sessionFile)) return;
		const loader = this.#config.loadSessionAgents;
		if (!loader) return;
		this.#historyAgentsPending.add(sessionFile);
		void loader(sessionFile)
			.then(agents => {
				this.#historyAgents.set(sessionFile, agents);
				this.#historyAgentsPending.delete(sessionFile);
				this.#config.onRequestRender?.();
			})
			.catch(() => {
				this.#historyAgentsPending.delete(sessionFile);
				this.#config.onRequestRender?.();
			});
	}

	/** Toggle expand/collapse for a History root or session row. */
	#toggleHistoryExpansion(node: TreeNode): void {
		if (node.type === "history") {
			if (this.#expandedHistory.has("history")) {
				this.#expandedHistory.delete("history");
			} else {
				this.#expandedHistory.add("history");
			}
		} else if (node.sessionFile) {
			if (this.#expandedHistory.has(node.sessionFile)) {
				this.#expandedHistory.delete(node.sessionFile);
			} else {
				this.#expandedHistory.add(node.sessionFile);
				this.#ensureHistoryAgents(node.sessionFile);
			}
		}
		this.#config.onRequestRender?.();
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
		// Overlays are content-sized: the sidebar must emit enough rows itself or
		// the frame stops at the tree with blank space below. Fill the viewport
		// (same idiom as the fullscreen session picker) and size the visible tree
		// from the terminal height instead of a fixed cap.
		const termRows = process.stdout.rows || 24;
		const panel = swarmPanel(
			"Agents",
			({ innerWidth, theme: t }) => {
				const tree = this.#buildTree();
				const lines: string[] = [];

				// Every content line is truncated to innerWidth so it occupies
				// exactly one terminal row (renderOutputBlock re-wraps anything
				// wider than width - 3, inflating the panel past the overlay
				// budget and getting the bottom border clipped).
				const fit = (line: string): string => truncateToWidth(line, innerWidth);

				const flat = this.#flattenTree(tree);
				// Tree rows are budgeted from the terminal height: the framed
				// panel takes 2 rows for its top/bottom bars, the overlay
				// reserves 2 more for its top/bottom margins, and one row each
				// goes to the "+N more" overflow marker, the trailing spacer
				// and the keybinding hint. No fixed cap — the tree grows to
				// fill the viewport.
				const treeBudget = Math.max(1, termRows - 7);
				const maxVisible = Math.min(flat.length, treeBudget);

				if (tree.length === 0) {
					lines.push(fit(t.fg("dim", "  No active agents or crews")));
				}

				for (let i = 0; i < maxVisible; i++) {
					const { node, prefix } = flat[i];
					const isSelected =
						this.#selectedPath.length > 0 && this.#selectedPath[this.#selectedPath.length - 1] === node.id;

					if (node.type === "session") {
						const cursor = isSelected ? t.fg("accent", "*") : " ";
						lines.push(fit(`${cursor}${t.bold(node.label)}`));
						continue;
					}

					const multiMark = this.#multiSelected.has(node.id) ? t.fg("accent", "\u2713 ") : "";
					const cursor = isSelected ? t.fg("accent", "\u25b6 ") : "  ";
					if (node.type === "agent" || node.type === "crew-member") {
						let glyph: string;
						if (node.type === "agent" && node.expanded !== undefined) {
							// History container agent (has persisted
							// sub-sessions): expand/collapse marker.
							glyph = t.fg("dim", node.expanded ? "\u25bc" : "\u25b6");
						} else {
							const iconStatus = AGENT_STATUS_ICON[node.status ?? "idle"] ?? "done";
							const color = iconStatus === "running" ? "accent" : iconStatus === "error" ? "error" : "dim";
							glyph = t.fg(color as "accent" | "error" | "dim", formatStatusIcon(iconStatus, t));
						}
						const maxName = Math.max(4, innerWidth - 20);
						const name = node.label.length > maxName ? `${node.label.slice(0, maxName - 1)}\u2026` : node.label;
						const unreadDot = this.#unreadAgents.has(node.agentId ?? "") ? t.fg("accent", "\u25cf ") : "";
						lines.push(fit(`${prefix}${cursor}${multiMark}${glyph} ${unreadDot}${name}`));
					} else if (node.type === "crew" || node.type === "swarm") {
						const expandIcon = node.expanded ? "\u25bc" : "\u25b6";
						const expandGlyph = t.fg("dim", expandIcon);
						const countHint = t.fg("dim", ` (${node.children?.length ?? 0})`);
						lines.push(
							fit(`${prefix}${cursor}${multiMark}${expandGlyph} ${t.fg("accent", node.label)}${countHint}`),
						);
					} else if (node.type === "history" || node.type === "history-session") {
						const expandIcon = node.expanded ? "\u25bc" : "\u25b6";
						const expandGlyph = t.fg("dim", expandIcon);
						const countHint =
							node.type === "history"
								? t.fg("dim", ` (${node.children?.length ?? 0})`)
								: node.agentCount !== undefined
									? t.fg("dim", ` ${node.agentCount} agent${node.agentCount === 1 ? "" : "s"}`)
									: "";
						const mtimeHint = node.agentMtime
							? t.fg("dim", ` \u00b7 ${formatRelativeMtime(node.agentMtime)}`)
							: "";
						lines.push(
							fit(
								`${prefix}${cursor}${multiMark}${expandGlyph} ${t.fg("accent", node.label)}${countHint}${mtimeHint}`,
							),
						);
					} else if (node.type === "action") {
						const actionIcon = node.label.startsWith("+") ? "+" : "-";
						const icon = t.fg("accent", `${actionIcon} `);
						lines.push(fit(`${prefix}${cursor}${multiMark}${icon}${t.fg("dim", node.label.slice(2).trim())}`));
					}
				}

				if (flat.length > maxVisible) {
					lines.push(fit(t.fg("dim", `  +${flat.length - maxVisible} more`)));
				}

				lines.push("");
				const hint = FOOTER_HINTS.find(candidate => visibleWidth(candidate) <= innerWidth);
				lines.push(
					t.fg("dim", hint ?? truncateToWidth(FOOTER_HINTS[FOOTER_HINTS.length - 1], innerWidth, Ellipsis.Omit)),
				);

				// Fill the remaining content rows so the bordered panel spans
				// the overlay budget: termRows minus the frame's 2 top/bottom
				// bars and the overlay's 2 vertical margins.
				for (let i = lines.length; i < termRows - 4; i++) {
					lines.push("");
				}
				// Defensive clamp: the fit() truncation above guarantees each
				// line is a single row, but if content still exceeds the budget
				// (e.g. an unexpectedly tall glyph), drop the tail so the framed
				// panel can never exceed termRows - 2 rows and the overlay
				// engine's slice(0, maxHeight) cannot amputate the bottom border.
				if (lines.length > termRows - 4) {
					lines.length = termRows - 4;
				}
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
		if (matchesKey(data, "ctrl+b") || matchesKey(data, "escape") || data === "q") {
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

		if (matchesKey(data, "down") || data === "j") {
			if (flat.length > 0) {
				const next = Math.min(flat.length - 1, currentIdx + 1);
				this.#selectedPath = [flat[next].node.id];
				this.#config.onRequestRender?.();
			}
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			if (flat.length > 0) {
				const prev = Math.max(0, currentIdx - 1);
				this.#selectedPath = [flat[prev].node.id];
				this.#config.onRequestRender?.();
			}
			return;
		}
		if (matchesKey(data, "space") || data === " ") {
			if (currentIdx >= 0) {
				const node = flat[currentIdx].node;
				if (node.type === "history" || node.type === "history-session") {
					// History rows expand/collapse on Space instead of multi-selecting.
					this.#toggleHistoryExpansion(node);
				} else if (
					node.type === "agent" ||
					node.type === "crew-member" ||
					node.type === "crew" ||
					node.type === "swarm"
				) {
					if (node.type === "agent" && !node.agentId) {
						// Synthetic "Loading…" row — not selectable.
						return;
					}
					if (this.#multiSelected.has(node.id)) {
						this.#multiSelected.delete(node.id);
					} else {
						this.#multiSelected.add(node.id);
					}
					this.#config.onRequestRender?.();
				}
			}
			return;
		}
		if (data === "d") {
			if (currentIdx >= 0) {
				const node = flat[currentIdx].node;
				if (node.type === "crew-member" && node.agentId) {
					this.#config.onRemoveMember?.(node.agentId);
				}
			}
			return;
		}
		if (data === "r") {
			if (currentIdx >= 0) {
				const node = flat[currentIdx].node;
				// r = resume (mirrors the Agent Hub's r=revive mnemonic).
				if (node.type === "history-session" && node.sessionFile) {
					this.#config.onResumeSession?.(node.sessionFile);
				}
			}
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			if (currentIdx >= 0) {
				const node = flat[currentIdx].node;
				if (node.type === "history") {
					// Toggle History expand/collapse
					this.#toggleHistoryExpansion(node);
				} else if (node.type === "history-session") {
					// Tree convention: Enter toggles the session's agent tree
					// (r resumes).
					this.#toggleHistoryExpansion(node);
				} else if (node.type === "agent" && node.sessionFile) {
					if (node.expanded !== undefined) {
						// Container agent (has persisted sub-sessions): toggle
						// its subtree, matching the crew/swarm convention.
						const key = `${node.sessionFile}:${node.agentId}`;
						if (this.#expandedHistoryAgents.has(key)) {
							this.#expandedHistoryAgents.delete(key);
						} else {
							this.#expandedHistoryAgents.add(key);
						}
						this.#config.onRequestRender?.();
					} else {
						// Leaf persisted agent: look up the cached info so the
						// caller can register + focus it.
						const info = this.#historyAgents.get(node.sessionFile)?.find(a => a.id === node.agentId);
						if (info) {
							this.#config.onOpenHistoryAgent?.(info);
						}
					}
				} else if (node.type === "crew") {
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
			return;
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
