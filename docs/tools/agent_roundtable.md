# agent_roundtable

> Conduct a structured multi-round discussion among agents.

## Source
- Entry: `packages/coding-agent/src/tools/agent-channel-tools.ts` — `AgentRoundtableTool`
- Key collaborators:
  - `packages/coding-agent/src/comm/comm-channel.ts` — `CommChannel` message routing
  - `packages/coding-agent/src/irc/bus.ts` — `IrcBus.collectResponses()` per-round answer collection

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `topic` | `string` | Yes | Topic for the roundtable discussion. |
| `rounds` | `number` | No | Number of discussion rounds (default 2, max 5). |

## Outputs
- Single-shot result.
- `content[0].text` summarizes the completed roundtable (rounds, agents, positions collected).
- `details` is the array of position statements gathered across all rounds.

## Flow
1. Initiates a structured roundtable among swarm agents.
2. Each round: every agent states their position on the topic, then all can react to the previous round's discussion.
3. Repeats for the configured number of rounds (bounded at 5).
4. Returns the collected positions.

## Modes / Variants
- Use for complex decisions, role negotiation, or divergent thinking.

## Side Effects
- Delivers discussion prompts to every participating agent's inbox.
