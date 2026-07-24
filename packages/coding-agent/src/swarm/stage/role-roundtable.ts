/**
 * RoleRoundtable — LLM 驱动的 Agent 角色分配
 *
 * 替换 stage-controller.ts 的纯算法 #assignRoles()。
 * 选定 agent 通过结构化多轮讨论协商角色分配。
 *
 * 流程:
 *   1. 构建讨论提示（plan tasks + required roles）
 *   2. AgentChannel.conductRoundtable 多轮讨论
 *   3. LLM 解析讨论结果 → RoleAssignment[]
 *   4. 失败时 fallback 到算法分配
 */

import { IrcBus, type IrcMessage } from "../../irc/bus";
import { AgentChannel } from "../channel/agent-channel";
import type { ActivityLogger } from "../hooks/activity-logger";
import { logger } from "@oh-my-pi/pi-utils";

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

// ============================================================================
// RoleRoundtable
// ============================================================================

export class RoleRoundtable {
	readonly #ircBus: IrcBus;
	readonly #activityLogger?: ActivityLogger;

	constructor(ircBus: IrcBus, activityLogger?: ActivityLogger) {
		this.#ircBus = ircBus;
		this.#activityLogger = activityLogger;
	}

	/**
	 * Conduct role assignment roundtable.
	 *
	 * @returns RoleAssignment[] — who gets which role
	 * @returns null — roundtable failed, caller should fallback to algorithm
	 */
	async negotiateRoles(config: RoundtableConfig): Promise<RoleAssignment[] | null> {
		const { availableRoles, candidates, rounds = 2, timeoutMs = 30_000 } = config;

		if (candidates.length <= 1) {
			// Single agent: no roundtable needed
			return [{ agentId: candidates[0].agentId, role: availableRoles[0] ?? "developer" }];
		}

		const agentIds = candidates.map(c => c.agentId);

		// Build channel for this roundtable
		const channel = new AgentChannel(
			this.#ircBus,
			{ agents: agentIds, observers: [] },
			this.#activityLogger,
		);

		logger.info("[RoleRoundtable] Starting negotiation", {
			agents: candidates.length, roles: availableRoles.length, rounds,
		});

		// Build discussion topic
		const roleList = availableRoles.join(", ");
		const topic = [
			"**Role Assignment Roundtable**",
			"",
			`The project requires these roles: ${roleList}`,
			"",
			"The following agents are available:",
			...candidates.map(c =>
				`  - ${c.name} (prefers: ${c.preferredRoles.join(", ") || "none"})`,
			),
			"",
			"**Task**: Negotiate and decide which agent takes which role.",
			`There are ${candidates.length} agents and ${availableRoles.length} roles.`,
			"One agent may take at most one role.",
			"",
			"State your preferred role and why you're best suited.",
			"Consider others' preferences and reach consensus.",
			"",
			"After discussion, output your final assignment as:",
			"```json",
			'{"assignments": [{"agentId":"...","role":"...","reason":"..."}]}',
			"```",
		].join("\n");

		try {
			// Round 1: each agent states their preference
			await channel.broadcast("system", topic);

			const bus = this.#ircBus;
			const allResponses: IrcMessage[] = [];

			for (let r = 0; r < rounds; r++) {
				const prompt = r === 0
					? `[ROUNDTABLE R1/${rounds}] State your preferred role and reasoning.`
					: `[ROUNDTABLE R${r + 1}/${rounds}] Respond to the discussion. Consider others' preferences.`;

				await channel.broadcast("system", prompt);

				const responses = await bus.collectResponses(
					"system", agentIds,
					{ from: "system", body: prompt },
					{}, timeoutMs,
				);

				for (const [, msg] of responses) {
					allResponses.push(msg);
				}

				// Early exit: if all agents agree, skip remaining rounds
				if (r < rounds - 1) {
					const parsed = this.#parseAssignments(allResponses, candidates);
					if (parsed && parsed.length >= availableRoles.length) break;
				}
			}

			// Parse final results
			const assignments = this.#parseAssignments(allResponses, candidates);
			if (assignments && assignments.length > 0) {
				logger.info("[RoleRoundtable] Negotiation complete", {
					assignments: assignments.map(a => `${a.agentId}=${a.role}`),
				});
				return assignments;
			}

			logger.warn("[RoleRoundtable] No consensus reached — fallback to algorithm");
			return null;
		} catch (err) {
			logger.warn("[RoleRoundtable] Error during negotiation", { error: String(err) });
			return null;
		}
	}

	/**
	 * Parse roundtable responses into structured role assignments.
	 * Tries to extract JSON block from discussion transcript.
	 */
	#parseAssignments(
		responses: IrcMessage[],
		candidates: RoleCandidate[],
	): RoleAssignment[] | null {
		// Try to find JSON assignments in any response
		for (const msg of responses) {
			const jsonMatch = msg.body.match(/```json\s*\n?([\s\S]*?)```/);
			if (jsonMatch) {
				try {
					const parsed = JSON.parse(jsonMatch[1]);
					if (parsed.assignments && Array.isArray(parsed.assignments)) {
						const valid: RoleAssignment[] = [];
						const seenRoles = new Set<string>();
						for (const a of parsed.assignments) {
							if (a.agentId && a.role && !seenRoles.has(a.role)) {
								valid.push({ agentId: a.agentId, role: a.role, reason: a.reason });
								seenRoles.add(a.role);
							}
						}
						if (valid.length > 0) return valid;
					}
				} catch {
					// JSON parse failed, continue to next heuristic
				}
			}
		}

		// Heuristic: match agent mentions with role mentions
		const assignments: RoleAssignment[] = [];
		const allText = responses.map(r => r.body.toLowerCase()).join(" ");

		for (const c of candidates) {
			const nameLower = c.name.toLowerCase();
			if (allText.includes(nameLower)) {
				// Find the role mentioned near this agent's name
				for (const preferred of c.preferredRoles) {
					if (allText.includes(preferred.toLowerCase())) {
						assignments.push({ agentId: c.agentId, role: preferred });
						break;
					}
				}
			}
		}

		return assignments.length > 0 ? assignments : null;
	}
}

/**
 * Fallback algorithm-based role assignment (preserved from original #assignRoles).
 */
export function fallbackRoleAssign(
	candidates: RoleCandidate[],
	availableRoles: string[],
): RoleAssignment[] {
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
