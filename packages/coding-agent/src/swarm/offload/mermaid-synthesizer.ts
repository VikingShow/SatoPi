/**
 * MermaidSynthesizer — L3 纯模板拼接生成 Mermaid flowchart TD 文件。
 *
 * 将 MmdNode[] + MmdEdge[] 拼接为完整的 Mermaid flowchart TD 文本，
 * 原子写入 context-graph.mmd，同时归档到 mmds-archive/。
 *
 * 不调 LLM，O(n) 纯字符串拼接，耗时 < 1ms。
 */

import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { SessionStorage } from "../../session/session-storage";
import { getMmdPath, getArchivedMmdPath, getMmdsDir } from "./offload-paths";

// ============================================================================
// Forward type references (from plan-node-attributor in pipeline module)
// ============================================================================

export interface MmdNode {
	id: string;                      // "001-N1"
	label: string;                   // 节点标签
	status: "done" | "doing" | "todo" | "blocked";
	phaseId?: string;
}

export interface MmdEdge {
	from: string;
	to: string;
	type: "-->" | "-.->";
	label?: string;
}

// ============================================================================
// Types
// ============================================================================

export interface MmdSynthesizeInput {
	/** 所有节点 */
	nodes: MmdNode[];
	/** 所有边 */
	edges: MmdEdge[];
	/** 当前迭代编号 (0-based) */
	iteration: number;
	/** swarm 目录路径 */
	swarmDir: string;
	/** 图标题（可选） */
	title?: string;
	/** 任务边界类型 */
	boundaryType?: string;
}

// ============================================================================
// Status → CSS class
// ============================================================================

const STATUS_CLASS: Record<MmdNode["status"], string> = {
	done: "done",
	doing: "doing",
	todo: "todo",
	blocked: "blocked",
};

// ============================================================================
// MermaidSynthesizer
// ============================================================================

export class MermaidSynthesizer {
	readonly #storage: SessionStorage;

	constructor(storage: SessionStorage) {
		this.#storage = storage;
	}

	// ------------------------------------------------------------------------
	// Public API
	// ------------------------------------------------------------------------

	/**
	 * 合成 Mermaid flowchart TD 文件。
	 * 生成 context-graph.mmd + 归档副本，均原子写入。
	 * @returns 生成的 MMD 文本
	 */
	async synthesize(input: MmdSynthesizeInput): Promise<string> {
		const mmdText = this.generateText(input);

		// 确保 mmds 目录存在
		const mmdsDir = getMmdsDir(input.swarmDir);
		this.#storage.ensureDirSync(mmdsDir);

		// 原子写入当前活跃图
		const mmdPath = getMmdPath(input.swarmDir);
		await this.#storage.writeTextAtomic(mmdPath, mmdText);

		// 归档写入
		const archivedPath = getArchivedMmdPath(input.swarmDir, input.iteration);
		const archivedDir = path.dirname(archivedPath);
		this.#storage.ensureDirSync(archivedDir);
		await this.#storage.writeTextAtomic(archivedPath, mmdText);

		logger.info("[MermaidSynthesizer] Synthesized MMD", {
			nodes: input.nodes.length,
			edges: input.edges.length,
			iter: input.iteration,
			mmdPath,
			archivedPath,
		});

		return mmdText;
	}

	/**
	 * 生成 MMD 文本（不写入文件，供 MmdInjector 直接使用）。
	 */
	generateText(input: MmdSynthesizeInput): string {
		const { nodes, edges, iteration, title, boundaryType } = input;
		const lines: string[] = [];

		// --- YAML front matter ---
		lines.push("---");
		const displayTitle = title ?? `Swarm Context Graph — Iteration ${iteration}`;
		lines.push(`title: "${displayTitle}"`);
		lines.push(`iter: ${iteration}`);
		lines.push(`nodes: ${nodes.length}`);
		lines.push(`edges: ${edges.length}`);
		if (boundaryType) lines.push(`boundary: "${boundaryType}"`);
		lines.push("---");
		lines.push("");

		// --- Mermaid graph ---
		lines.push("flowchart TD");
		lines.push("");

		// 节点定义
		for (const node of nodes) {
			const escapedLabel = node.label
				.replace(/"/g, "#quot;")
				.replace(/\n/g, "<br/>");
			lines.push(`    ${node.id}["${escapedLabel}"]`);
		}

		if (nodes.length > 0 && edges.length > 0) {
			lines.push("");
		}

		// 边定义
		for (const edge of edges) {
			const labelPart = edge.label ? `|"${edge.label}"|` : "";
			lines.push(`    ${edge.from} ${labelPart}${edge.type} ${edge.to}`);
		}

		// class 样式
		if (nodes.length > 0) {
			lines.push("");

			// 按 status 分组
			const byStatus = new Map<string, string[]>();
			for (const node of nodes) {
				const cls = STATUS_CLASS[node.status];
				let ids = byStatus.get(cls);
				if (!ids) {
					ids = [];
					byStatus.set(cls, ids);
				}
				ids.push(node.id);
			}

			// 生成 class 赋值
			for (const [cls, ids] of byStatus) {
				if (ids.length === 0) continue;
				if (ids.length === 1) {
					lines.push(`    class ${ids[0]} ${cls}`);
				} else {
					lines.push(`    class ${ids.join(",")} ${cls}`);
				}
			}
		}

		return lines.join("\n") + "\n";
	}
}
