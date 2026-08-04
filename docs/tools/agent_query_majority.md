# agent_query_majority

> Ask all agents a question and return the majority answer.

## Source
- Entry: `packages/coding-agent/src/tools/agent-channel-tools.ts` — `AgentQueryMajorityTool`
- Key collaborators:
  - `packages/coding-agent/src/irc/bus.ts` — `IrcBus.global()` group bus
  - `packages/coding-agent/src/comm/comm-channel.ts` — `CommChannel` question/answer routing

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `question` | `string` | Yes | Question to ask all agents. |
| `timeout` | `number` | No | Timeout in milliseconds (default 30s). |

## Outputs
- Single-shot result.
- `content[0].text` is the majority answer (the most common answer among agents).
- `details` includes the per-agent answers, the vote counts, and the selected majority answer.

## Flow
1. Sends the question to all online agents.
2. Collects answers within the timeout.
3. Groups identical answers, selects the one with the highest count, and returns it.
4. Ties are resolved deterministically (first-arriving or lexicographic, per implementation).

## Side Effects
- Delivers a question to every online swarm agent's inbox.
