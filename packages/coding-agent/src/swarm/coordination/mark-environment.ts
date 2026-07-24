/**
 * mark-environment.ts — Stigmergic 环境信号系统
 *
 * 设计原则：
 * 1. 补充 IRC，不取代 IRC。IRC 是 Agent↔Agent 直接通信，Mark 是 Agent→环境→Agent 间接感知
 * 2. Mark 不可变 — 一旦放置，不可修改，只能由创建者 forceRemove 或自然过期
 * 3. 惰性衰减 — 过期 Mark 在查询时自动清理，无定时器开销
 * 4. Guard Layer 使用 lock/claim Mark 实现文件写冲突防护
 *
 * 与 region-lock.ts 的关系：
 * - region-lock.ts 管理实际锁生命周期（lock/unlock/forceRelease）
 * - MarkEnvironment 管理锁的语义层（谁锁的、为什么锁、上下文）
 * - 两者互补：region-lock 执行，mark-environment 感知
 */

// ============================================================================
// Types
// ============================================================================

export type MarkType = "lock" | "claim" | "signal" | "artifact" | "warning";
export type MarkPriority = "low" | "medium" | "high" | "critical";

/** 可序列化的 Mark（Set → 数组） */
export interface SerializedMark {
	markId: string;
	type: string;
	agentId: string;
	path?: string;
	message: string;
	priority: string;
	createdAt: number;
	expiresAt: number;
	acknowledged: string[];
	tags: string[];
}

/** MarkEnvironment 快照，用于持久化/恢复 */
export interface MarkEnvironmentSnapshot {
	marks: SerializedMark[];
	serializedAt: number;
}

/**
 * 一个不可变的环境信号。
 * 一旦创建，内容不可修改。只能由创建者 forceRemove 或自然过期移除。
 */
export interface Mark {
	markId: string;
	/** Mark 语义类型 */
	type: MarkType;
	/** 放置此 Mark 的 Agent ID */
	agentId: string;
	/** 关联文件路径（lock/claim/artifact 类型必填，signal/warning 可选） */
	path?: string;
	/** 人类可读描述 */
	message: string;
	/** 重要性 */
	priority: MarkPriority;
	/** 创建时间戳 (ms) */
	createdAt: number;
	/** 过期时间戳 (ms)，0 = 永不过期 */
	expiresAt: number;
	/** 已确认此 Mark 的 Agent ID 集合 */
	acknowledged: Set<string>;
	/** 可选的标签，用于分面查询 */
	tags: string[];
}

export interface MarkQuery {
	/** 按 Mark 类型过滤 */
	types?: MarkType[];
	/** 按 Agent ID 过滤 */
	agentId?: string;
	/** 按文件路径前缀过滤 */
	pathPrefix?: string;
	/** 按优先级过滤 */
	minPriority?: MarkPriority;
	/** 按标签过滤（AND） */
	tags?: string[];
	/** 排除已确认的 Marks（只返回未确认的） */
	unacknowledgedOnly?: boolean;
	/** 返回的最大数量 */
	limit?: number;
}

// ============================================================================
// MarkEnvironment
// ============================================================================

export class MarkEnvironment {
	readonly #marks = new Map<string, Mark>();
	/** markId → agentId 反查索引，用于 forceRemove 验证 */
	readonly #ownerIndex = new Map<string, string>();
	/** agentId → markId[] 索引 */
	readonly #agentIndex = new Map<string, Set<string>>();
	/** path → markId[] 索引 */
	readonly #pathIndex = new Map<string, Set<string>>();

	// ── Place (创建不可变信号) ─────────────────────────────────────

	/**
	 * 在环境中放置一个 Mark。
	 * 同一 path 上可以存在多个 Mark（lock/claim/warning 可共存）。
	 */
	placeMark(opts: {
		markId: string;
		type: MarkType;
		agentId: string;
		path?: string;
		message: string;
		priority?: MarkPriority;
		/** TTL in ms，默认 0（永不过期） */
		ttlMs?: number;
		tags?: string[];
	}): Mark {
		if (this.#marks.has(opts.markId)) {
			throw new Error(`Mark "${opts.markId}" already exists`);
		}

		const now = Date.now();
		const mark: Mark = {
			markId: opts.markId,
			type: opts.type,
			agentId: opts.agentId,
			path: opts.path,
			message: opts.message,
			priority: opts.priority ?? "medium",
			createdAt: now,
			expiresAt: opts.ttlMs && opts.ttlMs > 0 ? now + opts.ttlMs : 0,
			acknowledged: new Set<string>(),
			tags: opts.tags ?? [],
		};

		this.#marks.set(mark.markId, mark);
		this.#ownerIndex.set(mark.markId, mark.agentId);

		// 索引
		this.#addToIndex(this.#agentIndex, mark.agentId, mark.markId);
		if (mark.path) {
			this.#addToIndex(this.#pathIndex, mark.path, mark.markId);
		}

		return mark;
	}

	/**
	 * 移除自己放置的 Mark（仅创建者可操作）。
	 */
	forceRemove(markId: string, agentId: string): boolean {
		const owner = this.#ownerIndex.get(markId);
		if (owner !== agentId) return false;

		const mark = this.#marks.get(markId);
		if (!mark) return false;

		this.#removeFromAll(mark);
		return true;
	}

	/**
	 * 确认一个 Mark（标记此 Agent 已知道）。
	 * 幂等 — 重复确认无副作用。
	 */
	acknowledge(markId: string, agentId: string): boolean {
		const mark = this.#marks.get(markId);
		if (!mark) return false;
		mark.acknowledged.add(agentId);
		return true;
	}

	// ── Query (感知环境) ─────────────────────────────────────────────

	/**
	 * 查询活动 Marks。自动清理过期 Marks。
	 */
	queryMarks(query: MarkQuery = {}): Mark[] {
		this.#decayExpired();

		const now = Date.now();
		let results: Mark[] = [];

		for (const mark of this.#marks.values()) {
			if (mark.expiresAt > 0 && mark.expiresAt < now) continue; // 已过期（已由 decayExpired 清理，二次确认）

			if (query.types && !query.types.includes(mark.type)) continue;
			if (query.agentId && mark.agentId !== query.agentId) continue;
			if (query.pathPrefix && mark.path && !mark.path.startsWith(query.pathPrefix)) continue;
			if (query.minPriority) {
				if (!priorityCompare(mark.priority, query.minPriority)) continue;
			}
			if (query.tags && query.tags.length > 0) {
				if (!query.tags.every(t => mark.tags.includes(t))) continue;
			}
			if (query.unacknowledgedOnly && mark.acknowledged.size > 0) continue;

			results.push(mark);
		}

		if (query.limit && results.length > query.limit) {
			results = results.slice(0, query.limit);
		}

		return results;
	}

	/**
	 * 获取指定 Agent 可见的活动 Marks。
	 * "可见" = 未过期 且 非自身创建（不标记自己）。
	 */
	getActiveMarksFor(agentId: string, options?: { minPriority?: MarkPriority; limit?: number }): Mark[] {
		this.#decayExpired();

		const now = Date.now();
		let results: Mark[] = [];

		for (const mark of this.#marks.values()) {
			if (mark.expiresAt > 0 && mark.expiresAt < now) continue;
			if (mark.agentId === agentId) continue; // 自身创建的不返回
			if (options?.minPriority && !priorityCompare(mark.priority, options.minPriority)) continue;

			results.push(mark);
		}

		results.sort((a, b) => b.createdAt - a.createdAt);

		if (options?.limit && results.length > options.limit) {
			results = results.slice(0, options.limit);
		}

		return results;
	}

	/**
	 * 获取指定路径上所有活动 Lock/Claim Marks。
	 * 用于 Guard Layer — 判断文件是否被他人锁定。
	 */
	getPathLocks(filePath: string, excludeAgentId?: string): Mark[] {
		this.#decayExpired();

		const pathMarks = this.#pathIndex.get(filePath);
		if (!pathMarks) return [];

		const now = Date.now();
		const locks: Mark[] = [];

		for (const id of pathMarks) {
			const mark = this.#marks.get(id);
			if (!mark) continue;
			if (mark.expiresAt > 0 && mark.expiresAt < now) continue;
			if (mark.type !== "lock" && mark.type !== "claim") continue;
			if (excludeAgentId && mark.agentId === excludeAgentId) continue;

			locks.push(mark);
		}

		return locks;
	}

	/** 指定路径是否被他人锁定 */
	isPathLocked(filePath: string, myAgentId: string): boolean {
		return this.getPathLocks(filePath, myAgentId).length > 0;
	}

	// ── Context Injection ────────────────────────────────────────────

	/**
	 * 为 Agent 生成环境感知上下文（用于 prompt 注入）。
	 * 包含：未确认的高优 Marks + 路径锁状态 + 队友状态信号。
	 */
	getContextForAgent(agentId: string): string {
		const active = this.getActiveMarksFor(agentId, { minPriority: "medium" });
		if (active.length === 0) return "";

		const warnings = active.filter(m => m.type === "warning");
		const signals = active.filter(m => m.type === "signal");
		const locks = active.filter(m => m.type === "lock" || m.type === "claim");
		const artifacts = active.filter(m => m.type === "artifact");

		const parts: string[] = ["<stigmergic_environment>"];

		if (warnings.length > 0) {
			parts.push("  <!-- WARNINGS — pay attention to these -->");
			for (const w of warnings) {
				parts.push(`  ⚠ [${w.priority}] ${w.agentId}: ${w.message}${w.path ? ` (${w.path})` : ""}`);
			}
		}

		if (locks.length > 0) {
			parts.push("  <!-- LOCKS — files currently owned by others, avoid conflicts -->");
			for (const l of locks) {
				parts.push(`  🔒 ${l.agentId} has a ${l.type} on ${l.path ?? "?"}: ${l.message}`);
			}
		}

		if (signals.length > 0) {
			parts.push("  <!-- SIGNALS — coordination messages from peers -->");
			for (const s of signals) {
				parts.push(`  📡 ${s.agentId}: ${s.message}`);
			}
		}

		if (artifacts.length > 0) {
			parts.push("  <!-- ARTIFACTS — completed work available for reuse -->");
			for (const a of artifacts) {
				parts.push(`  📦 ${a.agentId}: ${a.message}${a.path ? ` → ${a.path}` : ""}`);
			}
		}

		parts.push("</stigmergic_environment>");
		return parts.join("\n");
	}

	/** 获取环境状态摘要 */
	getSummary(): { total: number; byType: Record<string, number>; oldestAt: number } {
		const byType: Record<string, number> = {};
		let oldestAt = Date.now();

		for (const mark of this.#marks.values()) {
			byType[mark.type] = (byType[mark.type] ?? 0) + 1;
			if (mark.createdAt < oldestAt) oldestAt = mark.createdAt;
		}

		return {
			total: this.#marks.size,
			byType,
			oldestAt: this.#marks.size > 0 ? oldestAt : 0,
		};
	}

	/** 清空所有 Mark（用于测试） */
	clear(): void {
		this.#marks.clear();
		this.#ownerIndex.clear();
		this.#agentIndex.clear();
		this.#pathIndex.clear();
	}

	// ── Serialization ────────────────────────────────────────────────

	/**
	 * 序列化为纯 JSON（去循环引用，丢失 Set → 数组）。
	 * 可用于 session.jsonl 持久化，session 重启后通过 deserialize() 恢复。
	 */
	serialize(): MarkEnvironmentSnapshot {
		const marks: SerializedMark[] = [];
		for (const m of this.#marks.values()) {
			marks.push({
				markId: m.markId,
				type: m.type,
				agentId: m.agentId,
				path: m.path,
				message: m.message,
				priority: m.priority,
				createdAt: m.createdAt,
				expiresAt: m.expiresAt,
				acknowledged: [...m.acknowledged],
				tags: m.tags,
			});
		}
		return { marks, serializedAt: Date.now() };
	}

	/**
	 * 从快照恢复 MarkEnvironment。
	 * 自动跳过已过期的 Marks。
	 */
	deserialize(snapshot: MarkEnvironmentSnapshot): void {
		this.clear();
		const now = Date.now();

		for (const sm of snapshot.marks) {
			// 跳过已过期的
			if (sm.expiresAt > 0 && sm.expiresAt <= now) continue;

			this.#marks.set(sm.markId, {
				markId: sm.markId,
				type: sm.type as MarkType,
				agentId: sm.agentId,
				path: sm.path,
				message: sm.message,
				priority: sm.priority as MarkPriority,
				createdAt: sm.createdAt,
				expiresAt: sm.expiresAt,
				acknowledged: new Set(sm.acknowledged),
				tags: sm.tags,
			});
			this.#ownerIndex.set(sm.markId, sm.agentId);
			this.#addToIndex(this.#agentIndex, sm.agentId, sm.markId);
			if (sm.path) this.#addToIndex(this.#pathIndex, sm.path, sm.markId);
		}
	}

	// ── Internal ──────────────────────────────────────────────────────

	/**
	 * 惰性衰减：移除所有已过期的 Marks。
	 * 在每次 query 时自动调用，无定时器开销。
	 */
	#decayExpired(): void {
		const now = Date.now();
		const toRemove: string[] = [];

		for (const [id, mark] of this.#marks) {
			if (mark.expiresAt > 0 && mark.expiresAt <= now) {
				toRemove.push(id);
			}
		}

		for (const id of toRemove) {
			const mark = this.#marks.get(id);
			if (mark) this.#removeFromAll(mark);
		}
	}

	#addToIndex(index: Map<string, Set<string>>, key: string, markId: string): void {
		let set = index.get(key);
		if (!set) {
			set = new Set();
			index.set(key, set);
		}
		set.add(markId);
	}

	#removeFromAll(mark: Mark): void {
		this.#marks.delete(mark.markId);
		this.#ownerIndex.delete(mark.markId);

		const agentSet = this.#agentIndex.get(mark.agentId);
		if (agentSet) {
			agentSet.delete(mark.markId);
			if (agentSet.size === 0) this.#agentIndex.delete(mark.agentId);
		}

		if (mark.path) {
			const pathSet = this.#pathIndex.get(mark.path);
			if (pathSet) {
				pathSet.delete(mark.markId);
				if (pathSet.size === 0) this.#pathIndex.delete(mark.path);
			}
		}
	}
}

// ============================================================================
// Helpers
// ============================================================================

const PRIORITY_ORDER: Record<MarkPriority, number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

function priorityCompare(a: MarkPriority, min: MarkPriority): boolean {
	return PRIORITY_ORDER[a] >= PRIORITY_ORDER[min];
}
