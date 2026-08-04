# agent_invoke

> Call a persistent agent by profile ID. Spawns a new session or steers an existing idle one.

## Source
- Entry: `packages/coding-agent/src/tools/agent-invoke.ts`
- Key collaborators:
  - `packages/coding-agent/src/session/agent/session-manager.ts` — session open/append
  - `packages/coding-agent/src/graph/agent-helpers.ts` — spawnAgent() for fresh sessions

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `profileId` | `string` | Yes | Profile ID of the persistent agent to call. |
| `task` | `string` | Yes | Task description for the agent. |

## Outputs
- Single-shot result.
- `content[0].text` is the agent's final response text.
- `details` includes the spawned/steered session id and profile id.

## Flow
1. Resolves the target persistent agent by `profileId`.
2. Spawns a fresh session via `spawnAgent()` or steers an existing idle session.
3. Runs the task and returns the agent's response.
