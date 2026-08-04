# agent_peers

> List all online peer agents in the swarm.

## Source
- Entry: `packages/coding-agent/src/tools/agent-channel-tools.ts` — `AgentPeersTool`
- Key collaborators:
  - `packages/coding-agent/src/comm/comm-channel.ts` — `CommChannel` member roster

## Inputs
- None.

## Outputs
- Single-shot result.
- `content[0].text` lists each online peer id, one per line, with a count header.
- `details` is the array of `{ id }` peer records.

## Flow
1. Reads the current member roster from the group `CommChannel`.
2. Returns the peer list.
