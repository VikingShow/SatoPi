/**
 * VisibilityRenderer — Loop 可见性 TUI 渲染器。
 *
 * 监听 SatoPi 事件总线和 IrcBus 消息流，驱动终端实时显示：
 *   - 圆桌协议 PROPOSE → DEBATE → VOTE 实时流
 *   - Agent thinking/reasoning 内容
 *   - 审查议会裁决面板
 *   - Loop 迭代进度条
 */

import type { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { RoundtableResult } from "./roundtable";
import type { ReviewVerdict } from "./loop-controller";
import type { EmergenceReport } from "./bid-assigner";

export interface VisibilityConfig {
	enabled: boolean;
	showThinking: boolean;
	showIrc: boolean;
	showRoundtable: boolean;
	showReviewPanel: boolean;
	showProgressBar: boolean;
}

const DEFAULT_CONFIG: VisibilityConfig = {
	enabled: true,
	showThinking: true,
	showIrc: true,
	showRoundtable: true,
	showReviewPanel: true,
	showProgressBar: true,
};

export class VisibilityRenderer {
	readonly #config: VisibilityConfig;

	constructor(config?: Partial<VisibilityConfig>) {
		this.#config = { ...DEFAULT_CONFIG, ...config };
	}

	// -------------------------------------------------------------------
	// Roundtable rendering
	// -------------------------------------------------------------------

	/**
	 * 渲染圆桌讨论阶段切换。
	 */
	renderRoundtablePhase(phase: string): void {
		if (!this.#config.showRoundtable) return;
		const marker = phase === "propose" ? "💡" : phase === "debate" ? "⚔️" : "🗳️";
		console.log(`\n${marker} [ROUNDTABLE] ${phase.toUpperCase()} phase started`);
	}

	/**
	 * 渲染 PROPOSE 阶段收到的方案。
	 */
	renderProposals(result: RoundtableResult): void {
		if (!this.#config.showRoundtable) return;
		console.log("\n┌─ ROUNDTABLE PROPOSALS ─────────────────────────────");
		for (const p of result.proposals) {
			const preview = p.body.slice(0, 120).replace(/\n/g, " ");
			console.log(`│  ${p.agentId.padEnd(16)} ${preview}${p.body.length > 120 ? "..." : ""}`);
		}
		console.log("└────────────────────────────────────────────────────");
	}

	/**
	 * 渲染 DEBATE 阶段的辩论记录。
	 */
	renderDebates(result: RoundtableResult): void {
		if (!this.#config.showRoundtable) return;
		console.log("\n┌─ ROUNDTABLE DEBATE ────────────────────────────────");
		for (const d of result.debates) {
			const preview = d.body.slice(0, 100).replace(/\n/g, " ");
			console.log(`│  ${d.from} → ${d.to}: ${preview}...`);
		}
		console.log("└────────────────────────────────────────────────────");
	}

	/**
	 * 渲染 VOTE 投票结果。
	 */
	renderVotes(result: RoundtableResult): void {
		if (!this.#config.showRoundtable) return;
		const bar = this.#makeBar(result.approvalRate);
		console.log(`\n🗳️  Verdict: ${result.verdict.toUpperCase()}  ${bar}  ${(result.approvalRate * 100).toFixed(0)}%`);
	}

	// -------------------------------------------------------------------
	// Review council rendering
	// -------------------------------------------------------------------

	renderReviewCouncil(reviewerIds: string[]): void {
		if (!this.#config.showReviewPanel) return;
		console.log(`\n🔍 Review Council assembled: ${reviewerIds.join(", ")}`);
	}

	renderReviewVerdict(verdict: ReviewVerdict): void {
		if (!this.#config.showReviewPanel) return;
		const atroposIcon = verdict.atroposApproved ? "✅" : "❌ VETO";
		const verdictIcon = verdict.passed ? "✅ PASS" : "❌ FAIL";
		console.log(`\n┌─ REVIEW VERDICT ───────────────────────────────────`);
		console.log(`│  Atropos: ${atroposIcon}`);
		console.log(`│  Result:  ${verdictIcon}  (${verdict.approvalCount}/${verdict.totalCount} approved)`);
		if (verdict.findings.length > 0) {
			console.log(`│  Findings: ${verdict.findings.length} issue(s)`);
			for (const f of verdict.findings.slice(0, 3)) {
				console.log(`│    • ${f.slice(0, 80)}`);
			}
		}
		console.log(`└────────────────────────────────────────────────────`);
	}

	// -------------------------------------------------------------------
	// Progress bar
	// -------------------------------------------------------------------

	renderProgress(iteration: number, maxIterations: number): void {
		if (!this.#config.showProgressBar) return;
		const bar = this.#makeBar(iteration / maxIterations);
		console.log(`\n🔄 Loop ${iteration + 1}/${maxIterations} ${bar}`);
	}

	// -------------------------------------------------------------------
	// Thinking / IRC
	// -------------------------------------------------------------------

	renderThinking(agentId: string, thought: string): void {
		if (!this.#config.showThinking) return;
		const preview = thought.slice(0, 150).replace(/\n/g, " ");
		console.log(`  💭 ${agentId}: ${preview}...`);
	}

	renderIrc(from: string, to: string, body: string): void {
		if (!this.#config.showIrc) return;
		const preview = body.slice(0, 100).replace(/\n/g, " ");
		console.log(`  📨 ${from} → ${to}: ${preview}${body.length > 100 ? "..." : ""}`);
	}

	// -------------------------------------------------------------------
	// Emergence
	// -------------------------------------------------------------------

	renderEmergence(report: EmergenceReport): void {
		console.log("\n┌─ EMERGENCE OBSERVATION ────────────────────────────");
		console.log(`│  Cross-capability tasks: ${report.crossCapabilityTasks.length}`);
		console.log(`│  Load balance variance:  ${report.loadBalanceVariance.toFixed(3)}`);
		console.log(`│  Orphaned tasks:         ${report.orphanedTasks.length}`);
		console.log(`│  Collaborative:          ${report.collaborativeJointTasks.length}`);
		console.log("└────────────────────────────────────────────────────");
	}

	// -------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------

	#makeBar(ratio: number): string {
		const width = 20;
		const filled = Math.round(ratio * width);
		return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
	}
}
