import type { ISwarmOrchestrator } from "./embedded-swarm-bridge";
import type { RunManager } from "./services";

export class GraphRunnerAsRunManager implements RunManager {
	readonly #orchestrator: ISwarmOrchestrator;
	constructor(orchestrator: ISwarmOrchestrator) {
		this.#orchestrator = orchestrator;
	}
	get isRunning(): boolean {
		return this.#orchestrator.isRunning;
	}
	async start(): Promise<{ success: boolean; error?: string }> {
		const errors = await this.#orchestrator.confirmScript();
		if (errors.length > 0) return { success: false, error: errors.join("; ") };
		return { success: true };
	}
	async stop(): Promise<{ success: boolean; error?: string }> {
		await this.#orchestrator.dispose();
		return { success: true };
	}
	async pause(): Promise<{ success: boolean; error?: string }> {
		await this.#orchestrator.pauseStage();
		return { success: true };
	}
	async resume(): Promise<{ success: boolean; error?: string }> {
		if (this.#orchestrator.resumeGraphRun) {
			return this.#orchestrator.resumeGraphRun();
		}
		return { success: false, error: "Resume not supported by this orchestrator" };
	}
	async updatePlanAndContinue(_plan: string): Promise<{ success: boolean; error?: string }> {
		return { success: false, error: "Not supported in graph mode" };
	}
	resolveBlocker(_decision: "continue" | "skip" | "abort"): boolean {
		return true;
	}
	async waitForCompletion(): Promise<void> {}
	getLastCurtainResult(): null {
		return null;
	}
}
