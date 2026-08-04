# agent_invoke

> Call a persistent agent by profile ID. Spawns a new session or steers an existing idle one.

## Source
- Entry: `packages/coding-agent/src/tools/agent-invoke.ts` — `agentInvokeTool`
- Key collaborators:
  - `packages/coding-agent/src/registry/agent-registry.ts` — `AgentRegistry` lookup of idle persistent sessions
  - `packages/coding-agent/src/sdk.ts` — `createAgentSession()` for fresh sessions
  - `packages/coding-agent/src/registry/agent-lifecycle.ts` — `AgentLifecycleManager` ownership/teardown of the persistent session
  - `packages/coding-agent/src/agent/agent-profile.ts` — `ProfileRegistry` task-completion tracking

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `profileId` | `string` | Yes | Profile ID of the persistent agent to invoke. |
| `task` | `string` | Yes | Task description for the agent. |

## Outputs
- Single-shot result; progress streams inline via `session.subscribe()`.
- `content[0].text` is the agent's final response text.
- `details` includes `{ progress, results, profileId, displayName, kind: "main" }`.

## Flow
1. Looks up an existing idle persistent session for `profileId`; otherwise spawns a fresh one.
2. Runs the task in the persistent session and streams progress.
3. Records task completion against the profile and returns the final result.
