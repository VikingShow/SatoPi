/**
 * PlanNodeAttributor — L2 节点归因器
 *
 * 将 L1.5 去重后的摘要条目归因到 plan.md 的 phase 节点，
 * 分配 Mermaid node_id，提出边关系。
 *
 * node_id 格式: {iter三位数}-N{序号}，如 "001-N1"
 */

import { logger } from "@oh-my-pi/pi-utils";

// ============================================================================
// Types
// ============================================================================

export interface PlanPhase {
	id: string;            // "phase-1"
	title: string;         // "API Layer"
	number: number;        // 1
	taskIds: string[];     // ["1.1", "1.2"]
	status: "todo" | "doing" | "done";
}

export interface AttributionEntry {
	agentId: string;
	summary: string;
	score: number;
	iteration: number;
	phaseHint?: string;
}

export interface AttributionInput {
	/** L1.5 处理后的条目 */
	entries: AttributionEntry[];
	/** 从 plan.md 解析的 phase 列表 */
	phases: PlanPhase[];
	/** 当前迭代编号 */
	iteration: number;
	/** 已有的 MMD node_id 列表（增量归因用） */
	existingNodeIds?: string[];
}

export interface MmdNode {
	id: string;                      // "001-N1"
	label: string;                   // 节点标签
	status: "done" | "doing" | "todo" | "blocked";
	phaseId?: string;                // 关联的 phase
}

export interface MmdEdge {
	from: string;                    // 源 node_id
	to: string;                      // 目标 node_id
	type: "-->" | "-.->";           // 实线(顺序依赖) / 虚线(审查关系)
	label?: string;
}

export interface AttributionOutput {
	nodes: MmdNode[];
	edges: MmdEdge[];
	/** agentId → node_id 映射 */
	entryNodeMap: Map<string, string>;
}

// ============================================================================
// Helpers
// ============================================================================

function padIter(iter: number): string {
	return String(iter).padStart(3, "0");
}

function scoreToStatus(score: number): MmdNode["status"] {
	if (score >= 7) return "done";
	if (score >= 4) return "doing";
	return "blocked";
}

// ============================================================================
// PlanNodeAttributor
// ============================================================================

export class PlanNodeAttributor {
	#nodeCounter = 0;

	/**
	 * 将 L1 条目归因到 plan.md phase 节点。
	 */
	attribute(input: AttributionInput): AttributionOutput {
		const { entries, phases, iteration, existingNodeIds = [] } = input;
		const iterPrefix = padIter(iteration);

		const nodes: MmdNode[] = [];
		const edges: MmdEdge[] = [];
		const entryNodeMap = new Map<string, string>();

		// 构建 phase 查找表: phaseHint → phase
		const phaseByTitle = new Map<string, PlanPhase>();
		const phaseById = new Map<string, PlanPhase>();
		for (const p of phases) {
			phaseByTitle.set(p.title.toLowerCase(), p);
			phaseById.set(p.id, p);
		}

		let prevNodeId: string | null = null;

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const nodeSeq = ++this.#nodeCounter;
			const nodeId = `${iterPrefix}-N${nodeSeq}`;

			// 跳过已有节点
			if (existingNodeIds.includes(nodeId)) continue;

			// 确定 phase 归属
			let phaseId: string | undefined;
			let phaseTitle = "未知阶段";
			if (entry.phaseHint) {
				const matched = phaseByTitle.get(entry.phaseHint.toLowerCase());
				if (matched) {
					phaseId = matched.id;
					phaseTitle = matched.title;
				}
			}

			// 如果没有 phaseHint，按顺序分配 phase
			if (!phaseId && phases.length > 0) {
				const idx = (this.#nodeCounter - 1) % phases.length;
				const p = phases[idx];
				phaseId = p.id;
				phaseTitle = p.title;
			}

			const status = scoreToStatus(entry.score);

			// 构建节点标签（多行）
			const label = [
				`${phaseTitle}`,
				`status: ${status}`,
				`score: ${entry.score}/10`,
				`summary: ${entry.summary.slice(0, 60)}`,
			].join("<br/>");

			nodes.push({ id: nodeId, label, status, phaseId });
			entryNodeMap.set(entry.agentId, nodeId);

			// 建立边关系：顺序串接
			if (prevNodeId) {
				edges.push({
					from: prevNodeId,
					to: nodeId,
					type: "-->",
				});
			}
			prevNodeId = nodeId;
		}

		logger.debug("[PlanNodeAttributor] Attribution complete", {
			iteration,
			nodes: nodes.length,
			edges: edges.length,
			entryNodeMap: Object.fromEntries(entryNodeMap),
		});

		return { nodes, edges, entryNodeMap };
	}

	reset(): void {
		this.#nodeCounter = 0;
	}
}
