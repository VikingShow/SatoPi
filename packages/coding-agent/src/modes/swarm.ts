import swarmNotice from "../prompts/system/swarm-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { keywordInProse } from "./markdown-prose";

/**
 * "swarm" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a cool
 * blue→cyan gradient ({@link highlightSwarm}); submitting a message that
 * mentions it appends a hidden {@link SWARM_NOTICE} that switches the model
 * into multi-agent swarm orchestration mode for complex multi-phase projects.
 * Matching is whitespace-delimited and case-sensitive (lowercase only), so
 * "swarmed", "Swarm", or a path like "swarm.ts" never trigger either
 * behavior. Replaces the former `/swarm` slash command.
 */

// Detection: lowercase keyword flanked by whitespace or a string edge. Non-global so `.test` stays stateless.
const SWARM_WORD = /(?<!\S)swarm(?!\S)/;

/** Hidden system notice appended after a user message that mentions "swarm". */
export const SWARM_NOTICE: string = swarmNotice.trim();

/**
 * Whether `text` contains the standalone keyword "swarm" (lowercase,
 * whitespace-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsSwarm(text: string): boolean {
	return keywordInProse(text, SWARM_WORD);
}

/**
 * Highlight every standalone "swarm" in `text` for editor display with a
 * cool blue→cyan gradient (hue 200..300), visually distinct from
 * ultrathink's full-spectrum rainbow, orchestrate's teal→violet, and
 * workflowz's amber→green.
 */
export const highlightSwarm: KeywordHighlighter = createGradientHighlighter({
	probe: /swarm/,
	highlight: /(?<!\S)swarm(?!\S)/g,
	stops: 14,
	hue: t => 200 + t * 100,
});
