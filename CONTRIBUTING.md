# Contributing to oh-my-pi

Thanks for your interest in contributing. This project uses a lightweight
**vouch** system to decide who can open pull requests. Please read this before
opening a PR.

## TL;DR

- **Issues are open to everyone.** File bugs, feature requests, and questions
  freely — they are triaged automatically.
- **Pull requests require a vouch.** A PR whose author is not vouched (or is
  denounced) is **closed automatically**. If you are not yet vouched, do **not**
  open a PR to get noticed — it will be closed on sight. Start a Discussion and
  ask to be vouched first (see below).

## Who can open PRs

A pull request is accepted when its author is any of:

- a repository collaborator (write access or above), or a bot; or
- listed — without a leading `-` — in [`.github/VOUCHED.td`](.github/VOUCHED.td).

Anyone **denounced** (prefixed with `-` in that file) is always blocked.

## Getting vouched

1. Open a [Discussion](../../discussions) (or comment on an existing one)
   describing what you'd like to contribute.
2. A maintainer vouches you by commenting **`!vouch`** (vouches the discussion
   author) or **`!vouch @your-handle`** on that discussion.
3. Once you appear in `.github/VOUCHED.td`, open your PR — it stays open and is
   reviewed.

Maintainers may also `!denounce [@user]` and `!unvouch [@user]`. Only
collaborators with admin/maintain/write can run these commands.

## What happens to your PR

| You are… | Result |
| --- | --- |
| Vouched (or a collaborator) | PR stays open → automated review → human review |
| Not vouched | PR closed with a comment — get vouched, then reopen or open a new PR |
| Denounced | PR closed |

Pushing more commits to an open, vouched PR is fine — it remains vouched.

## The VOUCHED.td file

[`.github/VOUCHED.td`](.github/VOUCHED.td) is the source of truth: one handle per
line, sorted alphabetically, optionally `platform:handle`, with `-` marking a
denouncement and an optional reason after the handle. The format follows
[mitchellh/vouch](https://github.com/mitchellh/vouch); the denouncement list is
intentionally public so other projects can reuse our prior knowledge of bad
actors.

## Development Environment

**Prerequisites:** [Bun](https://bun.sh) >= 1.3 (the repo pins `bun@1.3.14` via
`packageManager`). On first checkout:

```sh
bun install                # install all workspace dependencies
bun run build:native       # compile the Rust crate (pi-natives)
```

Then link the `omp` CLI globally so `omp` runs your local checkout:

```sh
bun --cwd=packages/coding-agent link
sh scripts/link-omp.sh
```

Or run all three steps at once:

```sh
bun run setup
```

**Day-to-day development:**

```sh
bun run dev                # run the coding-agent CLI from source
bun run dev:timing         # same, with PI_TIMING=x for module load timings
bun run stats              # local observability dashboard
```

**Workspace packages** live under `packages/`; the Rust crate is `crates/pi-natives`.
The coding-agent is the primary package — when in doubt, assume work refers to
`packages/coding-agent/`.

## Code Standards

The full ruleset lives in `AGENTS.md`. Key highlights:

- **Bun over Node** — prefer `Bun.file()`, `Bun.write()`, `` $`cmd` ``, `bun:sqlite`
  over `node:*` equivalents. Use `node:fs/promises` only for directory ops.
- **No `any`, no `ReturnType<>`, no inline imports** — always top-level.
- **Barrel exports** — prefer `export * from "./module"` over named re-exports.
- **Class privacy** — use ES `#private` fields; no `private`/`protected`/`public`
  keywords on members (constructor parameter properties are the exception).
- **Prompts** — never inline; live in static `.md` files loaded via
  `import content from "./prompt.md" with { type: "text" }`.
- **Logging** — never `console.log`/`error`/`warn` in the coding-agent package;
  use `logger` from `@oh-my-pi/pi-utils`. Logs go to `~/.stp/logs/`.
- **TUI sanitization** — all displayed text must be sanitized (tabs → spaces,
  truncate, shorten paths). Apply to error messages too.
- **Swarm architecture** — use `AgentRuntime.spawn()`, `WorkflowFsm.transition()`,
  `ContextPipeline` sources, and `HookPipeline` hooks; never the deprecated
  `runSubprocess()`, `SwarmStateMachine`, or ad-hoc context assembly.
- **Workers** — re-enter the CLI entrypoint via `workerHostEntry()`; never spawn
  separate worker entry modules.
- **Never edit `packages/catalog/src/models.json`** directly — regenerate with
  `bun run gen:models`.

## Running Tests

```sh
bun run test               # full TypeScript suite (local mode)
bun run test:ts            # TypeScript tests only
bun run test:rs            # Rust tests
bun run test:scripts       # infrastructure/script tests
```

CI-style subsets:

```sh
bun run ci:test:ts         # all TypeScript tests
bun run ci:test:ts:workspace  # workspace-scoped tests
bun run ci:test:smoke      # smoke test (--version, --help, --smoke-test)
```

Target a single package or group:

```sh
bun run ci:test:coding-agent:runtime    # runtime tests
bun run ci:test:coding-agent:ui         # UI tests
bun run ci:test:coding-agent:native     # native integration tests
bun run ci:test:coding-agent:heavy      # heavy/slow tests
```

Use `bun check` (never `tsc`/`npx tsc`) for type-checking:

```sh
bun run check              # TypeScript + Rust checks
bun run check:ts           # TypeScript only (biome + workspace checks)
bun run lint               # TypeScript + Rust linting
bun run fmt                # TypeScript + Rust formatting
```

## Pre-Commit Checklist

Before opening a PR:

1. **Type-check** — `bun run check` must pass with no errors.
2. **Lint & format** — `bun run lint && bun run fmt` (or `bun run fix` to
   auto-fix biome issues).
3. **Run tests** — `bun run test:ts` at minimum; run the full suite
   (`bun run test`) for changes that cross package boundaries or touch Rust.
4. **Smoke test** — `bun run ci:test:smoke` verifies the binary boots, help
   output renders, and the worker smoke probe passes.
5. **Changelog** — add entries under `## [Unreleased]` in each affected
   package's `CHANGELOG.md`. Don't worry about section ordering or formatting —
   `bun run release` normalizes everything.
