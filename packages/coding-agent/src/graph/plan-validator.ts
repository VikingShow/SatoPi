/**
 * Plan validation helpers.
 *
 * Moved from swarm/core/embedded-swarm-bridge.ts.
 */

/**
 * Validate task checklist items in a plan.
 * Each `- [ ] ...` task must have at least 2 of: Files:, Change:, Acceptance:.
 * Returns error messages for each failing section/task.
 */
export function validatePlanTasks(planContent: string): string[] {
	const errors: string[] = [];

	// Find all ## Phase headings
	const sectionRegex = /^##\s+Phase\b[^\n]*$(?:\n(?!##\s).*)*/gm;
	const sections = [...planContent.matchAll(sectionRegex)];

	for (const sectionMatch of sections) {
		const sectionText = sectionMatch[0];
		const sectionTitle = sectionMatch[0].split("\n")[0].trim();

		// Find task checklist items
		const taskRegex = /^- \[ \].+/gm;
		const tasks = [...sectionText.matchAll(taskRegex)];

		for (let i = 0; i < tasks.length; i++) {
			const taskLine = tasks[i][0];
			const taskIndex = tasks[i].index!;
			const afterTask = sectionText.slice(taskIndex + taskLine.length);
			const afterTaskStart = afterTask.startsWith("\n") ? 1 : 0;
			const continuationEnd = afterTask.slice(afterTaskStart).search(/^(?![\t ])/m);
			const adjustedEnd = continuationEnd === -1 ? undefined : afterTaskStart + continuationEnd;
			const taskBlock = afterTask.slice(0, adjustedEnd);
			const fullTaskText = taskLine + taskBlock;

			const hasFiles = /\bFiles:/.test(fullTaskText);
			const hasChange = /\bChange:/.test(fullTaskText);
			const hasAcceptance = /\bAcceptance:/.test(fullTaskText);
			const matchCount = [hasFiles, hasChange, hasAcceptance].filter(Boolean).length;

			if (matchCount < 2) {
				const missing: string[] = [];
				if (!hasFiles) missing.push("Files:");
				if (!hasChange) missing.push("Change:");
				if (!hasAcceptance) missing.push("Acceptance:");
				const taskDesc = taskLine
					.replace(/^- \[ \]\s*/, "")
					.trim()
					.slice(0, 60);
				errors.push(
					`${sectionTitle}: task "${taskDesc}${taskDesc.length >= 60 ? "..." : ""}" ` +
						`is missing ${missing.join(", ")} (needs at least 2 of: Files:, Change:, Acceptance:)`,
				);
			}
		}
	}

	// Also check tasks outside of ## Phase sections
	const phaseSectionRegex = /^##\s+Phase\b[^\n]*$(?:\n(?!##\s).*)*/gm;
	const withoutPhases = planContent.replace(phaseSectionRegex, "");
	const globalTasks = [...withoutPhases.matchAll(/^- \[ \].+/gm)];

	for (let i = 0; i < globalTasks.length; i++) {
		const taskLine = globalTasks[i][0];
		const taskIndex = globalTasks[i].index!;
		const afterTask = withoutPhases.slice(taskIndex + taskLine.length);
		const continuationEnd = afterTask.search(/^(?![\t ])/m);
		const taskBlock = afterTask.slice(0, continuationEnd === -1 ? undefined : continuationEnd);
		const fullTaskText = taskLine + taskBlock;

		const hasFiles = /\bFiles:/.test(fullTaskText);
		const hasChange = /\bChange:/.test(fullTaskText);
		const hasAcceptance = /\bAcceptance:/.test(fullTaskText);
		const matchCount = [hasFiles, hasChange, hasAcceptance].filter(Boolean).length;

		if (matchCount < 2) {
			const missing: string[] = [];
			if (!hasFiles) missing.push("Files:");
			if (!hasChange) missing.push("Change:");
			if (!hasAcceptance) missing.push("Acceptance:");
			const taskDesc = taskLine
				.replace(/^- \[ \]\s*/, "")
				.trim()
				.slice(0, 60);
			errors.push(
				`Preamble: task "${taskDesc}${taskDesc.length >= 60 ? "..." : ""}" ` +
					`is missing ${missing.join(", ")} (needs at least 2 of: Files:, Change:, Acceptance:)`,
			);
		}
	}

	return errors;
}
