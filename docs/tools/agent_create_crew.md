# agent_create_crew

> Create a new crew (group chat) with specified agents as members.

## Source
- Entry: `packages/coding-agent/src/tools/agent-create-crew.ts`
- Key collaborators:
  - `packages/coding-agent/src/crew/crew-manager.ts` — `CrewManager.createCrew()` crew creation and JSONL transcript persistence
  - `packages/coding-agent/src/comm/comm-channel.ts` — `CommChannel` backing the crew's messaging
  - `packages/coding-agent/src/irc/bus.ts` — `IrcBus.global()` group bus

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `members` | `string[]` | Yes | Agent IDs to include as members. |
| `topic` | `string` | Yes | Topic or purpose of the crew. |

## Outputs
- Single-shot result.
- `content[0].text` confirms the crew id and member count, e.g. `Crew "<topic>" created with ID <crewId>. Members: ...`.
- `details` includes the `crewId`.

## Flow
1. Validates and deduplicates the member agent IDs.
2. Creates the crew via `CrewManager` (the calling agent and the human are automatically included).
3. Broadcasts a join notification through the crew channel and returns the crew handle for use with the other `agent_*` group tools.

## Side Effects
- Persists the crew transcript to JSONL.
