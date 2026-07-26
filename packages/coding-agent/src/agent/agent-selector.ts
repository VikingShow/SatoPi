/**
 * AgentSelector — selects the best agents for a Stage run.
 *
 * Algorithm:
 *   1. Filter by domain proficiency (≥ 0.5 by default)
 *   2. Score each agent:
 *      credit.score * 0.4 + domain_match * 0.3 + success_rate * 0.2 + recency * 0.1
 *   3. Sort descending, take top N
 *   4. Ensure minimum diversity (at least 2 different archetypes)
 *   5. Fallback: lower threshold if not enough agents
 */

import type { ProfileRegistry, AgentProfile } from "./agent-profile";

// ============================================================================
// Types
// ============================================================================

export interface AgentSelectionInput {
	/** Required number of agents. */
	required: number;
	/** Task domains needed (extracted from plan.md). */
	domains: string[];
	/** Minimum proficiency threshold. Default 0.5. */
	minProficiency?: number;
	/** Profile registry to query. */
	registry: ProfileRegistry;
}

export interface ScoredAgent {
	profileId: string;
	name: string;
	archetype: string;
	score: number;
	creditScore: number;
	domainMatch: number;
	successRate: number;
	recencyBonus: number;
	preferredRoles: string[];
}

// ============================================================================
// Selection
// ============================================================================

/**
 * Select the best agents for a Stage run.
 * Returns agents sorted by score descending.
 */
export function selectAgents(input: AgentSelectionInput): ScoredAgent[] {
	const { required, domains, minProficiency = 0.5, registry } = input;
	const allProfiles = registry.list();
	const now = Date.now();

	if (allProfiles.length === 0) return [];

	// Step 1: Score each agent
	const scored: ScoredAgent[] = [];
	for (const profile of allProfiles) {
		const domainScore = computeDomainMatch(profile, domains);
		if (domainScore < minProficiency) continue;

		const score = computeAgentScore(profile, domainScore, now);
		scored.push({
			profileId: profile.profileId,
			name: profile.identity.name,
			archetype: profile.identity.archetype,
			score,
			creditScore: profile.credit.score,
			domainMatch: domainScore,
			successRate: profile.credit.successRate,
			recencyBonus: computeRecency(profile.credit.lastActiveAt, now),
			preferredRoles: profile.stats.preferredRoles,
		});
	}

	// Step 2: Sort by score descending
	scored.sort((a, b) => b.score - a.score);

	// Step 3: If not enough with default threshold, try lower
	if (scored.length < required) {
		const relaxed = allProfiles
			.filter(p => !scored.find(s => s.profileId === p.profileId))
			.map(p => ({
				profileId: p.profileId,
				name: p.identity.name,
				archetype: p.identity.archetype,
				score: computeAgentScore(p, Math.max(0, computeDomainMatch(p, domains)), now),
				creditScore: p.credit.score,
				domainMatch: Math.max(0, computeDomainMatch(p, domains)),
				successRate: p.credit.successRate,
				recencyBonus: computeRecency(p.credit.lastActiveAt, now),
				preferredRoles: p.stats.preferredRoles,
			}))
			.sort((a, b) => b.score - a.score);
		scored.push(...relaxed);
	}

	// Step 4: Take top N, ensure minimum diversity
	let selected = scored.slice(0, required);
	const archetypes = new Set(selected.map(s => s.archetype));
	if (archetypes.size < 2 && scored.length > required) {
		// Try to swap in a different archetype
		for (let i = required; i < scored.length; i++) {
			if (!archetypes.has(scored[i].archetype)) {
				selected[selected.length - 1] = scored[i];
				break;
			}
		}
	}

	return selected;
}

/**
 * Score a single agent for fitness.
 *
 * Includes violation penalty factor:
 * - 3+ violations → 0.7 multiplier
 * - 2 violations  → 0.85 multiplier
 * - 1 violation   → 0.95 multiplier
 * - Recent violation (within 30 days) → additional 0.05 reduction
 */
function computeAgentScore(
	profile: AgentProfile,
	domainMatch: number,
	now: number,
): number {
	const creditWeight = 0.4;
	const domainWeight = 0.3;
	const successWeight = 0.2;
	const recencyWeight = 0.1;

	const baseScore =
		(profile.credit.score / 100) * creditWeight +
		domainMatch * domainWeight +
		profile.credit.successRate * successWeight +
		computeRecency(profile.credit.lastActiveAt, now) * recencyWeight;

	// Violation penalty factor
	const violationPenalty = computeViolationPenalty(profile.credit.violationCount, profile.credit.violationHistory, now);

	return baseScore * violationPenalty;
}

/**
 * Compute a penalty multiplier based on violation history.
 * More violations = lower multiplier. Recent violations add extra penalty.
 */
function computeViolationPenalty(
	violationCount: number,
	violationHistory: AgentProfile["credit"]["violationHistory"],
	now: number,
): number {
	if (violationCount === 0) return 1.0;

	let penalty = 1.0;
	if (violationCount >= 3) {
		penalty = 0.7;
	} else if (violationCount === 2) {
		penalty = 0.85;
	} else {
		penalty = 0.95;
	}

	// Recent violation (within 30 days) adds extra penalty
	const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
	const hasRecentViolation = violationHistory.some(v => (now - v.timestamp) < thirtyDaysMs);
	if (hasRecentViolation) {
		penalty = Math.max(0.5, penalty - 0.05);
	}

	return penalty;
}

/**
 * Compute how well an agent's domains match the task's domains.
 * Returns 0-1.
 */
function computeDomainMatch(profile: AgentProfile, taskDomains: string[]): number {
	if (taskDomains.length === 0) return 0.5; // neutral when no domains specified
	if (profile.expertise.domains.length === 0) return 0.3;

	let totalMatch = 0;
	for (const domain of taskDomains) {
		const prof = profile.expertise.proficiency[domain] ?? 0;
		if (prof > 0) {
			totalMatch += prof;
		} else {
			// Fuzzy: check if any expertise domain contains the task domain
			const fuzzy = profile.expertise.domains.filter(d =>
				d.includes(domain) || domain.includes(d),
			);
			if (fuzzy.length > 0) {
				totalMatch += 0.3;
			}
		}
	}

	return Math.min(1, totalMatch / Math.max(1, taskDomains.length));
}

/**
 * Recency bonus: agents active within the last 24h get full bonus,
 * decaying to 0 over 7 days.
 */
function computeRecency(lastActiveAt: number, now: number): number {
	const hoursSince = (now - lastActiveAt) / (1000 * 60 * 60);
	if (hoursSince < 24) return 1.0;
	if (hoursSince > 168) return 0.0; // 7 days
	return 1.0 - (hoursSince - 24) / (168 - 24);
}

/**
 * Extract task domains from plan content using keyword analysis.
 */
export function extractDomains(planContent: string): string[] {
	const domainKeywords: Record<string, string[]> = {
		frontend: ["react", "vue", "component", "ui", "css", "html", "frontend", "browser"],
		backend: ["api", "server", "database", "endpoint", "backend", "rest", "graphql"],
		typescript: ["typescript", "ts", "bun"],
		rust: ["rust", "cargo", "crate"],
		python: ["python", "django", "flask", "pytest"],
		devops: ["docker", "ci/cd", "deploy", "infrastructure", "kubernetes"],
		testing: ["test", "coverage", "mock", "assert", "unit test", "integration test"],
		security: ["auth", "encrypt", "security", "permission", "token"],
		data: ["database", "sql", "migration", "schema", "query"],
	};

	const domains = new Set<string>();
	const lower = planContent.toLowerCase();
	for (const [domain, keywords] of Object.entries(domainKeywords)) {
		for (const kw of keywords) {
			if (lower.includes(kw)) {
				domains.add(domain);
				break;
			}
		}
	}

	return [...domains];
}
