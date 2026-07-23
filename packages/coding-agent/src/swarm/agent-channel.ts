/**
 * AgentChannel — Agent 群聊通信层。
 *
 * 基于 IrcBus 封装，提供：
 * - broadcast: 向全体 agent 广播（秘密抄送全体 reviewer）
 * - sub-group: agent 之间拉小群协商
 * - interrupt: reviewer 接入指导特定 agent
 * - monitoring: reviewer 订阅所有 agent 消息流
 *
 * Agent 不知道 reviewer 的存在 —— 所有 reviewer 消息通过 suppressRelay 秘密送达。
 */

import type { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { ActivityLogger } from "./activity-logger";

// ============================================================================
// Types
// ============================================================================

export interface AgentMessage {
	from: string;
	body: string;
	timestamp: number;
}

export interface AgentChannelConfig {
	/** Initial agent agent IDs. */
	agents: string[];
	/** Reviewer agent IDs (secret subscribers). */
	reviewers: string[];
}

// ============================================================================
// Nomination types
// ============================================================================

export interface Nomination {
	/** Who made the nomination. */
	nominator: string;
	/** Who they nominated. */
	nominee: string;
}

export interface NominationResult {
	/** Elected agent ID, or null if no consensus. */
	elected: string | null;
	/** All nominations cast, grouped by nominee. */
	votes: Record<string, string[]>;
	round: number;
}

// ============================================================================
export class AgentChannel {
	readonly #ircBus: IrcBus;
	readonly #agents = new Set<string>();
	readonly #reviewers = new Set<string>();
	readonly #groups = new Map<string, Set<string>>();
	#nominationRound = 0;
	#nominations: Nomination[] = [];
	readonly #activityLogger?: ActivityLogger;

	constructor(ircBus: IrcBus, config: AgentChannelConfig, activityLogger?: ActivityLogger) {
		this.#ircBus = ircBus;
		this.#activityLogger = activityLogger;
		for (const w of config.agents) this.#agents.add(w);
		for (const c of config.reviewers) this.#reviewers.add(c);
	}

	// -- lifecycle -------------------------------------------------------

	get agents(): ReadonlySet<string> {
		return this.#agents;
	}
	get reviewers(): ReadonlySet<string> {
		return this.#reviewers;
	}

	addAgent(agentId: string): void {
		this.#agents.add(agentId);
	}

	removeAgent(agentId: string): void {
		this.#agents.delete(agentId);
		// Remove from all subgroups
		for (const [, members] of this.#groups) {
			members.delete(agentId);
		}
	}

	// -- messaging -------------------------------------------------------

	/**
	 * Broadcast to ALL agents (visible) + secret-CC all reviewers.
	 * Agents see the message as coming from `from`, addressed to the agent group.
	 * Reviewers receive a copy silently.
	 */
	async broadcast(from: string, body: string): Promise<void> {
		this.#activityLogger?.logBroadcast(from, body);
		const agentList = [...this.#agents];

		// Send to all agents in parallel
		await Promise.all(agentList.map(to => this.#ircBus.send({ from, to, body })));

		// Secret CC to reviewers — suppressed from UI relay
		await Promise.all([...this.#reviewers].map(to => this.#ircBus.send({ from, to, body }, { suppressRelay: true })));
	}

	// -- sub-groups ------------------------------------------------------

	/**
	 * Create a named sub-group.
	 * Members are agent IDs; reviewers automatically monitor all sub-groups.
	 */
	createSubGroup(name: string, members: string[]): void {
		// Validate members are agents
		const valid = members.filter(m => this.#agents.has(m));
		this.#groups.set(name, new Set(valid));
	}

	/**
	 * Send to a named sub-group. Members + all reviewers receive it.
	 */
	async sendToSubGroup(groupName: string, from: string, body: string): Promise<void> {
		this.#activityLogger?.logSubGroup(groupName, from, body);
		const members = this.#groups.get(groupName);
		if (!members || members.size === 0) return;

		const memberList = [...members];
		await Promise.all(memberList.map(to => this.#ircBus.send({ from, to, body })));

		// Reviewers monitor all sub-groups
		await Promise.all([...this.#reviewers].map(to => this.#ircBus.send({ from, to, body }, { suppressRelay: true })));
	}

	addToSubGroup(groupName: string, agentId: string): void {
		if (!this.#agents.has(agentId)) return;
		const group = this.#groups.get(groupName);
		if (group) group.add(agentId);
	}

	removeFromSubGroup(groupName: string, agentId: string): void {
		this.#groups.get(groupName)?.delete(agentId);
	}

	// -- reviewer interrupt ------------------------------------------------

	/**
	 * Reviewer 介入指导一个 agent（steering）。
	 * Agent 收到高优先级消息，调整方向但不停止。
	 */
	async interrupt(reviewerId: string, agentId: string, reason: string): Promise<void> {
		this.#activityLogger?.logSteering(reviewerId, agentId, reason);
		await this.#ircBus.send({
			from: reviewerId,
			to: agentId,
			body: `[CLONER STEERING] ${reason}`,
		});
	}

	async broadcastSteering(reviewerId: string, body: string): Promise<void> {
		this.#activityLogger?.logSteering(reviewerId, "all", body);
		await Promise.all(
			[...this.#agents].map(to => this.#ircBus.send({ from: reviewerId, to, body: `[CLONER STEERING] ${body}` })),
		);
	}

	// -- nomination --------------------------------------------------------

	/**
	 * Start a new nomination round. Clears any previous nomination state.
	 * Agents are expected to produce `## Nomination` sections in their output
	 * for this round; those are collected and fed to {@link tally}.
	 */
	startNomination(round: number): void {
		this.#nominationRound = round;
		this.#nominations = [];
	}

	/** Record a nomination from a agent. Self-nominations are ignored. */
	processNomination(nominator: string, nominee: string): void {
		if (nominator === nominee) return;
		if (!this.#agents.has(nominator)) return;
		if (!this.#agents.has(nominee)) return;
		this.#nominations.push({ nominator, nominee });
	}

	/**
	 * Build a nomination prompt for agents at the start of a round.
	 * Injected into the agent task before execution begins.
	 */
	buildNominationPrompt(): string {
		const agentList = [...this.#agents].join(", ");
		return [
			`## Reviewer Election (Round ${this.#nominationRound})`,
			``,
			`At the END of your output, include a \`## Nomination\` section with ONE line:`,
			``,
			`\`\`\``,
			`## Nomination`,
			`nominated: <agent-id>`,
			`reason: <one sentence explaining why>`,
			`\`\`\``,
			``,
			`Available agents: ${agentList}`,
			`You may nominate any agent (including yourself).`,
			`The agent with the most nominations becomes the Reviewer for this round.`,
			`The Reviewer will NOT write code — they review all outputs and produce a Round Summary.`,
			`Choose the agent best suited to assess this round's work against the plan's acceptance criteria.`,
		].join("\n");
	}

	/**
	 * Tally nominations and elect a reviewer.
	 * Returns the elected agent ID, or null if no nominations were cast.
	 * Ties are broken by choosing the first nominee to reach the highest count.
	 */
	tally(): NominationResult {
		const votes: Record<string, string[]> = {};
		for (const nom of this.#nominations) {
			if (!votes[nom.nominee]) votes[nom.nominee] = [];
			votes[nom.nominee].push(nom.nominator);
		}

		let elected: string | null = null;
		let bestCount = 0;
		for (const [nominee, nominators] of Object.entries(votes)) {
			if (nominators.length > bestCount) {
				bestCount = nominators.length;
				elected = nominee;
			}
		}

		const result = {
			elected: bestCount > 0 ? elected : null,
			votes,
			round: this.#nominationRound,
		};
		this.#activityLogger?.logNomination(this.#nominationRound, result.elected, votes);
		return result;
	}

	/**
	 * Build the reviewer-specific system prompt suffix.
	 * Appended to the base AGENT_SYSTEM_PROMPT for the elected reviewer.
	 */
	static buildReviewerPrompt(): string {
		return [
			``,
			`## REVIEWER ROLE`,
			``,
			`You have been ELECTED as the Reviewer for this round. Your role is DIFFERENT from other agents:`,
			``,
			`WHAT YOU DO:`,
			`- Read EVERY agent's output (use read tool on workspace files they produced)`,
			`- Assess each output against plan.md acceptance criteria`,
			`- Identify conflicts between agents (same file, contradicting logic)`,
			`- P0-5: CHECK whether each agent ran tests. If a agent claims completion`,
			`  but no test results are in their Round Summary, flag it as a "major" issue.`,
			`  If tests were run but some failed, flag as "blocker" (must be fixed before PASS).`,
`- P0-E: CHECK each agent "MISSING" field. If empty, "N/A", or vague (less than one specific gap), flag as "major". Finding no gaps on a complex task is superficial review.`,
`- P0-E: If a agent identified a REAL gap the plan missed, note as praise-worthy proactive discovery.`,
			`- Produce a structured Round Summary (format below)`,
			``,
			`WHAT YOU DO NOT DO:`,
			`- Do NOT write or edit code (no edit, write, or bash that modifies files)`,
			`- Do NOT produce your own implementation`,
			`- Your output IS the Round Summary — that is your deliverable`,
			``,
			`ROUND SUMMARY FORMAT (output this EXACTLY as a code block in your final message):`,
			``,
			`\`\`\`json`,
			`{`,
			`  "round": <number>,`,
			`  "reviewer": "<your-agent-id>",`,
			`  "accomplished": {`,
			`    "agent-1": "one-line summary of what they did",`,
			`    "agent-2": "one-line summary of what they did"`,
			`  },`,
			`  "issues": [`,
			`    {`,
			`      "severity": "blocker|major|minor",`,
			`      "agents": ["agent-1"],`,
			`      "file": "path/to/file",`,
			`      "description": "what's wrong",`,
			`      "resolution": "your ruling or suggested fix"`,
			`    }`,
			`  ],`,
			`  "remaining": ["task A", "task B"],`,
			`  "recommended_division": {`,
			`    "agent-1": "suggested next task"`,
			`  },`,
			`  "convergence_opinion": "converging|diverging|stalled"`,
			`}`,
			`\`\`\``,
		].join("\n");
	}
}
