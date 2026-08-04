# agent_fork

> Fork yourself into multiple child agents to handle complex tasks in parallel.

## Source
- Entry: `packages/coding-agent/src/tools/agent-fork-tool.ts` — `AgentForkTool`
- Key collaborators:
  - `packages/coding-agent/src/config/settings-schema.ts` — `agent_fork` max nesting depth (default 1: children cannot fork further)

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `reason` | `string` | Yes | Why is forking needed? (e.g. 'task is too complex for one agent') |
| `count` | `number` | No | Number of child agents to fork (default 2, max 4). |
| `task` | `string` | No | Description of the main task to decompose into subtasks. |

## Outputs
- Single-shot result.
- `content[0].text` summarizes the forked child agents and how their subtasks were distributed.
- `details` includes the child agent ids and their assigned subtasks.

## Flow
1. Decomposes the given task into `count` subtasks.
2. Spawns `count` child agents, each assigned a subtask.
3. Enforces the configured nesting-depth limit (children cannot fork further by default).
4. Returns the child agent handles and subtask assignments.

## Side Effects
- Spawns child agent sessions.
