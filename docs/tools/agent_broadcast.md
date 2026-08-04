# agent_broadcast

> Broadcast a message to all agents in the swarm.

## Source
- Entry: `packages/coding-agent/src/tools/agent-channel-tools.ts` — `AgentBroadcastTool`
- Key collaborators:
  - `packages/coding-agent/src/comm/comm-channel.ts` — `CommChannel` message routing
  - `packages/coding-agent/src/irc/bus.ts` — `IrcBus.global()` default-channel fallback

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `body` | `string` | Yes | Message body to broadcast. |

## Outputs
- Single-shot result.
- `content[0].text` is a plain confirmation listing how many agents received the broadcast.

## Flow
1. Sends the message to every agent on the group `CommChannel`.
2. Returns a confirmation summary.

## Side Effects
- Delivers a message to every online swarm agent's inbox.
