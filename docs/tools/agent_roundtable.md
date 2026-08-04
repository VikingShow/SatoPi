# agent_roundtable

> Conduct a structured multi-round discussion among agents.

## Source
- Entry: `packages/coding-agent/src/tools/agent-channel-tools.ts` — `AgentRoundtableTool`
- Key collaborators:
  - `packages/coding-agent/src/irc/bus.ts` — `IrcBus.global()` group bus
  - `packages/coding-agent/src/comm/comm-channel.ts` — `CommChannel` message routing

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `topic` | `string` | Yes | Topic for the roundtable discussion. |
| `rounds` | `number` | No | Number of discussion rounds (default 2, max 5). |

## Outputs
- Single-shot result.
- `content[0].text` is the final consensus positions from all participants.
- `details` includes the full per-round transcript `{ round, from, body }[]`.

## Flow
1. Initiates a structured roundtable among swarm agents.
2. Each round: every agent states their position, then all can react.
3. Repeats for the configured number of rounds.
4. Returns the final consensus positions.

## Modes / Variants
- Use for complex decisions, role negotiation, or divergent thinking.

## Side Effects
- Delivers discussion prompts to every participating agent's inbox.
