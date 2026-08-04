# agent_broadcast

> Broadcast a message to all agents in the swarm.

## Source
- Entry: `packages/coding-agent/src/tools/agent-channel-tools.ts` — `AgentBroadcastTool`
- Key collaborators:
  - `packages/coding-agent/src/irc/bus.ts` — `IrcBus.global()` group bus
  - `packages/coding-agent/src/comm/comm-channel.ts` — `CommChannel` message routing

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `body` | `string` | Yes | Message body to broadcast. |

## Outputs
- Single-shot result.
- `content[0].text` is a plain confirmation listing how many agents received the broadcast.
- `details` includes the recipient agent ids and delivery counts.

## Flow
1. Sends the message to every online agent via the group `CommChannel`.
2. Collects delivery acknowledgements.
3. Returns a confirmation summary.

## Side Effects
- Delivers a message to every online swarm agent's inbox.
