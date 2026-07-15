/**
 * BidAssigner — 去中心化自组织任务分配。
 *
 * 骑士通过能力元数据 + 自信度对任务清单竞价，分配采用贪心算法。
 * 无人认领的任务上报给 Merlin 决定。包含涌现行为观测。
 */

// ============================================================================
// Types
// ============================================================================

export interface KnightCapability {
	id: string;
	capabilities: string[];
	confidence: number; // 0.0-1.0
}

export interface TaskItem {
	id: string;
	description: string;
	tags: string[]; // 任务特征标签 ["api", "database", "frontend", ...]
	priority: number; // 1=最高, 3=最低
}

export interface Bid {
	knightId: string;
	taskId: string;
	matchScore: number;
	rationale: string;
}

export interface Assignment {
	taskId: string;
	knightId: string;
	matchScore: number;
}

export interface AssignmentResult {
	assignments: Assignment[];
	orphanedTasks: TaskItem[];
	unassignedKnights: string[];
}

export interface EmergenceReport {
	crossCapabilityTasks: string[]; // 骑士超出原生能力执行的任务
	collaborativeJointTasks: string[]; // 联合任务
	loadBalanceVariance: number; // 负载方差（越低越好）
	orphanedTasks: TaskItem[]; // 无人认领
}

// ============================================================================
// BidAssigner
// ============================================================================

export class BidAssigner {
	/**
	 * 执行贪心分配：按优先级排序任务 → 为每个任务选择最佳骑士。
	 */
	assign(knights: KnightCapability[], tasks: TaskItem[]): AssignmentResult {
		// Sort by priority descending (1 is highest)
		const sorted = [...tasks].sort((a, b) => a.priority - b.priority);
		const assignedKnights = new Set<string>();
		const assignments: Assignment[] = [];
		const orphaned: TaskItem[] = [];

		for (const task of sorted) {
			const bids = this.#collectBids(knights, task);
			// Skip knights already assigned more important tasks
			const availableBids = bids.filter((b) => !assignedKnights.has(b.knightId));

			if (availableBids.length === 0) {
				orphaned.push(task);
				continue;
			}

			// Greedy: pick highest match score
			availableBids.sort((a, b) => b.matchScore - a.matchScore);
			const best = availableBids[0];
			assignedKnights.add(best.knightId);
			assignments.push({
				taskId: task.id,
				knightId: best.knightId,
				matchScore: best.matchScore,
			});
		}

		const unassignedKnights = knights
			.map((k) => k.id)
			.filter((id) => !assignedKnights.has(id));

		return { assignments, orphanedTasks: orphaned, unassignedKnights };
	}

	/**
	 * 收集所有骑士对某个 task 的竞价。
	 */
	#collectBids(knights: KnightCapability[], task: TaskItem): Bid[] {
		return knights
			.map((k) => {
				const score = this.#computeMatchScore(k, task);
				return {
					knightId: k.id,
					taskId: task.id,
					matchScore: score,
					rationale: `capabilities: [${k.capabilities.join(", ")}] → tags: [${task.tags.join(", ")}]`,
				};
			})
			.filter((b) => b.matchScore > 0);
	}

	/**
	 * 计算骑士能力与任务标签的匹配度。
	 *
	 * 匹配度 = (命中标签数 + tag↔capability语义近似) / 总标签数
	 * 乘以骑士自信度加权。
	 */
	#computeMatchScore(knight: KnightCapability, task: TaskItem): number {
		const caps = new Set(knight.capabilities.map((c) => c.toLowerCase()));
		const tags = task.tags.map((t) => t.toLowerCase());

		let hits = 0;
		for (const tag of tags) {
			if (caps.has(tag)) {
				hits++;
			}
			// Partial match: capability contains tag or vice-versa
			else if (knight.capabilities.some((c) => c.includes(tag) || tag.includes(c))) {
				hits += 0.5;
			}
		}
		if (hits === 0) return 0;
		return (hits / tags.length) * knight.confidence;
	}

	// -------------------------------------------------------------------
	// Emergence observation
	// -------------------------------------------------------------------

	/**
	 * 分析分配结果中的涌现行为：角色流动、负载均衡、无人认领。
	 */
	observeEmergence(
		result: AssignmentResult,
		knights: KnightCapability[],
		tasks: TaskItem[],
	): EmergenceReport {
		const knightCapMap = new Map(knights.map((k) => [k.id, new Set(k.capabilities)]));
		const taskTagMap = new Map(tasks.map((t) => [t.id, new Set(t.tags)]));
		const crossCapabilityTasks: string[] = [];
		const loadCounts = new Map<string, number>();

		for (const a of result.assignments) {
			loadCounts.set(a.knightId, (loadCounts.get(a.knightId) ?? 0) + 1);

			const caps = knightCapMap.get(a.knightId);
			const tags = taskTagMap.get(a.taskId);
			if (caps && tags) {
				const hasNativeMatch = [...tags].some((t) => caps.has(t));
				if (!hasNativeMatch) {
					crossCapabilityTasks.push(a.taskId);
				}
			}
		}

		// Load balance variance
		const loads = [...loadCounts.values()];
		const mean = loads.reduce((a, b) => a + b, 0) / (loads.length || 1);
		const variance =
			loads.length > 0
				? loads.reduce((sum, l) => sum + (l - mean) ** 2, 0) / loads.length
				: 0;

		return {
			crossCapabilityTasks,
			collaborativeJointTasks: [], // Populated by roundtable observation
			loadBalanceVariance: variance,
			orphanedTasks: result.orphanedTasks,
		};
	}
}
