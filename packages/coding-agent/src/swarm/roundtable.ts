/**
 * RoundtableOrchestrator — PROPOSE → DEBATE → VOTE 三轮协议编排。
 *
 * 基于 IrcBus 扩展的 sendToGroup / collectResponses，在圆桌参与者之间
 * 实现去中心化讨论。不引入新的通信层，复用 SatoPi 进程内事件驱动通信。
 */

import type { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";

// ============================================================================
// Types
// ============================================================================

export interface RoundtableProposal {
	agentId: string;
	body: string;
	timestamp: number;
}

export interface RoundtableDebateReply {
	from: string;
	to: string;
	body: string;
	timestamp: number;
}

export interface RoundtableVote {
	agentId: string;
	verdict: "approve" | "reject";
	confidence: number; // 0.0-1.0
	rationale: string;
}

export type RoundtablePhase = "propose" | "debate" | "vote";

export interface RoundtableResult {
	phase: RoundtablePhase;
	proposals: RoundtableProposal[];
	debates: RoundtableDebateReply[];
	votes: RoundtableVote[];
	verdict: "approved" | "rejected";
	approvalRate: number;
}

export interface RoundtableConfig {
	proposeTimeout: number;
	debateTimeout: number;
	voteTimeout: number;
}

// ============================================================================
// Orchestrator
// ============================================================================

export class RoundtableOrchestrator {
	readonly #bus: IrcBus;
	readonly #senderId: string; // Merlin / caller
	readonly #participants: string[];
	readonly #topic: string;
	readonly #config: RoundtableConfig;

	constructor(
		bus: IrcBus,
		senderId: string,
		participants: string[],
		topic: string,
		config?: Partial<RoundtableConfig>,
	) {
		this.#bus = bus;
		this.#senderId = senderId;
		this.#participants = participants;
		this.#topic = topic;
		this.#config = {
			proposeTimeout: config?.proposeTimeout ?? 60_000,
			debateTimeout: config?.debateTimeout ?? 120_000,
			voteTimeout: config?.voteTimeout ?? 30_000,
		};
	}

	async run(signal?: AbortSignal): Promise<RoundtableResult> {
		const proposals = await this.#proposePhase(signal);
		const debates = await this.#debatePhase(proposals, signal);
		const votes = await this.#votePhase(proposals, signal);
		const verdict = this.#tallyVotes(votes);

		return {
			phase: "vote",
			proposals,
			debates,
			votes,
			verdict: verdict.approved ? "approved" : "rejected",
			approvalRate: verdict.rate,
		};
	}

	// -------------------------------------------------------------------
	// Phase 1: PROPOSE — 参与者各自提交方案
	// -------------------------------------------------------------------
	async #proposePhase(signal?: AbortSignal): Promise<RoundtableProposal[]> {
		const msg = {
			from: this.#senderId,
			body: `[ROUNDTABLE:PROPOSE] Topic: ${this.#topic}\n\nPlease submit your proposal.`,
		};

		const responses = await this.#bus.collectResponses(
			this.#senderId,
			this.#participants,
			msg,
			{},
			this.#config.proposeTimeout,
			signal,
		);

		return [...responses.entries()].map(([agentId, reply]) => ({
			agentId,
			body: reply.body,
			timestamp: reply.ts,
		}));
	}

	// -------------------------------------------------------------------
	// Phase 2: DEBATE — 参与者互相质疑和辩护
	// -------------------------------------------------------------------
	async #debatePhase(
		proposals: RoundtableProposal[],
		signal?: AbortSignal,
	): Promise<RoundtableDebateReply[]> {
		if (proposals.length <= 1) return [];

		// Broadcast all proposals to all participants for cross-review
		const proposalSummary = proposals
			.map((p, i) => `[${i + 1}] ${p.agentId}: ${p.body.slice(0, 200)}`)
			.join("\n");

		// Each participant may question any other
		const debatePrompts = this.#participants.map(async (participantId) => {
			const otherProposals = proposals.filter((p) => p.agentId !== participantId);
			if (otherProposals.length === 0) return [];

			// Pick one other proposal to debate (round-robin)
			const target = otherProposals[0];
			const msg = {
				from: this.#senderId,
				body: `[ROUNDTABLE:DEBATE] Reviewing ${participantId}:\n\n` +
					`Other proposals:\n${proposalSummary}\n\n` +
					`Please question ${target.agentId}'s proposal or defend yours.`,
			};

			// collectResponses fires the send internally
			const replies = await this.#bus.collectResponses(
				this.#senderId,
				[participantId],
				msg,
				{},
				this.#config.debateTimeout / Math.max(1, this.#participants.length),
				signal,
			);

			return [...replies.values()].map((reply) => ({
				from: reply.from,
				to: target.agentId,
				body: reply.body,
				timestamp: reply.ts,
			}));
		});

		const allReplies = await Promise.all(debatePrompts);
		return allReplies.flat();
	}

	// -------------------------------------------------------------------
	// Phase 3: VOTE — 参与者投票
	// -------------------------------------------------------------------
	async #votePhase(
		_proposals: RoundtableProposal[],
		signal?: AbortSignal,
	): Promise<RoundtableVote[]> {
		const msg = {
			from: this.#senderId,
			body: `[ROUNDTABLE:VOTE] Vote on the proposals. Reply with:\n` +
				`  verdict: approve|reject\n  confidence: 0.0-1.0\n  rationale: <one sentence>`,
		};

		const responses = await this.#bus.collectResponses(
			this.#senderId,
			this.#participants,
			msg,
			{},
			this.#config.voteTimeout,
			signal,
		);

		return [...responses.entries()].map(([agentId, reply]) => {
			const lines = reply.body.split("\n");
			const verdictLine = lines.find((l) => l.startsWith("verdict:")) ?? "";
			const confLine = lines.find((l) => l.startsWith("confidence:")) ?? "";
			const ratLine = lines.find((l) => l.startsWith("rationale:")) ?? "";

			return {
				agentId,
				verdict: verdictLine.includes("approve") ? "approve" : "reject",
				confidence: Number.parseFloat(confLine.replace("confidence:", "").trim()) || 0.5,
				rationale: ratLine.replace("rationale:", "").trim(),
			};
		});
	}

	// -------------------------------------------------------------------
	// Tally
	// -------------------------------------------------------------------
	#tallyVotes(votes: RoundtableVote[]): { approved: boolean; rate: number } {
		const total = votes.length;
		if (total === 0) return { approved: false, rate: 0 };

		const approved = votes.filter((v) => v.verdict === "approve").length;
		const rate = approved / total;

		// Simple majority wins
		return { approved: rate > 0.5, rate };
	}
}
