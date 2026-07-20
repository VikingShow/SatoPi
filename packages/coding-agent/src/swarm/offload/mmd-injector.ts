/**
 * MmdInjector — 构建三种分层 MMD 视图。
 *
 * - Worker 局部视图：只看自己负责的 phase 节点 + 上游已完成依赖
 * - Cloner 全局审查视图：所有 Worker 执行节点 + 审查节点 + findings
 * - LoopController 全景视图：完整 MMD 图 + 历史迭代归档引用
 *
 * 不解析 Mermaid AST，用简单正则字符串匹配过滤。
 */

import { logger } from "@oh-my-pi/pi-utils";

// ============================================================================
// Types
// ============================================================================

export interface MmdInjectConfig {
	/** 完整 MMD 图文本 */
	fullMmd: string;
	/** Worker agent 负责的 phase ID 列表（用于局部视图过滤） */
	workerPhases?: string[];
	/** 是否启用注入 */
	enabled: boolean;
}

export interface MmdView {
	/** 目标 agent 类型 */
	agentType: "worker" | "cloner" | "orchestrator";
	/** 该视图的 MMD 片段 */
	mmdFragment: string;
	/** 文本摘要（fallback 用） */
	summaryText: string;
	/** 完整的 XML 注入块 */
	injectBlock: string;
}

// ============================================================================
// MmdInjector
// ============================================================================

export class MmdInjector {
	// ------------------------------------------------------------------------
	// Public API
	// ------------------------------------------------------------------------

	/**
	 * 构建 Worker 局部视图。
	 * Worker 只看自己负责的 phase 节点 + 上游已完成依赖节点。
	 */
	buildWorkerView(fullMmd: string, workerPhases: string[]): MmdView {
		if (!workerPhases || workerPhases.length === 0) {
			return this.buildClonerView(fullMmd); // 无 phase 信息时退化为全局视图
		}

		const filtered = this.filterByPhases(fullMmd, workerPhases);

		const summaryText = `Worker 负责 phase: ${workerPhases.join(", ")}`;

		const injectBlock = [
			"<current_swarm_context>",
			`  <!-- Worker 局部视图: phases = ${workerPhases.join(", ")} -->`,
			filtered || fullMmd.slice(0, 500), // fallback 到截断的完整图
			"</current_swarm_context>",
		].join("\n");

		logger.debug("[MmdInjector] Built Worker view", {
			phases: workerPhases,
			fragmentLen: filtered.length,
		});

		return {
			agentType: "worker",
			mmdFragment: filtered,
			summaryText,
			injectBlock,
		};
	}

	/**
	 * 构建 Cloner 全局审查视图。
	 * Cloner 看所有 Worker 执行节点 + 本轮审查节点 + 历史 findings。
	 */
	buildClonerView(fullMmd: string): MmdView {
		const summaryText = "Cloner 全局审查视图（所有 Worker 执行节点 + 审查节点）";

		const injectBlock = [
			"<current_swarm_context>",
			"  <!-- Cloner 全局审查视图 -->",
			fullMmd,
			"</current_swarm_context>",
		].join("\n");

		logger.debug("[MmdInjector] Built Cloner view", {
			fragmentLen: fullMmd.length,
		});

		return {
			agentType: "cloner",
			mmdFragment: fullMmd,
			summaryText,
			injectBlock,
		};
	}

	/**
	 * 构建 LoopController 全景编排视图。
	 * 完整 MMD 图 + 可附加历史迭代归档引用。
	 */
	buildFullView(fullMmd: string, historicalRefs?: string[]): MmdView {
		const summaryText = "LoopController 全景编排视图（完整 MMD 图）";

		const parts = [
			"<current_swarm_context>",
			"  <!-- LoopController 全景视图 -->",
			fullMmd,
		];

		// 附加历史迭代归档引用
		if (historicalRefs && historicalRefs.length > 0) {
			parts.push("  <!-- 历史迭代 MMD 归档引用 -->");
			for (const ref of historicalRefs) {
				parts.push(`  <!-- ${ref} -->`);
			}
		}

		parts.push("</current_swarm_context>");
		const injectBlock = parts.join("\n");

		logger.debug("[MmdInjector] Built Full view", {
			fragmentLen: fullMmd.length,
			historicalRefs: historicalRefs?.length ?? 0,
		});

		return {
			agentType: "orchestrator",
			mmdFragment: fullMmd,
			summaryText,
			injectBlock,
		};
	}

	// ------------------------------------------------------------------------
	// Filtering
	// ------------------------------------------------------------------------

	/**
	 * 按 phase ID 过滤 MMD 图中的节点。
	 * 保留匹配 phaseId 的节点行 + 与该节点相关的边 + class 行。
	 *
	 * 当前实现：简单的逐行正则匹配。
	 */
	filterByPhases(fullMmd: string, phaseIds: string[]): string {
		if (!fullMmd || phaseIds.length === 0) return fullMmd;

		const lines = fullMmd.split("\n");
		const phaseSet = new Set(phaseIds);

		// 第一遍：找到所有匹配 phase 的 node_id
		const matchedNodeIds = new Set<string>();

		for (const line of lines) {
			for (const phaseId of phaseIds) {
				if (line.includes(phaseId)) {
					// 提取 node_id（格式: XXXX-NNN）
					const nodeMatch = line.match(/^(\d{3,}-[A-Za-z]?\d+)/);
					if (nodeMatch) {
						matchedNodeIds.add(nodeMatch[1]);
					}
				}
			}
		}

		// 第二遍：保留相关行
		const result: string[] = [];
		let inFrontMatter = false;

		for (const line of lines) {
			// 始终保留 front matter
			if (line.startsWith("---")) {
				inFrontMatter = !inFrontMatter;
				result.push(line);
				continue;
			}
			if (inFrontMatter || line.startsWith("flowchart") || line.startsWith("title:")) {
				result.push(line);
				continue;
			}

			// 保留匹配节点的行
			let keep = false;
			for (const nodeId of matchedNodeIds) {
				if (line.startsWith(nodeId + " ") || line.startsWith(nodeId + "[") || line.startsWith(nodeId + "|")) {
					keep = true;
					break;
				}
				// 保留边：from=nodeId 或 to=nodeId
				if (line.includes(` ${nodeId} `) || line.includes(` ${nodeId}"`)) {
					keep = true;
					break;
				}
			}

			// 保留 class 行
			if (line.startsWith("    class ")) {
				for (const nodeId of matchedNodeIds) {
					if (line.includes(nodeId)) {
						keep = true;
						break;
					}
				}
			}

			if (keep) result.push(line);
		}

		return result.length > 2 ? result.join("\n") : fullMmd.slice(0, 500);
	}
}
