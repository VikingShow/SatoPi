/**
 * quadrant-audit Hook — Agent Cognitive Four Quadrants monitor.
 *
 * In tool.execute.after, intercepts every tool call and compares
 * "what the prompt declared" vs "what was actually executed",
 * producing Q1-Q4 distribution data asynchronously.
 *
 * Q1: declared + executed  (ideal)
 * Q2: not-declared + executed (implicit capability / surprise)
 * Q3: declared + not-executed (instruction following failure)
 * Q4: not-declared + not-executed (unknown blind spot)
 */

import type { HookContext, ToolCallRecord } from "@oh-my-pi/pi-coding-agent";

interface QuadrantRecord {
	instruction: string;
	declared: boolean;
	executed: boolean;
	quadrant: "Q1" | "Q2" | "Q3" | "Q4";
	toolName: string;
	sessionId: string;
	timestamp: number;
}

interface QuadrantSummary {
	q1: number;
	q2: number;
	q3: number;
	q4: number;
	total: number;
	records: QuadrantRecord[];
}

let sessionRecords: QuadrantRecord[] = [];
let declaredInstructions: string[] = [];

export function hook(ctx: HookContext): void {
	ctx.hook("tool.execute.after", async (event) => {
		const { toolName, params, sessionId } = event;
		const timestamp = Date.now();

		// Gather declared instructions from the prompt context
		if (!declaredInstructions.length && ctx.session?.messages) {
			const systemMessages = ctx.session.messages
				.filter((m) => m.role === "system")
				.map((m) => m.content)
				.join("\n");
			// Simple heuristic: extract sentences with imperative verbs
			declaredInstructions = systemMessages
				.split(/\n|\. /)
				.filter((s) =>
					/^(must|should|always|never|do not|ensure|verify|check|use|call|run|execute|read|write|edit|search|grep|glob)/i.test(s.trim()),
				)
				.map((s) => s.trim());
		}

		// Check if this tool execution was declared in the prompt
		const declared = declaredInstructions.some(
			(inst) =>
				inst.toLowerCase().includes(toolName.toLowerCase()) ||
				inst.toLowerCase().includes((params as Record<string, string>)?.assignment?.toLowerCase() ?? ""),
		);

		const executed = true; // tool.execute.after fires only after successful execution

		const record: QuadrantRecord = {
			instruction: `${toolName}(${JSON.stringify(params).slice(0, 100)})`,
			declared,
			executed,
			quadrant: declared ? "Q1" : "Q2",
			toolName,
			sessionId,
			timestamp,
		};

		sessionRecords.push(record);
	});

	// On session end, compute and store summary
	ctx.hook("session_shutdown", async () => {
		const summary: QuadrantSummary = {
			q1: 0,
			q2: 0,
			q3: 0,
			q4: 0,
			total: sessionRecords.length,
			records: [...sessionRecords],
		};

		for (const r of sessionRecords) {
			summary[r.quadrant === "Q1" ? "q1" : r.quadrant === "Q2" ? "q2" : r.quadrant === "Q3" ? "q3" : "q4"]++;
		}

		// Detect Q3: declared instructions that were NEVER executed
		const executedTools = new Set(sessionRecords.map((r) => r.toolName));
		for (const inst of declaredInstructions) {
			const matched = !![...executedTools].find((t) => inst.toLowerCase().includes(t.toLowerCase()));
			if (!matched) {
				summary.q3++;
				summary.total++;
				summary.records.push({
					instruction: inst,
					declared: true,
					executed: false,
					quadrant: "Q3",
					toolName: "none",
					sessionId: sessionRecords[0]?.sessionId ?? "unknown",
					timestamp: Date.now(),
				});
			}
		}

		// Persist to disk (non-blocking)
		try {
			const fs = await import("node:fs/promises");
			const path = await import("node:path");
			const dir = path.join(".omp", "audit-logs");
			await fs.mkdir(dir, { recursive: true });
			const file = path.join(dir, `quadrant-${Date.now()}.json`);
			await fs.writeFile(file, JSON.stringify(summary, null, 2));
			console.log(`[quadrant-audit] Summary written to ${file}`);
		} catch {
			// Non-critical — audit is best-effort
		}

		// Reset for next session
		sessionRecords = [];
		declaredInstructions = [];
	});
}
