# agent_peers

> List all online peer agents in the swarm.

## Source
- Entry: `packages/coding-agent/src/tools/agent-channel-tools.ts` — `AgentPeersTool`
- Key collaborators:
  - `packages/coding-agent/src/irc/bus.ts` — `IrcBus.global()` peer registry

## Inputs
- None.

## Outputs
- Single-shot result.
- `content[0].text` lists each online peer (id and role, one per line).
- `details` includes the full peer list `{ id, role, status }[]`.

## Flow
1. Reads the current peer registry from `IrcBus.global()`.
2. Filters to online peers.
3. Returns the peer list.
