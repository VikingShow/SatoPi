# agent_create_crew

> Create a new agent crew (group chat).

## Source
- Entry: `packages/coding-agent/src/tools/agent-create-crew.ts`
- Key collaborators:
  - `packages/coding-agent/src/comm/comm-channel.ts` — `CommChannel` for the crew
  - `packages/coding-agent/src/irc/bus.ts` — `IrcBus.global()` group bus

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Crew name. |
| `members` | `string[]` | Yes | Agent profile IDs to include in the crew. |
| `loadMode` | `"essential"` \| other | No | How eagerly members are loaded. Default: `essential`. |

## Outputs
- Single-shot result.
- `content[0].text` summarizes the created crew (id, member count).
- `details` includes the crew id and member list.

## Flow
1. Validates the member profile IDs.
2. Creates a `CommChannel` backed by `IrcBus.global()` and joins all members.
3. Returns the crew handle for use with the other `agent_*` group tools.
