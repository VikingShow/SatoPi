/**
 * tools/gh/index.ts — GithubTool class + op dispatch (stage 3 split).
 * Helpers live in ./shared; op handlers live in ./execute.
 */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@satopi/pi-agent-core";
import { prompt, untilAborted } from "@satopi/pi-utils";
import githubDescription from "../../prompts/tools/github.md" with { type: "text" };
import * as git from "../../utils/git";
import type { ToolSession } from "..";
import {
	executePrCheckout,
	executePrCreate,
	executePrPush,
	executeRepoView,
	executeRunWatch,
	executeSearchCode,
	executeSearchCommits,
	executeSearchIssues,
	executeSearchPrs,
	executeSearchRepos,
} from "./execute";
import { type GhToolDetails, GITHUB_READONLY_OPS, type GithubInput, githubSchema } from "./shared";

export {
	executePrCheckout,
	executePrCreate,
	executePrPush,
	executeRepoView,
	executeRunWatch,
	executeSearchCode,
	executeSearchCommits,
	executeSearchIssues,
	executeSearchPrs,
	executeSearchRepos,
	getOrFetchIssue,
	getOrFetchPr,
	getOrFetchPrDiff,
	type IssueViewLookupOptions,
	type PrDiffFile,
	type PrDiffLookupOptions,
	type PrDiffPayload,
	type PrViewLookupOptions,
	parsePrUnifiedDiff,
	type ViewLookupResult,
} from "./execute";
export * from "./shared";

export class GithubTool implements AgentTool<typeof githubSchema, GhToolDetails> {
	readonly name = "github";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawOp = (args as Partial<GithubInput>).op;
		const op = typeof rawOp === "string" ? rawOp : "";
		return GITHUB_READONLY_OPS.has(op) ? "read" : "exec";
	};
	readonly summary = "Interact with GitHub issues, pull requests, and repositories";
	readonly loadMode = "discoverable";
	readonly label = "GitHub";
	readonly description = prompt.render(githubDescription);
	readonly parameters = githubSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): GithubTool | null {
		if (!git.github.available()) return null;
		return new GithubTool(session);
	}

	async execute(
		_toolCallId: string,
		params: GithubInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<GhToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GhToolDetails>> {
		return untilAborted(signal, async () => {
			switch (params.op) {
				case "repo_view":
					return executeRepoView(this.session, params, signal);
				case "pr_create":
					return executePrCreate(this.session, params, signal);
				case "pr_checkout":
					return executePrCheckout(this.session, params, signal);
				case "pr_push":
					return executePrPush(this.session, params, signal);
				case "search_issues":
					return executeSearchIssues(this.session, params, signal);
				case "search_prs":
					return executeSearchPrs(this.session, params, signal);
				case "search_code":
					return executeSearchCode(this.session, params, signal);
				case "search_commits":
					return executeSearchCommits(this.session, params, signal);
				case "search_repos":
					return executeSearchRepos(this.session, params, signal);
				case "run_watch":
					return executeRunWatch(this.session, this.name, params, signal, onUpdate);
			}
		});
	}
}
