# agent_query_majority

> Ask all agents a question and return the majority answer.

## Source
- Entry: `packages/coding-agent/src/tools/agent-channel-tools.ts` — `AgentQueryMajorityTool`
- Key collaborators:
  - `packages/coding-agent/src/comm/comm-channel.ts` — `CommChannel` member roster
  - `packages/coding-agent/src/irc/bus.ts` — `IrcBus.collectResponses()` question/answer routing

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `question` | `string` | Yes | Question to ask all agents. |
| `timeout` | `number` | No | Timeout in milliseconds (default 30s). |

## Outputs
- Single-shot result.
- `content[0].text` is the majority answer with its vote count, e.g. `Majority: "A" (3/5 votes)`.
- `details` is the selected majority answer string.

## Flow
1. Sends the question to all online agents.
2. Collects answers within the timeout.
3. Tallies identical trimmed answers and selects the one with the highest count.
4. Ties are broken by count order — the first answer reaching the top count wins.

## Side Effects
- Delivers a question to every online swarm agent's inbox.
