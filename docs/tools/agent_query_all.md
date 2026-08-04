# agent_query_all

> Ask all agents a question and collect all answers.

## Source
- Entry: `packages/coding-agent/src/tools/agent-channel-tools.ts` — `AgentQueryAllTool`
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
- `content[0].text` is a consolidated list of every agent's answer, one per line with the sender id.
- `details` includes the per-agent answers array `{ from, body }` and any timed-out agents.

## Flow
1. Sends the question to all online agents.
2. Waits for each agent's answer (up to `timeout`).
3. Returns the full set of answers without selecting or ranking them.

## Side Effects
- Delivers a question to every online swarm agent's inbox.
