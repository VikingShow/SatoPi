/**
 * ReporterElection — Agent 间选举 Reporter
 *
 * 替换 curtain-runner.ts 的硬编码 Reporter 创建。
 * 基于贡献度 + 互评选出最佳 Reporter 和 Deputy Reporter。
 *
 * 评分维度:
 *   - tasksCompleted (权重 0.4): 完成的任务数
 *   - codeLinesChanged (权重 0.2): 修改的代码行数
 *   - peerVotes (权重 0.4): 其他 agent 的投票
 */

import { IrcBus } from "../../irc/bus";
import { AgentChannel } from "../channel/agent-channel";
import type { ActivityLogger } from "../hooks/activity-logger";
import { logger } from "@oh-my-pi/pi-utils";

// ============================================================================
// Types
// ============================================================================

export interface ContributionData {
	agentId: string;
	name: string;
	/** Number of tasks completed */
	tasksCompleted: number;
	/** Number of lines changed */
	codeLinesChanged: number;
}

export interface ElectionResult {
	/** Elected Reporter ID */
	reporterId: string;
	/** Deputy Reporter IDs (top 2 after reporter) */
	deputyIds: string[];
	/** Full score breakdown per agent */
	scores: Map<string, { total: number; tasks: number; code: number; votes: number }>;
}

export interface ElectionConfig {
	/** Agent contributions */
	contributions: ContributionData[];
	/** Agent IDs eligible for election */
	eligibleIds: string[];
	/** Vote collection timeout in ms (default 15s) */
	timeoutMs?: number;
}

// ============================================================================
// ReporterElection
// ============================================================================

export class ReporterElection {
	readonly #ircBus: IrcBus;
	readonly #activityLogger?: ActivityLogger;

	constructor(ircBus: IrcBus, activityLogger?: ActivityLogger) {
		this.#ircBus = ircBus;
		this.#activityLogger = activityLogger;
	}

	/**
	 * Conduct reporter election among agents.
	 */
	async elect(config: ElectionConfig): Promise<ElectionResult> {
		const { contributions, eligibleIds, timeoutMs = 15_000 } = config;

		if (eligibleIds.length <= 1) {
			// Single agent: automatic winner
			const id = eligibleIds[0];
			return {
				reporterId: id,
				deputyIds: [],
				scores: new Map([[id, { total: 1, tasks: 1, code: 0, votes: 0 }]]),
			};
		}

		logger.info("[ReporterElection] Starting election", {
			candidates: eligibleIds.length,
		});

		// 1. Collect peer votes via IRC query
		const channel = new AgentChannel(
			this.#ircBus,
			{ agents: eligibleIds, observers: [] },
			this.#activityLogger,
		);

		let peerVotes: Map<string, number> = new Map();
		try {
			const question = [
				"**Reporter Election** — Vote for who should report to the human!",
				"",
				"Consider:",
				"- Who completed the most work?",
				"- Whose output was highest quality?",
				"- Who communicates most clearly?",
				"",
				"Reply with: `VOTE: <agent-id>` (just the ID of your chosen reporter)",
			].join("\n");

			await channel.broadcast("system", question);

			const responses = await this.#ircBus.collectResponses(
				"system", eligibleIds,
				{ from: "system", body: question },
				{}, timeoutMs,
			);

			// Tally votes
			for (const [, msg] of responses) {
				const match = msg.body.match(/VOTE:\s*(\S+)/i);
				if (match) {
					const votedFor = match[1];
					peerVotes.set(votedFor, (peerVotes.get(votedFor) ?? 0) + 1);
				}
			}

			this.#activityLogger?.logBroadcast("system", `Election: collected ${peerVotes.size} votes`);
		} catch (err) {
			logger.warn("[ReporterElection] Vote collection failed — using contribution-only scores", {
				error: String(err),
			});
		}

		// 2. Compute final scores
		const allTasks = contributions.reduce((s, c) => s + c.tasksCompleted, 0) || 1;
		const allCode = contributions.reduce((s, c) => s + c.codeLinesChanged, 0) || 1;

		const scores = new Map<string, { total: number; tasks: number; code: number; votes: number }>();

		for (const c of contributions) {
			const tasksScore = (c.tasksCompleted / allTasks) * 0.4;
			const codeScore = (c.codeLinesChanged / allCode) * 0.2;
			const voteScore = ((peerVotes.get(c.agentId) ?? 0) / Math.max(1, peerVotes.size)) * 0.4;
			const total = tasksScore + codeScore + voteScore;

			scores.set(c.agentId, {
				total,
				tasks: tasksScore,
				code: codeScore,
				votes: voteScore,
			});
		}

		// 3. Rank by total score
		const ranked = [...scores.entries()]
			.sort((a, b) => b[1].total - a[1].total);

		const reporterId = ranked[0][0];
		const deputyIds = ranked.slice(1, 3).map(([id]) => id);

		logger.info("[ReporterElection] Election complete", {
			reporter: reporterId,
			deputies: deputyIds,
		});

		return { reporterId, deputyIds, scores };
	}
}
