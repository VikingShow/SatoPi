/**
 * RoleRoundtable — LLM 驱动的 Agent 角色分配
 *
 * 替换 stage-controller.ts 的纯算法 #assignRoles()。
 * 选定 agent 通过结构化多轮讨论协商角色分配。
 *
 * 流程:
 *   1. 构建讨论提示（plan tasks + required roles）
 *   2. CommChannel.roundtable 多轮讨论
 *   3. LLM 解析讨论结果 → RoleAssignment[]
 *   4. 失败时 fallback 到算法分配
 *
 * @deprecated Use {@link CommChannel.roundtable} directly via
 * `CommBus.groupChannel(name, agentIds).roundtable(topic, config)`.
 * `StageBehavior` already uses this pattern for role assignment.
 * This class is retained for callers that have not yet migrated to the v3
 * PhaseBehavior architecture.
 *
 * @remarks Roundtable execution now delegates to {@link CommChannel.roundtable}
 * which internally uses the standalone {@link runRoundtable} pure function
 * with Jaccard-based convergence detection.
 */

// ============================================================================
// Types
// ============================================================================

export interface RoleCandidate {
	agentId: string;
	name: string;
	preferredRoles: string[];
}

export interface RoleAssignment {
	agentId: string;
	role: string;
	reason?: string;
}

export interface RoundtableConfig {
	/** Available roles from plan.md tasks */
	availableRoles: string[];
	/** Agent candidates for discussion */
	candidates: RoleCandidate[];
	/** Discussion rounds (default 2) */
	rounds?: number;
	/** Per-round timeout in ms (default 30s) */
	timeoutMs?: number;
}

/**
 * Fallback algorithm-based role assignment (preserved from original #assignRoles).
 */
export function fallbackRoleAssign(candidates: RoleCandidate[], availableRoles: string[]): RoleAssignment[] {
	const assignments: RoleAssignment[] = [];

	// First pass: agents with strong role preference
	for (const agent of candidates) {
		const preferred = agent.preferredRoles.find(r => availableRoles.includes(r));
		if (preferred && !assignments.find(a => a.role === preferred)) {
			assignments.push({ agentId: agent.agentId, role: preferred });
		}
	}

	// Second pass: round-robin remaining agents to remaining roles
	const remaining = candidates.filter(a => !assignments.find(ra => ra.agentId === a.agentId));
	const remainingRoles = availableRoles.filter(r => !assignments.find(a => a.role === r));

	for (let i = 0; i < remaining.length; i++) {
		const role = remainingRoles[i % remainingRoles.length] ?? "worker";
		assignments.push({ agentId: remaining[i].agentId, role });
	}

	return assignments;
}
