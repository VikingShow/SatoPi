/**
 * tools/gh/execute.ts — op handlers for the github tool (stage 3 split).
 * Extracted from tools/gh/index.ts; helpers live in ./shared.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import type { AgentToolResult, AgentToolUpdateCallback } from "@satopi/pi-agent-core";
import { getWorktreeDir, hashPath } from "@satopi/pi-utils";
import type { Settings } from "../../config/settings";
import * as git from "../../utils/git";
import type { ToolSession } from "..";
import { formatShortSha } from "../gh-format";
import { type CacheStatus, getOrFetchView, invalidateAllForNumber, resolveGithubCacheAuthKey } from "../github-cache";
import { ToolError, throwIfAborted } from "../tool-errors";
import {
	apiCodeToSearchResult,
	apiCommitToSearchResult,
	apiIssueToSearchResult,
	apiRepoToSearchResult,
	appendRepoFlag,
	buildCommitRunWatchDetails,
	buildGhApiSearchArgs,
	buildRunWatchDetails,
	buildSearchDateQualifier,
	buildTextResult,
	composeSearchQuery,
	ensurePrRemote,
	fetchFailedJobLogs,
	fetchPrReviewComments,
	fetchRunSnapshot,
	fetchRunsForCommit,
	formatAuthor,
	formatCommitRunWatchResult,
	formatCommitRunWatchSnapshot,
	formatIssueView,
	formatLabels,
	formatPrCheckoutResult,
	formatPrPushResult,
	formatPrView,
	formatRepoView,
	formatRunWatchResult,
	formatRunWatchSnapshot,
	formatSearchCodeResults,
	formatSearchCommitsResults,
	formatSearchReposResults,
	formatSearchResults,
	GH_ISSUE_FIELDS,
	GH_ISSUE_FIELDS_NO_COMMENTS,
	GH_PR_CHECKOUT_FIELDS,
	GH_PR_FIELDS,
	GH_PR_FIELDS_NO_COMMENTS,
	GH_REPO_FIELDS,
	type GhApiSearchCodeItem,
	type GhApiSearchCommitItem,
	type GhApiSearchIssueItem,
	type GhApiSearchRepoItem,
	type GhApiSearchResponse,
	type GhIssueViewData,
	type GhPrCheckoutSummary,
	type GhPrViewData,
	type GhRepoViewData,
	type GhRunJobSnapshot,
	type GhRunSnapshot,
	type GhToolDetails,
	type GithubInput,
	getRunCollectionOutcome,
	getRunCollectionSignature,
	githubIssueJsonWithStateReasonFallback,
	githubRepoSlugEquals,
	isFailedJob,
	isRateLimitedGhError,
	normalizeOptionalString,
	normalizePrIdentifierList,
	normalizeText,
	parseIssueUrl,
	parsePositiveDecimalInt,
	parsePullRequestUrl,
	parseRunReference,
	pushLine,
	RUN_WATCH_FAST_WINDOW_MS,
	RUN_WATCH_GRACE_DEFAULT,
	RUN_WATCH_INTERVAL_DEFAULT,
	RUN_WATCH_INTERVAL_SLOW,
	RUN_WATCH_MAX_POLL_FAILURES,
	RUN_WATCH_NO_RUNS_GIVE_UP_MS,
	requireCurrentGitBranch,
	requireCurrentGitHead,
	requireGitRepoRoot,
	requireNonEmpty,
	requirePrimaryGitRepoRoot,
	resolveAvailableWorktreePath,
	resolveDefaultRepoMemoized,
	resolveGitHubBranchHead,
	resolveGitHubRepo,
	resolvePrBranchPushTarget,
	resolveSearchDateField,
	resolveSearchLimit,
	resolveSearchRepoScope,
	resolveTailLimit,
	saveArtifactText,
	toLocalBranchRef,
	tryResolveCurrentRepoFresh,
} from "./shared";

export async function executeRepoView(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const branch = normalizeOptionalString(params.branch);
	const args = ["repo", "view"];
	if (repo) {
		args.push(repo);
	}
	if (branch) {
		args.push("--branch", branch);
	}
	args.push("--json", GH_REPO_FIELDS.join(","));

	const data = await git.github.json<GhRepoViewData>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	return buildTextResult(formatRepoView(data, { repo, branch }), data.url);
}

// ────────────────────────────────────────────────────────────────────────────
// Cached issue/PR view fetchers
//
// Used by `executeIssueView`/`executePrView` and by the `issue://` / `pr://`
// internal-URL protocol handlers. The cache wrapper lives in `./github-cache`;
// the fresh fetchers stay here to share the existing formatter helpers.
// ────────────────────────────────────────────────────────────────────────────

export interface IssueViewLookupOptions {
	cwd: string;
	repo?: string;
	/** Issue number or GitHub issue URL. */
	issue: string;
	includeComments?: boolean;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

export interface PrViewLookupOptions {
	cwd: string;
	repo: string;
	number: number;
	includeComments?: boolean;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

export interface ViewLookupResult<T> {
	rendered: string;
	sourceUrl: string | undefined;
	payload: T;
	status: CacheStatus;
	fetchedAt: number;
}

async function fetchIssueViewFresh(
	cwd: string,
	repo: string | undefined,
	identifier: string,
	includeComments: boolean,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: GhIssueViewData }> {
	const args = ["issue", "view", identifier];
	appendRepoFlag(args, repo, identifier);
	args.push("--json", (includeComments ? GH_ISSUE_FIELDS : GH_ISSUE_FIELDS_NO_COMMENTS).join(","));
	const data = await githubIssueJsonWithStateReasonFallback<GhIssueViewData>(cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	const rendered = formatIssueView(data, { issue: identifier, repo, comments: includeComments });
	return { rendered, sourceUrl: data.url, payload: data };
}

async function fetchPrViewFresh(
	cwd: string,
	repo: string,
	number: number,
	includeComments: boolean,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: GhPrViewData }> {
	const args = ["pr", "view", String(number)];
	appendRepoFlag(args, repo, String(number));
	args.push("--json", (includeComments ? GH_PR_FIELDS : GH_PR_FIELDS_NO_COMMENTS).join(","));
	const data = await git.github.json<GhPrViewData>(cwd, args, signal, { repoProvided: true });
	if (includeComments && typeof data.number === "number") {
		data.reviewComments = await fetchPrReviewComments(cwd, repo, data.number, signal);
	}
	const rendered = formatPrView(data, { pr: String(number), repo, comments: includeComments });
	return { rendered, sourceUrl: data.url, payload: data };
}

/**
 * Cache-aware issue/view fetcher. Used by both the `github` tool op and the
 * `issue://` protocol handler so a single shared row services both surfaces.
 */
export async function getOrFetchIssue(options: IssueViewLookupOptions): Promise<ViewLookupResult<GhIssueViewData>> {
	const identifier = requireNonEmpty(options.issue, "issue");
	if (identifier.startsWith("-")) {
		throw new ToolError(`invalid issue identifier: ${identifier}. Pass an issue number or URL.`);
	}
	const includeComments = options.includeComments ?? true;
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const urlParse = parseIssueUrl(identifier);
	// Prefer the URL's repo when the identifier is a full URL; fall back to the
	// explicit `repo` option, then to the cwd's default repo.
	let repo = urlParse.repo ?? normalizeOptionalString(options.repo);
	let cacheNumber = urlParse.issueNumber;
	if (cacheNumber === undefined) {
		cacheNumber = parsePositiveDecimalInt(identifier);
	}
	if (cacheNumber !== undefined && !repo) {
		try {
			repo = await resolveDefaultRepoMemoized(options.cwd, options.signal);
		} catch {
			// Resolution failure leaves `repo` undefined: we'll fall through to a
			// direct fetch below so gh produces its own error message instead of
			// us masking it with a friendlier one.
			repo = undefined;
		}
	}

	const doFetch = () => fetchIssueViewFresh(options.cwd, repo, identifier, includeComments, options.signal);

	if (!repo || cacheNumber === undefined) {
		const fresh = await doFetch();
		return { ...fresh, status: "miss", fetchedAt: Date.now() };
	}

	const lookup = await getOrFetchView<GhIssueViewData>({
		repo,
		kind: "issue",
		number: cacheNumber,
		includeComments,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: lookup.payload,
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}

/**
 * Cache-aware PR view fetcher. Caller must supply a numeric PR number;
 * branch-name / current-branch lookups bypass the cache entirely upstream
 * (see `executePrView`).
 */
export async function getOrFetchPr(options: PrViewLookupOptions): Promise<ViewLookupResult<GhPrViewData>> {
	const includeComments = options.includeComments ?? true;
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const doFetch = () => fetchPrViewFresh(options.cwd, options.repo, options.number, includeComments, options.signal);
	const lookup = await getOrFetchView<GhPrViewData>({
		repo: options.repo,
		kind: "pr",
		number: options.number,
		includeComments,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: lookup.payload,
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}

// ────────────────────────────────────────────────────────────────────────────
// PR diff fetcher
//
// Used by the `pr://<n>/diff[/…]` internal-URL family. Stores the verbatim
// `gh pr diff` text plus a parsed file index so the listing, full-diff, and
// per-file slice variants all share one cache row.
// ────────────────────────────────────────────────────────────────────────────

export interface PrDiffFile {
	/** Display path. Prefers the post-image (`b/<path>`) when present. */
	path: string;
	additions: number;
	deletions: number;
	changeType: "modified" | "added" | "deleted" | "renamed" | "binary";
	/** Pre-image path for renames/deletes; same as `path` otherwise. */
	oldPath?: string;
	/** Byte offset of the section's `diff --git` line in the unified diff. */
	startOffset: number;
	/** Byte offset of the next section (or end-of-text). */
	endOffset: number;
}

export interface PrDiffPayload {
	/** Full unified diff text as returned by `gh pr diff --color never`. */
	unified: string;
	files: PrDiffFile[];
}

export interface PrDiffLookupOptions {
	cwd: string;
	repo: string;
	number: number;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}
/**
 * Split `gh pr diff` output on `^diff --git ` boundaries and parse per-file
 * metadata. The unified diff is preserved verbatim so callers can slice it by
 * byte offsets without re-running gh.
 */
export function parsePrUnifiedDiff(text: string): PrDiffPayload {
	const files: PrDiffFile[] = [];
	if (text.length === 0) {
		return { unified: text, files };
	}

	// Walk match positions manually so we capture each section's byte range.
	const sectionStarts: number[] = [];
	const re = /^diff --git /gm;
	let m: RegExpExecArray | null = re.exec(text);
	while (m !== null) {
		sectionStarts.push(m.index);
		// Avoid zero-length match infinite loop (regex has fixed prefix, but
		// be explicit).
		if (re.lastIndex === m.index) re.lastIndex += 1;
		m = re.exec(text);
	}

	for (let i = 0; i < sectionStarts.length; i += 1) {
		const startOffset = sectionStarts[i] ?? 0;
		const endOffset = sectionStarts[i + 1] ?? text.length;
		const section = text.slice(startOffset, endOffset);
		files.push(parsePrDiffSection(section, startOffset, endOffset));
	}
	return { unified: text, files };
}

interface ParsedDiffHeaderToken {
	value: string;
	nextIndex: number;
}

function skipDiffHeaderSpaces(text: string, index: number): number {
	let i = index;
	while (text.charAt(i) === " ") i += 1;
	return i;
}

function parseDiffQuotedEscape(text: string, slashIndex: number): ParsedDiffHeaderToken {
	const next = text.charAt(slashIndex + 1);
	if (next === "") return { value: "\\", nextIndex: slashIndex + 1 };

	if (next >= "0" && next <= "7") {
		let end = slashIndex + 1;
		while (end < text.length && end < slashIndex + 4) {
			const digit = text.charAt(end);
			if (digit < "0" || digit > "7") break;
			end += 1;
		}
		return {
			value: String.fromCharCode(Number.parseInt(text.slice(slashIndex + 1, end), 8)),
			nextIndex: end,
		};
	}

	switch (next) {
		case "a":
			return { value: "\x07", nextIndex: slashIndex + 2 };
		case "b":
			return { value: "\b", nextIndex: slashIndex + 2 };
		case "f":
			return { value: "\f", nextIndex: slashIndex + 2 };
		case "n":
			return { value: "\n", nextIndex: slashIndex + 2 };
		case "r":
			return { value: "\r", nextIndex: slashIndex + 2 };
		case "t":
			return { value: "\t", nextIndex: slashIndex + 2 };
		case "v":
			return { value: "\v", nextIndex: slashIndex + 2 };
		case "\\":
		case '"':
			return { value: next, nextIndex: slashIndex + 2 };
		default:
			return { value: next, nextIndex: slashIndex + 2 };
	}
}

function parseDiffQuotedToken(text: string, startIndex: number): ParsedDiffHeaderToken | undefined {
	if (text.charAt(startIndex) !== '"') return undefined;
	let value = "";
	for (let i = startIndex + 1; i < text.length; i += 1) {
		const ch = text.charAt(i);
		if (ch === '"') return { value, nextIndex: i + 1 };
		if (ch !== "\\") {
			value += ch;
			continue;
		}
		const escaped = parseDiffQuotedEscape(text, i);
		value += escaped.value;
		i = escaped.nextIndex - 1;
	}
	return undefined;
}

function parseDiffHeaderToken(text: string, startIndex: number): ParsedDiffHeaderToken | undefined {
	const start = skipDiffHeaderSpaces(text, startIndex);
	if (start >= text.length) return undefined;
	const quoted = parseDiffQuotedToken(text, start);
	if (quoted) return quoted;
	const end = text.indexOf(" ", start);
	if (end === -1) return { value: text.slice(start), nextIndex: text.length };
	return { value: text.slice(start, end), nextIndex: end };
}

function stripPrDiffPathPrefix(value: string, prefix: "a/" | "b/"): string | undefined {
	return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

function parsePrDiffHeaderPaths(header: string): { oldPath?: string; newPath?: string } {
	const trail = header.slice("diff --git ".length);
	if (trail.startsWith('"')) {
		const oldToken = parseDiffQuotedToken(trail, 0);
		if (!oldToken) return {};
		const newToken = parseDiffHeaderToken(trail, oldToken.nextIndex);
		if (!newToken) return {};
		return {
			oldPath: stripPrDiffPathPrefix(oldToken.value, "a/"),
			newPath: stripPrDiffPathPrefix(newToken.value, "b/"),
		};
	}

	const bIdx = trail.indexOf(" b/");
	if (trail.startsWith("a/") && bIdx > 0) {
		return {
			oldPath: trail.slice(2, bIdx),
			newPath: trail.slice(bIdx + 3),
		};
	}
	return {};
}

function isPrDiffFileHeaderLine(line: string): boolean {
	return (
		line === "--- /dev/null" ||
		line === "+++ /dev/null" ||
		line.startsWith("--- a/") ||
		line.startsWith("+++ b/") ||
		line.startsWith('--- "a/') ||
		line.startsWith('+++ "b/')
	);
}

function parsePrDiffSection(section: string, startOffset: number, endOffset: number): PrDiffFile {
	const lines = section.split("\n");
	const header = lines[0] ?? "";
	const headerPaths = parsePrDiffHeaderPaths(header);
	let oldPath = headerPaths.oldPath;
	let newPath = headerPaths.newPath;

	let changeType: PrDiffFile["changeType"] = "modified";
	let isBinary = false;
	let additions = 0;
	let deletions = 0;

	let inHunk = false;
	for (let li = 1; li < lines.length; li += 1) {
		const line = lines[li] ?? "";
		if (line.startsWith("new file mode")) {
			changeType = "added";
			continue;
		}
		if (line.startsWith("deleted file mode")) {
			changeType = "deleted";
			continue;
		}
		if (line.startsWith("rename from ")) {
			changeType = "renamed";
			oldPath = line.slice("rename from ".length);
			continue;
		}
		if (line.startsWith("rename to ")) {
			newPath = line.slice("rename to ".length);
			continue;
		}
		if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
			isBinary = true;
			continue;
		}
		if (line.startsWith("@@ ")) {
			inHunk = true;
			continue;
		}
		if (!inHunk && isPrDiffFileHeaderLine(line)) continue;
		if (line.startsWith("+")) {
			additions += 1;
		} else if (line.startsWith("-")) {
			deletions += 1;
		}
	}

	if (isBinary) {
		if (changeType === "modified") changeType = "binary";
		additions = 0;
		deletions = 0;
	}

	const displayPath =
		changeType === "deleted" ? (oldPath ?? newPath ?? "(unknown)") : (newPath ?? oldPath ?? "(unknown)");
	const file: PrDiffFile = {
		path: displayPath,
		additions,
		deletions,
		changeType,
		startOffset,
		endOffset,
	};
	if (oldPath && oldPath !== displayPath) {
		file.oldPath = oldPath;
	}
	return file;
}

async function fetchPrDiffFresh(
	cwd: string,
	repo: string,
	number: number,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: PrDiffPayload }> {
	const args = ["pr", "diff", String(number), "--color", "never"];
	appendRepoFlag(args, repo, String(number));
	const text = await git.github.text(cwd, args, signal, { repoProvided: true, trimOutput: false });
	const payload = parsePrUnifiedDiff(text);
	// `rendered` already carries the verbatim diff; blank the payload copy so
	// the cache row stores a potentially huge diff once instead of twice.
	// `getOrFetchPrDiff` rehydrates `unified` from `rendered`.
	return { rendered: text, sourceUrl: undefined, payload: { unified: "", files: payload.files } };
}

/**
 * Cache-aware PR diff fetcher. Stores the full unified diff plus a parsed
 * file index in a single `pr-diff` cache row so the listing, full-diff, and
 * per-file slice variants of `pr://<n>/diff` share one `gh pr diff`
 * invocation.
 */
export async function getOrFetchPrDiff(options: PrDiffLookupOptions): Promise<ViewLookupResult<PrDiffPayload>> {
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const doFetch = () => fetchPrDiffFresh(options.cwd, options.repo, options.number, options.signal);
	const lookup = await getOrFetchView<PrDiffPayload>({
		repo: options.repo,
		kind: "pr-diff",
		number: options.number,
		includeComments: false,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		// Rehydrate the unified text from `rendered` (stored once per row).
		payload: { unified: lookup.rendered, files: lookup.payload.files },
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}

function joinSections(sections: string[]): string[] {
	return sections.flatMap((section, idx) => (idx === 0 ? [section] : ["", "---", "", section]));
}

export async function executePrCheckout(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const force = params.force ?? false;
	const prList = normalizePrIdentifierList(params.pr);
	const prRefs = prList.length > 0 ? prList : [undefined];
	const isMulti = prRefs.length > 1;

	const settled = await Promise.allSettled(
		prRefs.map(prRef => checkoutPullRequest(session, signal, { prRef, repo, force })),
	);
	const outcomes: PrCheckoutOutcome[] = [];
	const failures: Array<{ prRef: string | undefined; reason: unknown }> = [];
	for (let i = 0; i < settled.length; i++) {
		const entry = settled[i];
		if (entry.status === "fulfilled") outcomes.push(entry.value);
		else failures.push({ prRef: prRefs[i], reason: entry.reason });
	}
	if (failures.length > 0) {
		throwIfAborted(signal);
		const failureLines = failures.map(
			f => `- ${f.prRef ?? "(current branch)"}: ${f.reason instanceof Error ? f.reason.message : String(f.reason)}`,
		);
		if (outcomes.length === 0) {
			if (failures.length === 1) throw failures[0].reason;
			throw new ToolError(`all ${failures.length} PR checkouts failed:\n${failureLines.join("\n")}`);
		}
		// Partial success: report the worktrees that did get created alongside
		// the failures so the agent does not lose track of them.
		const sections = outcomes.map(formatPrCheckoutResult);
		const header = `# ${outcomes.length}/${settled.length} Pull Request Worktrees checked out (${failures.length} failed)`;
		const text = [header, "", ...joinSections(sections), "", "## Failed", ...failureLines].join("\n").trim();
		return buildTextResult(text, undefined, {
			repo,
			checkouts: outcomes.map(outcomeToSummary),
		});
	}

	if (!isMulti) {
		const [outcome] = outcomes;
		return buildTextResult(formatPrCheckoutResult(outcome), outcome.data.url, {
			repo: repo ?? outcome.data.headRepository?.nameWithOwner,
			branch: outcome.localBranch,
			worktreePath: outcome.worktreePath,
			remote: outcome.remoteName,
			remoteBranch: outcome.headRefName,
			checkouts: [outcomeToSummary(outcome)],
		});
	}

	const sections = outcomes.map(formatPrCheckoutResult);
	const reusedCount = outcomes.reduce((acc, o) => acc + (o.reused ? 1 : 0), 0);
	const newCount = outcomes.length - reusedCount;
	const headerParts: string[] = [];
	if (newCount > 0) headerParts.push(`${newCount} checked out`);
	if (reusedCount > 0) headerParts.push(`${reusedCount} reused`);
	const header = `# ${outcomes.length} Pull Request Worktrees (${headerParts.join(", ")})`;
	const text = [header, "", ...joinSections(sections)].join("\n").trim();

	return buildTextResult(text, undefined, {
		repo,
		checkouts: outcomes.map(outcomeToSummary),
	});
}

interface PrCheckoutOptions {
	prRef: string | undefined;
	repo: string | undefined;
	force: boolean;
}

interface PrCheckoutOutcome {
	data: GhPrViewData;
	localBranch: string;
	worktreePath: string;
	remoteName: string;
	remoteUrl: string;
	headRefName: string;
	reused: boolean;
}

async function checkoutPullRequest(
	session: ToolSession,
	signal: AbortSignal | undefined,
	options: PrCheckoutOptions,
): Promise<PrCheckoutOutcome> {
	const { prRef, repo, force } = options;
	if (prRef?.startsWith("-")) {
		throw new ToolError(`invalid PR identifier: ${prRef}. Pass a PR number, URL, or branch name.`);
	}
	const args = ["pr", "view"];
	if (prRef) args.push(prRef);
	appendRepoFlag(args, repo, prRef);
	args.push("--json", GH_PR_CHECKOUT_FIELDS.join(","));

	const data = await git.github.json<GhPrViewData>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	const prNumber = data.number;
	if (typeof prNumber !== "number") {
		throw new ToolError("GitHub CLI did not return a pull request number.");
	}

	const headRefName = requireNonEmpty(data.headRefName, "head branch");
	const headRefOid = requireNonEmpty(data.headRefOid, "head commit");
	const repoRoot = await requireGitRepoRoot(session.cwd, signal);
	const primaryRepoRoot = await requirePrimaryGitRepoRoot(repoRoot, signal);
	const localBranch = `pr-${prNumber}`;
	const worktreePath = getWorktreeDir(`${prNumber}-${hashPath(primaryRepoRoot)}`);

	// Every git mutation against `repoRoot` from here on must run under the
	// per-repo lock. Worktrees of the same primary repo share `.git/config`,
	// `commit-graph` chain, `packed-refs`, and worktree metadata files — git
	// uses O_EXCL lock files for each, with no waiter. Concurrent in-process
	// callers (e.g. parallel `pr_checkout` calls) would otherwise lose lock
	// races and surface "could not lock config file" / "Another git process
	// seems to be running" errors. The gh API call above stays outside the
	// lock so multiple checkouts can fetch PR metadata in parallel.
	return git.withRepoLock(
		repoRoot,
		async () => {
			const existingWorktrees = await git.worktree.list(repoRoot, signal);
			const existingWorktree = existingWorktrees.find(entry => entry.branch === toLocalBranchRef(localBranch));

			const remote = await ensurePrRemote(repoRoot, data, signal);
			await git.fetch(
				repoRoot,
				remote.name,
				`refs/heads/${headRefName}`,
				`refs/remotes/${remote.name}/${headRefName}`,
				{ signal },
			);

			if (!existingWorktree) {
				const localBranchRef = toLocalBranchRef(localBranch);
				const localBranchExists = await git.ref.exists(repoRoot, localBranchRef, signal);
				if (localBranchExists) {
					const existingOid = await git.ref.resolve(repoRoot, localBranchRef, signal);
					if (existingOid !== headRefOid) {
						if (!force) {
							throw new ToolError(
								`local branch ${localBranch} already exists at ${formatShortSha(existingOid ?? undefined) ?? existingOid ?? "unknown commit"}; pass force=true to reset it`,
							);
						}

						await git.branch.force(repoRoot, localBranch, `refs/remotes/${remote.name}/${headRefName}`, signal);
					}
				} else {
					await git.branch.create(repoRoot, localBranch, `refs/remotes/${remote.name}/${headRefName}`, signal);
				}
			}

			await git.config.setBranch(repoRoot, localBranch, "remote", remote.name, signal);
			await git.config.setBranch(repoRoot, localBranch, "merge", `refs/heads/${headRefName}`, signal);
			await git.config.setBranch(repoRoot, localBranch, "pushRemote", remote.name, signal);
			await git.config.setBranch(repoRoot, localBranch, "ompPrHeadRef", headRefName, signal);
			await git.config.setBranch(repoRoot, localBranch, "ompPrUrl", data.url ?? "", signal);
			await git.config.setBranch(
				repoRoot,
				localBranch,
				"ompPrIsCrossRepository",
				String(Boolean(data.isCrossRepository)),
				signal,
			);
			await git.config.setBranch(
				repoRoot,
				localBranch,
				"ompPrMaintainerCanModify",
				String(Boolean(data.maintainerCanModify)),
				signal,
			);

			let finalWorktreePath = existingWorktree?.path ?? worktreePath;
			if (!existingWorktree) {
				finalWorktreePath = await resolveAvailableWorktreePath(worktreePath, existingWorktrees);
				await fs.mkdir(path.dirname(finalWorktreePath), { recursive: true });
				await git.worktree.add(repoRoot, finalWorktreePath, localBranch, { signal });
			}
			const resolvedWorktreePath = await fs.realpath(finalWorktreePath);

			return {
				data,
				localBranch,
				worktreePath: resolvedWorktreePath,
				remoteName: remote.name,
				remoteUrl: remote.url,
				headRefName,
				reused: Boolean(existingWorktree),
			};
		},
		signal,
	);
}

function outcomeToSummary(outcome: PrCheckoutOutcome): GhPrCheckoutSummary {
	return {
		prNumber: typeof outcome.data.number === "number" ? outcome.data.number : undefined,
		url: outcome.data.url ?? undefined,
		branch: outcome.localBranch,
		worktreePath: outcome.worktreePath,
		remote: outcome.remoteName,
		remoteBranch: outcome.headRefName,
		reused: outcome.reused,
	};
}

export async function executePrPush(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repoRoot = await requireGitRepoRoot(session.cwd, signal);
	const localBranch = normalizeOptionalString(params.branch) ?? (await requireCurrentGitBranch(repoRoot, signal));
	const refExists = await git.ref.exists(repoRoot, toLocalBranchRef(localBranch), signal);
	if (!refExists) {
		throw new ToolError(`local branch ${localBranch} does not exist`);
	}

	const target = await resolvePrBranchPushTarget(repoRoot, localBranch, signal);
	const currentBranch = await git.branch.current(repoRoot, signal);
	const sourceRef = currentBranch === localBranch ? "HEAD" : toLocalBranchRef(localBranch);
	const refspec = `${sourceRef}:refs/heads/${target.remoteBranch}`;
	await git.push(repoRoot, {
		forceWithLease: params.forceWithLease,
		refspec,
		remote: target.remoteName,
		signal,
	});

	// A successful push changes what `pr://N` and `pr://N/diff` should show;
	// drop the cached rows so the canonical "push → re-read diff" flow sees
	// fresh data instead of a soft-TTL stale snapshot.
	const pushedPr = parsePullRequestUrl(target.prUrl);
	if (pushedPr.prNumber !== undefined) {
		invalidateAllForNumber(pushedPr.prNumber, pushedPr.repo);
	}

	return buildTextResult(
		formatPrPushResult({
			localBranch,
			remoteName: target.remoteName,
			remoteBranch: target.remoteBranch,
			remoteUrl: target.remoteUrl,
			prUrl: target.prUrl,
			forceWithLease: params.forceWithLease ?? false,
		}),
		target.prUrl,
		{
			branch: localBranch,
			remote: target.remoteName,
			remoteBranch: target.remoteBranch,
		},
	);
}

export async function executePrCreate(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const title = normalizeOptionalString(params.title);
	const body = params.body;
	const base = normalizeOptionalString(params.base);
	const head = normalizeOptionalString(params.head);
	const draft = params.draft ?? false;
	const fill = params.fill ?? false;
	const reviewers = normalizePrIdentifierList(params.reviewer);
	const assignees = normalizePrIdentifierList(params.assignee);
	const labels = normalizePrIdentifierList(params.label);

	if (!fill && !title) {
		throw new ToolError("title is required unless fill is true");
	}
	if (fill && (title || body !== undefined)) {
		throw new ToolError("fill is mutually exclusive with title and body");
	}

	const args = ["pr", "create"];
	appendRepoFlag(args, repo);
	if (title) args.push("--title", title);
	if (base) args.push("--base", base);
	if (head) args.push("--head", head);
	if (draft) args.push("--draft");
	if (fill) args.push("--fill");
	for (const reviewer of reviewers) args.push("--reviewer", reviewer);
	for (const assignee of assignees) args.push("--assignee", assignee);
	for (const label of labels) args.push("--label", label);

	let bodyDir: string | undefined;
	try {
		if (!fill) {
			if (body !== undefined && body.length > 0) {
				// Route through a temp file so multi-KB bodies stay clear of any
				// argv-length limits and shell-quoting hazards on uncommon platforms.
				bodyDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-pr-body-"));
				const bodyFile = path.join(bodyDir, "body.md");
				await Bun.write(bodyFile, body);
				args.push("--body-file", bodyFile);
			} else {
				// Avoid gh dropping into an interactive editor when no body is given.
				args.push("--body", "");
			}
		}

		const output = await git.github.text(session.cwd, args, signal, {
			repoProvided: Boolean(repo),
		});
		const url =
			output
				.split("\n")
				.map(line => line.trim())
				.find(line => line.startsWith("https://github.com/")) ?? output.trim();
		const parsed = parsePullRequestUrl(url);
		const resolvedRepo = repo ?? parsed.repo;

		let prView: GhPrViewData | undefined;
		if (resolvedRepo && parsed.prNumber !== undefined) {
			try {
				prView = await git.github.json<GhPrViewData>(
					session.cwd,
					[
						"pr",
						"view",
						String(parsed.prNumber),
						"--repo",
						resolvedRepo,
						"--json",
						GH_PR_FIELDS_NO_COMMENTS.join(","),
					],
					signal,
					{ repoProvided: true },
				);
			} catch {
				// Best-effort summary; PR creation already succeeded.
			}
		}

		const text = formatPrCreateResult({
			url,
			prNumber: parsed.prNumber,
			data: prView,
			title,
			base,
			head,
			draft,
		});
		return buildTextResult(text, url || prView?.url);
	} finally {
		if (bodyDir) {
			await fs.rm(bodyDir, { recursive: true, force: true }).catch(() => {});
		}
	}
}

function formatPrCreateResult(options: {
	url: string;
	prNumber?: number;
	data?: GhPrViewData;
	title?: string;
	base?: string;
	head?: string;
	draft?: boolean;
}): string {
	const number = options.prNumber ?? options.data?.number;
	const headerTitle = options.data?.title ?? options.title ?? "Untitled";
	const header =
		number !== undefined
			? `# Created Pull Request #${number}: ${headerTitle}`
			: `# Created Pull Request: ${headerTitle}`;
	const lines: string[] = [header, ""];
	pushLine(lines, "URL", options.url || options.data?.url);
	pushLine(lines, "State", options.data?.state);
	pushLine(lines, "Draft", options.data?.isDraft ?? options.draft);
	pushLine(lines, "Base", options.data?.baseRefName ?? options.base);
	pushLine(lines, "Head", options.data?.headRefName ?? options.head);
	pushLine(lines, "Author", formatAuthor(options.data?.author));
	pushLine(lines, "Created", options.data?.createdAt);
	pushLine(lines, "Labels", formatLabels(options.data?.labels));

	const bodyText = normalizeText(options.data?.body);
	if (bodyText) {
		lines.push("");
		lines.push("## Body");
		lines.push("");
		lines.push(bodyText);
	}

	return lines.join("\n").trim();
}

export async function executeSearchIssues(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("issues", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const displayQuery = composeSearchQuery([params.query, dateQualifier]);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), displayQuery, signal);
	const apiQuery = composeSearchQuery([displayQuery, repo ? `repo:${repo}` : undefined, "is:issue"]);
	const args = buildGhApiSearchArgs("issues", apiQuery, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchIssueItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiIssueToSearchResult);
	return buildTextResult(formatSearchResults("issues", displayQuery, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

export async function executeSearchPrs(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("prs", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const displayQuery = composeSearchQuery([params.query, dateQualifier]);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), displayQuery, signal);
	const apiQuery = composeSearchQuery([displayQuery, repo ? `repo:${repo}` : undefined, "is:pr"]);
	const args = buildGhApiSearchArgs("issues", apiQuery, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchIssueItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiIssueToSearchResult);
	return buildTextResult(formatSearchResults("pull requests", displayQuery, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

export async function executeSearchCode(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const query = requireNonEmpty(params.query, "query");
	if (params.since !== undefined || params.until !== undefined) {
		throw new ToolError("search_code does not support since/until; GitHub code search has no date qualifier.");
	}
	const limit = resolveSearchLimit(params.limit);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), query, signal);
	const apiQuery = composeSearchQuery([query, repo ? `repo:${repo}` : undefined]);
	const args = buildGhApiSearchArgs("code", apiQuery, limit, ["Accept: application/vnd.github.text-match+json"]);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchCodeItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiCodeToSearchResult);
	return buildTextResult(formatSearchCodeResults(query, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

export async function executeSearchCommits(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("commits", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const displayQuery = composeSearchQuery([params.query, dateQualifier]);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), displayQuery, signal);
	const apiQuery = composeSearchQuery([displayQuery, repo ? `repo:${repo}` : undefined]);
	const args = buildGhApiSearchArgs("commits", apiQuery, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchCommitItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiCommitToSearchResult);
	return buildTextResult(formatSearchCommitsResults(displayQuery, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

export async function executeSearchRepos(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("repos", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const query = composeSearchQuery([params.query, dateQualifier]);
	const args = buildGhApiSearchArgs("repositories", query, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchRepoItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiRepoToSearchResult);
	return buildTextResult(formatSearchReposResults(query, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

export async function executeRunWatch(
	session: ToolSession,
	toolName: string,
	params: GithubInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<GhToolDetails> | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const branchInput = normalizeOptionalString(params.branch);
	const explicitRepo = normalizeOptionalString(params.repo);
	const runReference = parseRunReference(params.run);
	const repo = await resolveGitHubRepo(session.cwd, explicitRepo, runReference.repo, signal);
	const graceSeconds = RUN_WATCH_GRACE_DEFAULT;
	const tail = resolveTailLimit(params.tail);
	const watchStartMs = Date.now();
	// Fast polls for the first minute for snappy feedback, then back off:
	// every commit-watch poll is one runs-list call plus one jobs call per
	// non-completed run, and long builds must not burn the shared
	// authenticated REST quota.
	const currentIntervalSeconds = () =>
		Date.now() - watchStartMs < RUN_WATCH_FAST_WINDOW_MS ? RUN_WATCH_INTERVAL_DEFAULT : RUN_WATCH_INTERVAL_SLOW;
	let consecutivePollFailures = 0;
	const handlePollError = async (err: unknown): Promise<void> => {
		if (signal?.aborted) throw err;
		consecutivePollFailures += 1;
		if (!isRateLimitedGhError(err) || consecutivePollFailures > RUN_WATCH_MAX_POLL_FAILURES) throw err;
		// Rate-limited: back off with the slow interval and retry instead of
		// discarding the whole watch (and its accumulated context).
		await scheduler.wait(RUN_WATCH_INTERVAL_SLOW * 1000, { signal });
	};
	if (runReference.runId !== undefined) {
		const runId = runReference.runId;
		let pollCount = 0;

		while (true) {
			throwIfAborted(signal);
			pollCount += 1;

			let run: GhRunSnapshot;
			try {
				run = await fetchRunSnapshot(session.cwd, repo, runId, signal);
			} catch (err) {
				await handlePollError(err);
				continue;
			}
			consecutivePollFailures = 0;
			const details = buildRunWatchDetails(repo, run, {
				state: "watching",
				pollCount,
			});
			onUpdate?.({
				content: [{ type: "text", text: formatRunWatchSnapshot(repo, run, pollCount) }],
				details,
			});

			let failedJobs = run.jobs.filter(isFailedJob);
			const runCompleted = run.status === "completed";

			if (failedJobs.length > 0) {
				if (!runCompleted && graceSeconds > 0) {
					const note = `Failure detected. Waiting ${graceSeconds}s to capture concurrent failures before fetching logs.`;
					onUpdate?.({
						content: [
							{
								type: "text",
								text: formatRunWatchSnapshot(repo, run, pollCount, note),
							},
						],
						details: buildRunWatchDetails(repo, run, {
							state: "watching",
							pollCount,
							note,
						}),
					});
					await scheduler.wait(graceSeconds * 1000, { signal });
					try {
						const refetched = await fetchRunSnapshot(session.cwd, repo, runId, signal);
						const refetchedFailed = refetched.jobs.filter(isFailedJob);
						// An auto-retry can reset job conclusions between
						// detection and refetch; keep the originally-detected
						// failure list (and its snapshot) when the refetch no
						// longer shows any failures so the watch never ends
						// with a failure result and zero logs.
						if (refetchedFailed.length > 0) {
							run = refetched;
							failedJobs = refetchedFailed;
						}
					} catch (err) {
						if (signal?.aborted) throw err;
						// Refetch failure: report from the original snapshot.
					}
				}

				const failedJobLogs = await fetchFailedJobLogs(
					session.cwd,
					repo,
					failedJobs.map(job => ({ run, job })),
					tail,
					signal,
				);
				const finalDetails = buildRunWatchDetails(repo, run, {
					state: "completed",
					failedJobLogs,
				});
				const artifactId = await saveArtifactText(
					session,
					toolName,
					formatRunWatchResult(repo, run, failedJobLogs, tail, { mode: "full" }),
				);
				return buildTextResult(
					formatRunWatchResult(repo, run, failedJobLogs, tail),
					run.url,
					{ ...finalDetails, artifactId },
					{ artifactId, artifactLabel: "Full failed-job logs" },
				);
			}

			if (runCompleted) {
				const finalDetails = buildRunWatchDetails(repo, run, {
					state: "completed",
				});
				return buildTextResult(formatRunWatchResult(repo, run, [], tail), run.url, finalDetails);
			}

			await scheduler.wait(currentIntervalSeconds() * 1000, { signal });
		}
	}

	let branch: string;
	let headSha: string;
	if (branchInput) {
		branch = branchInput;
		headSha = await resolveGitHubBranchHead(session.cwd, repo, branch, signal);
	} else {
		// No branch/run selector — derive the commit from the current checkout,
		// but only when cwd actually points at `repo`. Otherwise we'd watch an
		// unrelated commit SHA against the explicit repo and silently stream a
		// confident wrong-repo status (issue #1949). GitHub `owner/repo` slugs
		// are case-insensitive — `gh repo view` returns the canonical casing
		// while callers may pass any casing — so the equality check normalizes
		// both sides before deciding the cwd is a different repo (PR #1951).
		const cwdRepo = await tryResolveCurrentRepoFresh(session.cwd, signal);
		if (!githubRepoSlugEquals(cwdRepo, repo)) {
			throw new ToolError(
				`Cannot infer the watched commit for ${repo}: current checkout is ${cwdRepo ?? "not a GitHub repository"}. Pass \`branch\` or \`run\` to scope the watch.`,
			);
		}
		branch = await requireCurrentGitBranch(session.cwd, signal);
		headSha = await requireCurrentGitHead(session.cwd, signal);
	}
	let pollCount = 0;
	let settledSuccessSignature: string | undefined;
	let everSawRuns = false;
	const completedRunJobsCache = new Map<number, GhRunJobSnapshot[]>();

	while (true) {
		throwIfAborted(signal);
		pollCount += 1;

		let runs: GhRunSnapshot[];
		try {
			runs = await fetchRunsForCommit(session.cwd, repo, headSha, signal, completedRunJobsCache);
		} catch (err) {
			await handlePollError(err);
			continue;
		}
		consecutivePollFailures = 0;
		if (runs.length > 0) everSawRuns = true;
		const details = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
			state: "watching",
			pollCount,
		});
		onUpdate?.({
			content: [{ type: "text", text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount) }],
			details,
		});

		const outcome = getRunCollectionOutcome(runs);
		if (outcome === "failure") {
			let failedPairs = runs.flatMap(run => run.jobs.filter(isFailedJob).map(job => ({ run, job })));
			if (graceSeconds > 0) {
				const note = `Failure detected. Waiting ${graceSeconds}s to capture concurrent failures before fetching logs.`;
				onUpdate?.({
					content: [
						{
							type: "text",
							text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount, note),
						},
					],
					details: buildCommitRunWatchDetails(repo, headSha, branch, runs, {
						state: "watching",
						pollCount,
						note,
					}),
				});
				await scheduler.wait(graceSeconds * 1000, { signal });
				try {
					const refetched = await fetchRunsForCommit(session.cwd, repo, headSha, signal, completedRunJobsCache);
					const refetchedPairs = refetched.flatMap(run => run.jobs.filter(isFailedJob).map(job => ({ run, job })));
					// Keep the originally-detected failure list when an
					// auto-retry reset the conclusions during the grace window
					// (see the run-id branch above).
					if (refetchedPairs.length > 0) {
						runs = refetched;
						failedPairs = refetchedPairs;
					}
				} catch (err) {
					if (signal?.aborted) throw err;
					// Refetch failure: report from the original snapshots.
				}
			}

			const failedJobLogs = await fetchFailedJobLogs(session.cwd, repo, failedPairs, tail, signal);
			const finalDetails = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
				state: "completed",
				failedJobLogs,
			});
			const artifactId = await saveArtifactText(
				session,
				toolName,
				formatCommitRunWatchResult(repo, headSha, branch, runs, failedJobLogs, tail, { mode: "full" }),
			);
			return buildTextResult(
				formatCommitRunWatchResult(repo, headSha, branch, runs, failedJobLogs, tail),
				undefined,
				{ ...finalDetails, artifactId },
				{ artifactId, artifactLabel: "Full failed-job logs" },
			);
		}

		if (outcome === "success") {
			const signature = getRunCollectionSignature(runs);
			if (signature === settledSuccessSignature) {
				const finalDetails = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
					state: "completed",
				});
				return buildTextResult(
					formatCommitRunWatchResult(repo, headSha, branch, runs, [], tail),
					undefined,
					finalDetails,
				);
			}

			settledSuccessSignature = signature;
			const confirmWaitSeconds = currentIntervalSeconds();
			const note = `All known workflow runs completed successfully. Waiting ${confirmWaitSeconds}s to ensure no additional runs appear for this commit.`;
			onUpdate?.({
				content: [
					{
						type: "text",
						text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount, note),
					},
				],
				details: buildCommitRunWatchDetails(repo, headSha, branch, runs, {
					state: "watching",
					pollCount,
					note,
				}),
			});
			await scheduler.wait(confirmWaitSeconds * 1000, { signal });
			continue;
		}

		settledSuccessSignature = undefined;
		if (!everSawRuns && Date.now() - watchStartMs >= RUN_WATCH_NO_RUNS_GIVE_UP_MS) {
			// A repo with no Actions configured (or Actions disabled) never
			// produces a run for this commit; give up with a clear message
			// instead of polling forever.
			const elapsedSec = Math.round((Date.now() - watchStartMs) / 1000);
			return buildTextResult(
				`No workflow runs found for ${repo}@${formatShortSha(headSha) ?? headSha} after ${elapsedSec}s (${pollCount} polls). The commit may not trigger any GitHub Actions workflows, or Actions may be disabled for this repository. Pass \`run\` to watch a specific run.`,
				undefined,
				buildCommitRunWatchDetails(repo, headSha, branch, runs, { state: "completed", pollCount }),
				{ useless: true },
			);
		}
		await scheduler.wait(currentIntervalSeconds() * 1000, { signal });
	}
}
