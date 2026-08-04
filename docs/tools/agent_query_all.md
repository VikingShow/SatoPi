# agent_query_all

> Ask all agents a question and collect all answers.

## Source
- Entry: `packages/coding-agent/src/tools/agent-channel-tools.ts` — `AgentQueryAllTool`
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
- `content[0].text` reports how many agents answered, e.g. `Collected 3/4 answers.`
- `details` is a map of `agentId → answer` for every responding agent.

## Flow
1. Sends the question to all online agents.
2. Waits for each agent's answer (up to `timeout`).
3. Returns the full set of answers without selecting or ranking them.

## Side Effects
- Delivers a question to every online swarm agent's inbox.
