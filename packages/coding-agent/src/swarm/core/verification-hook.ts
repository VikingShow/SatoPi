/**
 * VerificationHook — runs verification commands (tests, type-check, build)
 * after a loop completes.
 *
 * Each command is executed via Bun.spawn in the workspace directory.
 * Results are collected and logged via ActivityLogger.
 *
 * When `blocking` is true and any command fails, the caller treats the
 * verification as failed and continues to the next loop iteration instead
 * of entering the After Loop pipeline.
 */

import type { ActivityLogger } from "../hooks/activity-logger";
import { logger } from "@oh-my-pi/pi-utils";

// ============================================================================
// Types
// ============================================================================

export interface VerificationCommandResult {
	/** The shell command that was executed. */
	command: string;
	/** Process exit code (0 = success). */
	exitCode: number;
	/** Combined stdout + stderr output. */
	output: string;
}

export interface VerificationResult {
	/** True when all commands exited with code 0. */
	passed: boolean;
	/** Per-command results, in execution order. */
	results: VerificationCommandResult[];
}

// ============================================================================
// VerificationHook
// ============================================================================

export class VerificationHook {
	constructor(
		private readonly workspace: string,
		private readonly activityLogger?: ActivityLogger,
	) {}

	/**
	 * Run each verification command sequentially.
	 *
	 * Commands are run in order; a failure in one command does not short-circuit
	 * the remaining commands — all results are collected so the caller (and the
	 * user via SSE) can see the full picture.
	 *
	 * @returns aggregate {@link VerificationResult}
	 */
	async run(commands: string[]): Promise<VerificationResult> {
		const results: VerificationCommandResult[] = [];

		this.activityLogger?.logBroadcast(
			"system",
			`[verification] Starting ${commands.length} verification command(s): ${commands.join(", ")}`,
		);
		logger.info("VerificationHook: starting", { commands, workspace: this.workspace });

		for (const command of commands) {
			const result = await this.#runCommand(command);
			results.push(result);

			const status = result.exitCode === 0 ? "PASS" : "FAIL";
			const truncated = result.output.length > 2000
				? `${result.output.slice(0, 2000)}... (truncated, ${result.output.length} chars total)`
				: result.output;

			this.activityLogger?.logBroadcast(
				"system",
				`[verification] ${status}: \`${command}\` (exit ${result.exitCode})\n${truncated}`,
			);
			logger.info("VerificationHook: command done", { command, exitCode: result.exitCode });
		}

		const passed = results.every(r => r.exitCode === 0);

		this.activityLogger?.logBroadcast(
			"system",
			`[verification] ${passed ? "ALL PASSED" : "FAILED"} — ${results.filter(r => r.exitCode === 0).length}/${results.length} commands succeeded`,
		);
		logger.info("VerificationHook: complete", { passed, total: results.length });

		return { passed, results };
	}

	/**
	 * Execute a single shell command and capture its output + exit code.
	 */
	async #runCommand(command: string): Promise<VerificationCommandResult> {
		try {
			const proc = Bun.spawn(["bash", "-c", command], {
				cwd: this.workspace,
				stdout: "pipe",
				stderr: "pipe",
			});

			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const exitCode = await proc.exited;

			const output = [stdout, stderr].filter(s => s.length > 0).join("\n");
			return { command, exitCode, output };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn("VerificationHook: command spawn failed", { command, error: message });
			return { command, exitCode: -1, output: `[SPAWN ERROR] ${message}` };
		}
	}
}
