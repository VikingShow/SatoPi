/**
 * agent-profile.ts — Agent 身份系统（"身份证"）
 *
 * 设计原则：
 * 1. AgentProfile 是 Agent 的不可变身份 + 可变信用记录的统一载体
 * 2. 信用记录内嵌于 Profile（violationCount 只增不减，信用分可衰减可恢复）
 * 3. ProfileRegistry 管理全部 Profile 的 CRUD，通过 SharedServices 注入
 * 4. 不做 Fork/Merge/Prune/Genesis（无 AgentPool 生命周期）
 *
 * 与 state.ts AgentState 的关系：
 * - AgentState 是 per-run 的临时状态（iteration, wave, status）
 * - AgentProfile 是跨 run 的持久身份（expertise, credit, social graph）
 * - AgentState 通过 profileId 引用 AgentProfile
 */

// ============================================================================
// Types
// ============================================================================

/** 违规严重程度 — 影响信用分衰减量 */
export type ViolationSeverity = "minor" | "major" | "critical";

/** 一次不可逆的违规记录 */
export interface ViolationRecord {
	/** 违规类型标识，如 "test_not_run", "file_conflict", "wrong_output" */
	type: string;
	severity: ViolationSeverity;
	description: string;
	timestamp: number;
	/** 受影响文件路径（可选） */
	files?: string[];
	/** 违规发生的迭代编号 */
	iteration: number;
}

/** 代理人画像 — 跨 run 持久存在的 Agent 身份 */
export interface AgentProfile {
	/** 全局唯一标识，如 "worker-architect-v3" */
	profileId: string;

	// ── 身份信息 ──────────────────────────────────────────────────
	identity: {
		name: string;
		/** 原型角色：architect | implementer | reviewer | debugger | tester */
		archetype: string;
		/** Profile 描述版本 */
		description: string;
		createdAt: number;
	};

	// ── 能力画像 ──────────────────────────────────────────────────
	expertise: {
		/** 擅长领域 */
		domains: string[];
		/** 领域熟练度 (0-1)，如 { "typescript": 0.92 } */
		proficiency: Record<string, number>;
		/** 特殊技能 */
		specialties: string[];
	};

	// ── 信用记录（法律/道德/信用的统一载体） ────────────────────
	credit: {
		/** 信用分 0-100，初始 50（中性） */
		score: number;
		totalTasks: number;
		/** 完成率 (0-1) */
		successRate: number;
		praiseCount: number;
		criticismCount: number;
		/** 违规次数 — 只增不减，不可逆 */
		violationCount: number;
		/** 违规完整审计链 */
		violationHistory: ViolationRecord[];
		/** 最近活跃时间 */
		lastActiveAt: number;
	};

	// ── 社会关系 ──────────────────────────────────────────────────
	social: {
		/** 合作过的 Agent ID 列表 */
		collaborators: string[];
		/** 合作次数 */
		collaborationCount: number;
		/** 引用过此人工作的 Agent ID 列表 */
		citedBy: string[];
	};
}

// ============================================================================
// 信用分衰减规则
// ============================================================================

/** 违规严重度 → 信用分扣减映射 */
const VIOLATION_SCORE_DEDUCTION: Record<ViolationSeverity, number> = {
	minor: 5,     // 警告阈值
	major: 20,    // 显著惩罚
	critical: 50, // 灾难性 — 信用分立即腰斩
};

/** 成功完成任务 → 信用分奖励 */
const SUCCESS_SCORE_REWARD = 3;
/** 被 Cloner 赞扬 → 信用分奖励 */
const PRAISE_SCORE_REWARD = 5;
/** 被 Cloner 批评 → 信用分扣减 */
const CRITICISM_SCORE_DEDUCTION = 5;
/** 信用分下限（不归零，留观察空间） */
const MIN_SCORE = 1;
/** 信用分上限 */
const MAX_SCORE = 100;

// ============================================================================
// ProfileRegistry
// ============================================================================

export class ProfileRegistry {
	readonly #profiles = new Map<string, AgentProfile>();
	/** Per-profile 版本号，用于缓存失效 */
	readonly #versions = new Map<string, number>();
	/** 信用排名缓存 — profileIds 列表 hash → 缓存结果 */
	#creditRankCache: { key: string; text: string; ttl: number } | null = null;
	/** 排名缓存有效期 (ms) */
	static readonly #RANK_CACHE_TTL = 2000;

	// ── Create ────────────────────────────────────────────────────────

	/**
	 * 创建新的 AgentProfile。
	 * 信用分从 50（中性）起步，能力画像由调用方传入。
	 */
	createProfile(opts: {
		profileId: string;
		name: string;
		archetype: string;
		description?: string;
		domains?: string[];
		proficiency?: Record<string, number>;
		specialties?: string[];
	}): AgentProfile {
		if (this.#profiles.has(opts.profileId)) {
			throw new Error(`Profile "${opts.profileId}" already exists`);
		}

		const now = Date.now();
		const profile: AgentProfile = {
			profileId: opts.profileId,
			identity: {
				name: opts.name,
				archetype: opts.archetype,
				description: opts.description ?? `Agent of archetype ${opts.archetype}`,
				createdAt: now,
			},
			expertise: {
				domains: opts.domains ?? [],
				proficiency: opts.proficiency ?? {},
				specialties: opts.specialties ?? [],
			},
			credit: {
				score: 50,
				totalTasks: 0,
				successRate: 0,
				praiseCount: 0,
				criticismCount: 0,
				violationCount: 0,
				violationHistory: [],
				lastActiveAt: now,
			},
			social: {
				collaborators: [],
				collaborationCount: 0,
				citedBy: [],
			},
		};

		this.#profiles.set(opts.profileId, profile);
		this.#versions.set(opts.profileId, 1);
		return profile;
	}

	/**
	 * 获取或创建 Profile（幂等）。
	 * 如果已存在同名 Profile，直接返回；否则创建。
	 */
	getOrCreate(opts: {
		profileId: string;
		name: string;
		archetype: string;
		description?: string;
		domains?: string[];
		proficiency?: Record<string, number>;
		specialties?: string[];
	}): AgentProfile {
		const existing = this.#profiles.get(opts.profileId);
		if (existing) return existing;
		return this.createProfile(opts);
	}

	// ── Read ──────────────────────────────────────────────────────────

	get(profileId: string): AgentProfile | undefined {
		return this.#profiles.get(profileId);
	}

	has(profileId: string): boolean {
		return this.#profiles.has(profileId);
	}

	getVersion(profileId: string): number {
		return this.#versions.get(profileId) ?? 0;
	}

	list(): AgentProfile[] {
		return [...this.#profiles.values()];
	}

	/** 获取所有信用分低于阈值的 Profile */
	listLowCredit(threshold = 30): AgentProfile[] {
		return this.list().filter(p => p.credit.score < threshold);
	}

	// ── Credit Mutations ──────────────────────────────────────────────

	/**
	 * 记录任务完成。
	 * 成功完成 → 信用分 +3，update successRate。
	 */
	recordTaskCompleted(profileId: string, success: boolean): AgentProfile | undefined {
		const profile = this.#profiles.get(profileId);
		if (!profile) return undefined;

		profile.credit.totalTasks++;
		profile.credit.lastActiveAt = Date.now();

		if (success) {
			profile.credit.score = clamp(profile.credit.score + SUCCESS_SCORE_REWARD, MIN_SCORE, MAX_SCORE);
		}
		// 更新成功率
		const total = profile.credit.totalTasks;
		const prevSuccess = Math.round((total - 1) * profile.credit.successRate);
		profile.credit.successRate = (prevSuccess + (success ? 1 : 0)) / total;

		this.#bumpVersion(profileId);
		return profile;
	}

	/**
	 * 记录 Cloner 评审反馈。
	 */
	recordReviewFeedback(workerIds: string[], praised: string[], criticized: string[]): void {
		const praisedSet = new Set(praised);
		const criticizedSet = new Set(criticized);

		for (const id of workerIds) {
			const profile = this.#profiles.get(id);
			if (!profile) continue;

			if (praisedSet.has(id)) {
				profile.credit.praiseCount++;
				profile.credit.score = clamp(profile.credit.score + PRAISE_SCORE_REWARD, MIN_SCORE, MAX_SCORE);
			}
			if (criticizedSet.has(id)) {
				profile.credit.criticismCount++;
				profile.credit.score = clamp(
					profile.credit.score - CRITICISM_SCORE_DEDUCTION,
					MIN_SCORE,
					MAX_SCORE,
				);
			}

			profile.credit.lastActiveAt = Date.now();
			this.#bumpVersion(id);
		}
	}

	/**
	 * 记录违规（不可逆）。
	 * violationCount 只增不减，形成完整审计链。
	 */
	recordViolation(profileId: string, record: Omit<ViolationRecord, "timestamp">): AgentProfile | undefined {
		const profile = this.#profiles.get(profileId);
		if (!profile) return undefined;

		const full: ViolationRecord = { ...record, timestamp: Date.now() };
		profile.credit.violationHistory.push(full);
		profile.credit.violationCount++;
		profile.credit.score = clamp(
			profile.credit.score - VIOLATION_SCORE_DEDUCTION[record.severity],
			MIN_SCORE,
			MAX_SCORE,
		);
		profile.credit.lastActiveAt = Date.now();

		this.#bumpVersion(profileId);
		return profile;
	}

	/**
	 * 记录协作关系（互操作）。
	 */
	recordCollaboration(agentIds: string[]): void {
		const profiles = agentIds.map(id => this.#profiles.get(id)).filter(Boolean) as AgentProfile[];

		for (const profile of profiles) {
			profile.social.collaborationCount++;
			for (const other of profiles) {
				if (other.profileId !== profile.profileId &&
					!profile.social.collaborators.includes(other.profileId)) {
					profile.social.collaborators.push(other.profileId);
				}
			}
			this.#bumpVersion(profile.profileId);
		}
	}

	/**
	 * 记录工作被引用。
	 */
	recordCitation(citedId: string, citerId: string): void {
		const cited = this.#profiles.get(citedId);
		if (!cited) return;
		if (!cited.social.citedBy.includes(citerId)) {
			cited.social.citedBy.push(citerId);
			this.#bumpVersion(citedId);
		}
	}

	/**
	 * 更新领域熟练度。
	 */
	updateProficiency(profileId: string, domain: string, value: number): void {
		const profile = this.#profiles.get(profileId);
		if (!profile) return;

		profile.expertise.proficiency[domain] = clamp(value, 0, 1);
		if (!profile.expertise.domains.includes(domain)) {
			profile.expertise.domains.push(domain);
		}
		this.#bumpVersion(profileId);
	}

	// ── Context Injection ────────────────────────────────────────────

	/**
	 * 为 prompt 注入生成 AgentProfile 的 XML 描述块。
	 * 返回格式：
	 * <agent_profile id="..." score="85">
	 *   archetype: implementer
	 *   domains: typescript, backend
	 *   violations: 2 | praise: 12 | criticism: 3
	 * </agent_profile>
	 *
	 * 人类可读 → Agent 可理解 → 行为受信用记录约束
	 */
	getPromptContext(profileId: string): string | null {
		const p = this.#profiles.get(profileId);
		if (!p) return null;

		const c = p.credit;
		const e = p.expertise;
		const v = c.violationHistory.slice(-3); // 最近 3 条违规

		const violationLines = v.length > 0
			? v.map(vr => `  - [${vr.severity}] ${vr.type}: ${vr.description} (#${vr.iteration})`).join("\n")
			: "  (none)";

		return [
			`<agent_profile id="${p.profileId}" score="${c.score}" archetype="${p.identity.archetype}">`,
			`  name: ${p.identity.name}`,
			`  credit_score: ${c.score}/100`,
			`  tasks_completed: ${c.totalTasks} (${(c.successRate * 100).toFixed(0)}% success)`,
			`  praise: ${c.praiseCount} | criticism: ${c.criticismCount} | violations: ${c.violationCount}`,
			`  domains: ${e.domains.join(", ") || "(none)"}`,
			`  specialties: ${e.specialties.join(", ") || "(none)"}`,
			`  collaborators: ${p.social.collaborators.length} unique agents`,
			`  recent_violations:`,
			violationLines,
			c.score < 30 ? `  ⚠ LOW CREDIT — behavior under heightened scrutiny` : "",
			c.violationCount >= 3 ? `  🔒 RESTRICTED — 3+ violations on record, tool access may be limited` : "",
			`</agent_profile>`,
		].join("\n");
	}

	/**
	 * 为 prompt 注入当前 swarm 中所有 Agent 的信用排名摘要。
	 */
	getSwarmCreditSummary(profileIds: string[]): string {
		// 缓存 key = sorted profileIds + per-profile version (版本感知)
		const cacheKey = profileIds.slice().sort().join(",") + "|" +
			profileIds.map(id => `${id}:${this.#versions.get(id) ?? 0}`).join(",");

		const now = Date.now();
		if (this.#creditRankCache &&
			this.#creditRankCache.key === cacheKey &&
			this.#creditRankCache.ttl > now) {
			return this.#creditRankCache.text;
		}

		const entries = profileIds
			.map(id => ({ id, p: this.#profiles.get(id) }))
			.filter((e): e is { id: string; p: AgentProfile } => !!e.p)
			.sort((a, b) => b.p.credit.score - a.p.credit.score);

		if (entries.length === 0) return "";

		const lines = ["<swarm_credit_ranking>"];
		for (let i = 0; i < entries.length; i++) {
			const e = entries[i];
			const icon = e.p.credit.score >= 70 ? "✓" : e.p.credit.score >= 40 ? "○" : "✗";
			lines.push(`  ${i + 1}. ${icon} ${e.id} — ${e.p.credit.score}/100 (${e.p.identity.archetype})`);
		}
		lines.push("</swarm_credit_ranking>");

		const text = lines.join("\n");
		this.#creditRankCache = { key: cacheKey, text, ttl: now + ProfileRegistry.#RANK_CACHE_TTL };
		return text;
	}

	/**
	 * 清空排名缓存（被 credit mutation 自动调用）。
	 */
	invalidateRankCache(): void {
		this.#creditRankCache = null;
	}

	// ── Internal ──────────────────────────────────────────────────────

	#bumpVersion(profileId: string): void {
		const current = this.#versions.get(profileId) ?? 0;
		this.#versions.set(profileId, current + 1);
	}
}

// ============================================================================
// Helpers
// ============================================================================

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
