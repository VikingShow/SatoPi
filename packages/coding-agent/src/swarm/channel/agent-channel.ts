/**
 * AgentChannel — Agent group-chat communication layer.
 *
 * Built on top of IrcBus, provides:
 * - broadcast: send to all agents (secret-CC to observers)
 * - sub-group: agents negotiate privately among subsets
 * - interrupt: an observer can step in to steer a specific agent
 * - monitoring: observers silently receive all agent messages
 *
 * Agents are unaware of observers — observer messages are delivered
 * via suppressRelay and never shown in the main relay.
 *
 * @remarks Internally delegates messaging to {@link CommChannel} for unified
 * send / roundtable / vote logic.  The public API is unchanged.
 */

import type { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { ActivityLogger } from "../hooks/activity-logger";
import { CommChannel } from "../comm-bus/comm-channel";

// ============================================================================
// Types
// ============================================================================

export interface AgentMessage {
	from: string;
	body: string;
	timestamp: number;
}

export interface AgentChannelConfig {
	/** IDs of participating agents. */
	agents: string[];
	/**
	 * Observer IDs — receive a silent copy of every broadcast and sub-group
	 * message.  Observers are invisible to agents.  Use this for monitoring,
	 * logging, or passive steering hooks.
	 */
	observers: string[];
}

// ============================================================================
export class AgentChannel {
	readonly #ircBus: IrcBus;
	readonly #agents = new Set<string>();
	readonly #observers = new Set<string>();
	readonly #groups = new Map<string, Set<string>>();
	readonly #activityLogger?: ActivityLogger;
	/**
	 * Internal CommChannel that backs the public messaging API.
	 * Created during construction and kept in sync with agents/observers.
	 */
	readonly #commChannel: CommChannel;

	constructor(ircBus: IrcBus, config: AgentChannelConfig, activityLogger?: ActivityLogger) {
		this.#ircBus = ircBus;
		this.#activityLogger = activityLogger;
		this.#commChannel = new CommChannel(ircBus, config.agents, config.observers, activityLogger);
		for (const a of config.agents) this.#agents.add(a);
		for (const o of config.observers) this.#observers.add(o);
	}

	// -- lifecycle -------------------------------------------------------

	get agents(): ReadonlySet<string> {
		return this.#agents;
	}

	get observers(): ReadonlySet<string> {
		return this.#observers;
	}

	addAgent(agentId: string): void {
		this.#agents.add(agentId);
		this.#commChannel.addMember(agentId);
	}

	removeAgent(agentId: string): void {
		this.#agents.delete(agentId);
		this.#commChannel.removeMember(agentId);
		for (const [, members] of this.#groups) {
			members.delete(agentId);
		}
	}

	addObserver(observerId: string): void {
		this.#observers.add(observerId);
		this.#commChannel.addObserver(observerId);
	}

	removeObserver(observerId: string): void {
		this.#observers.delete(observerId);
		this.#commChannel.removeObserver(observerId);
	}

	// -- messaging -------------------------------------------------------

	/**
	 * Broadcast to ALL agents (visible) + secret-CC all observers.
	 * Delegates to {@link CommChannel.send} for unified message routing.
	 *
	 * @deprecated The internal IrcBus loop is replaced by CommChannel.send().
	 * This method's public signature is unchanged.
	 */
	async broadcast(from: string, body: string): Promise<void> {
		await this.#commChannel.send(from, body);
	}

	// -- sub-groups ------------------------------------------------------

	/**
	 * Create a named sub-group.
	 * Members are agent IDs; observers automatically monitor all sub-groups.
	 */
	createSubGroup(name: string, members: string[]): void {
		const valid = members.filter(m => this.#agents.has(m));
		this.#groups.set(name, new Set(valid));
	}

	/**
	 * Send to a named sub-group. Members + all observers receive it.
	 * Delegates to {@link CommChannel.sendToGroup} for unified delivery.
	 */
	async sendToSubGroup(groupName: string, from: string, body: string): Promise<void> {
		this.#activityLogger?.logSubGroup(groupName, from, body);
		const members = this.#groups.get(groupName);
		if (!members || members.size === 0) return;

		await this.#commChannel.sendToGroup(from, body, [...members]);
	}

	addToSubGroup(groupName: string, agentId: string): void {
		if (!this.#agents.has(agentId)) return;
		this.#groups.get(groupName)?.add(agentId);
	}

	removeFromSubGroup(groupName: string, agentId: string): void {
		this.#groups.get(groupName)?.delete(agentId);
	}

	// -- observer interrupt ----------------------------------------------

	/**
	 * An observer steps in to steer a specific agent.
	 * Delegates to {@link CommChannel.interrupt} for unified steering.
	 */
	async interrupt(observerId: string, agentId: string, reason: string): Promise<void> {
		await this.#commChannel.interrupt(observerId, agentId, reason);
	}

	/**
	 * An observer broadcasts a steering directive to all agents at once.
	 */
	async broadcastSteering(observerId: string, body: string): Promise<void> {
		this.#activityLogger?.logSteering(observerId, "all", body);
		await Promise.all(
			[...this.#agents].map(to =>
				this.#ircBus.send({ from: observerId, to, body: `[STEERING] ${body}` }),
			),
		);
	}

	/**
	 * Build an observer-role system prompt suffix.
	 * Appended to the base system prompt of the elected reviewer agent
	 * during supervised rounds.
	 */
	static buildObserverReviewerPrompt(): string {
		return [
			``,
			`## OBSERVER REVIEWER ROLE`,
			``,
			`You have been assigned the reviewer role for this round. Your role is DIFFERENT from other agents:`,
			``,
			`WHAT YOU DO:`,
			`- Read EVERY agent's output (use read tool on workspace files they produced)`,
			`- Assess each output against plan.md acceptance criteria`,
			`- Identify conflicts between agents (same file, contradicting logic)`,
			`- P0-5: CHECK whether each agent ran tests. If an agent claims completion`,
			`  but no test results are in their Round Summary, flag it as "major".`,
			`  If tests were run but some failed, flag as "blocker" (must be fixed before PASS).`,
			`- P0-E: CHECK each agent "MISSING" field. If empty, "N/A", or vague, flag as "major".`,
			`- P0-E: If an agent identified a REAL gap the plan missed, note as praise-worthy.`,
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
