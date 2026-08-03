# Swarm Crew Architecture — Multi-Agent Group Chat Design

## 1. Overview

### 1.1 Motivation

The current swarm mode is hard-wired to a three-phase theatre graph (Script → Stage → Curtain) with the Main agent mediating all human interaction. This design decouples the communication layer (Crew) from the workflow layer (Graph), making the swarm mode a **persistent multi-agent group chat** where:

- Human participates directly as a peer, not through a Main agent relay
- Agents have persistent identities (Profile) with credit scores, expertise, and history across runs
- The three-phase graph is an optional template, not a mandatory workflow
- `@mention` routes messages to specific agents within a Crew
- Agents can be dynamically added/removed from a Crew

### 1.2 Core Principle

**Crew and Graph are orthogonal.**

```
Crew (通信层)          Graph (工作流层)
  谁和谁聊天              按什么流程做事
  持久化转录              可选模板
  动态成员              theatre / custom
```

### 1.3 State Machine

```
                      ┌──────────────┐
          /swarm start │  选择 Agent  │
          ───────────►│  (Profile)   │
                      └──────┬───────┘
                             │ 确认
                             ▼
                      ┌──────────────┐
             ┌───────│   Crew 模式   │───────┐
             │       │ (自由讨论)     │       │
             │       └──────┬───────┘       │
             │              │               │
             │     /graph theatre      /graph custom.yaml
             │              │               │
             │              ▼               ▼
             │       ┌──────────────┐ ┌──────────────┐
             │       │  Script      │ │  自定义 DAG  │
             │       │  (讨论+plan) │ │  ...         │
             │       └──────┬───────┘ └──────────────┘
             │              │
             │              ▼
             │       ┌──────────────┐
             │       │  Stage       │
             │       │  (执行任务)   │
             │       └──────┬───────┘
             │              │
             │              ▼
             │       ┌──────────────┐
             │       │  Curtain     │
             │       │  (汇报+反思) │
             │       └──────────────┘
             │              │
             └──────────────┘
                完成 / 回到自由讨论
```

---

## 2. Existing Infrastructure Inventory

### 2.1 Already Implemented (Reusable)

| Layer | Component | File | Status |
|-------|-----------|------|--------|
| Tools | `agent_create_crew` | `tools/agent-create-crew.ts` | Complete (hidden) |
| Tools | `agent_invoke` | `tools/agent-invoke.ts` | Complete |
| Selection | `selectAgents()` | `agent/agent-selector.ts` | Complete |
| Identity | `AgentProfile` + `ProfileRegistry` | `agent/agent-profile.ts` | Complete |
| Identity | `SWARM_ROLE_PROFILES` | `agent/role-profiles.ts` | Complete |
| Comms | `IrcBus` | `irc/bus.ts` | Complete |
| Comms | `CommChannel` (broadcast/roundtable/vote) | `comm/comm-channel.ts` | Complete |
| Session | `CrewManager` (create/add/remove/persist) | `crew/crew-manager.ts` | Complete |
| Session | `RoundtableSession` | `crew/roundtable-session.ts` | Complete |
| Workflow | `GraphRunner` (three-phase theatre) | `graph/graph-runner.ts` | Complete |
| Workflow | `StageBehavior` / `ScriptBehavior` / `CurtainBehavior` | `graph/behaviors/` | Complete |
| TUI | `CrewTranscriptView` (color-coded messages) | `modes/components/swarm/crew-transcript-view.ts` | **Orphaned** |
| TUI | `SwarmSidebar` (Ctrl+B, tree: sessions/swarms/crews) | `modes/components/swarm/swarm-sidebar.ts` | Complete |
| TUI | `SwarmDashboardOverlay` (fullscreen /swarm) | `modes/components/swarm/swarm-dashboard-overlay.ts` | Complete |
| TUI | `PlanReviewOverlay` | `modes/components/plan-review-overlay.ts` | Complete |
| TUI | `AskDialogComponent` | `modes/components/ask-dialog.ts` | Complete |
| TUI | Agent Hub (list+focus agents) | `modes/components/agent-hub.ts` | Complete |
| TUI | `swarmPanel()` (framedBlock wrapper) | `modes/components/swarm/swarm-panel-block.ts` | Complete |
| TUI | `SessionFocusController` | `modes/controllers/session-focus-controller.ts` | Complete |
| Persistence | `SwarmSessionManager` (JSONL) | `swarm/session/swarm-session-manager.ts` | Complete |
| Persistence | Agent session files per agent | `session/session-tree-paths.ts` | Complete |

### 2.2 Missing (Must Implement)

| # | Gap | Priority |
|---|-----|----------|
| 1 | `CrewTranscriptView` not wired into any TUI path | P0 |
| 2 | Human→swarm message routing in `input-controller.ts` | P0 |
| 3 | `@mention` parser (`parseMentions(text)`) | P0 |
| 4 | Agent response capture (`agent_end` → `persistMessage`) | P0 |
| 5 | Profile selection UI (when creating Crew) | P1 |
| 6 | Stable `profileId` in `StageBehavior` (currently `agent-N`) | P1 |
| 7 | `AgentConversationView` (per-agent full history) | P1 |
| 8 | Graph as optional template (`/graph theatre` command) | P2 |
| 9 | Sidebar member add/remove operations | P2 |
| 10 | Tab switching system (Crew View ↔ Agent View) | P1 |
| 11 | `SwarmModeController` (orchestrates the above) | P0 |

---

## 3. Data Model

### 3.1 CrewState (extending existing `crew/crew-manager.ts`)

```typescript
// crew/crew-manager.ts — extended
interface CrewState {
  id: string;                    // Snowflake ID
  name: string;
  members: CrewMember[];         // [{ agentId, role: "member"|"observer" }]
  activeGraph?: {                // Optional workflow binding
    graphPath: string;           // "builtin/theatre.graph.yaml" or custom
    phase: Chapter;              // idle | script | stage | curtain
  };
  createdAt: number;
}

interface CrewMember {
  agentId: string;               // "human" | profileId | agent-session-id
  role: "member" | "observer";   // member = active participant, observer = read-only
}
```

### 3.2 CrewTranscriptEntry (existing in `crew-transcript-view.ts`)

```typescript
interface CrewTranscriptEntry {
  agentId: string;               // Sender
  body: string;                  // Message body
  timestamp: number;             // UNIX epoch ms
  round: number;                 // For graph-phase grouping (0 = free discussion)
  /** Entry collapsed state for TUI rendering. */
  collapsed?: boolean;           // Whether to collapse this entry (default true for tool-output entries)
  /** For tool calls within an agent turn. */
  kind?: "message" | "tool";
  toolName?: string;
  /** Group ID: all entries from the same agent turn share the same turnId. */
  turnId?: string;
}
```

### 3.3 ParsedInput

```typescript
// modes/mention-parser.ts
interface ParsedInput {
  /** Messages directed at specific agents. */
  mentions: Array<{ agentId: string; text: string }>;
  /** Message content not directed at any specific agent (broadcast). */
  broadcast: string;
}

function parseMentions(text: string, crewMemberIds: Set<string>): ParsedInput;
```

---

## 4. Message Routing Architecture

### 4.1 Route Decision in `input-controller.ts`

```
User presses Enter in TUI
  │
  ▼
input-controller.ts: submit handler (line ~790)
  │
  ├─ swarmModeController.isCrewActive?
  │   YES → skip Main agent LLM entirely
  │   │
  │   ├─ parseMentions(text, crewMemberIds) → ParsedInput
  │   │
  │   ├─ For each mention:
  │   │     ircBus.send(agentId, text, { expectReply: true })
  │   │     crewManager.persistMessage(crewId, "human", `@${agentId} ${text}`)
  │   │
  │   ├─ If broadcast non-empty:
  │   │     commChannel.broadcast(broadcast)
  │   │     crewManager.persistMessage(crewId, "human", broadcast)
  │   │
  │   └─ TUI: CrewTranscriptView re-renders
  │
  └─ NO → normal Main agent session.prompt(text)
```

### 4.2 Agent Response Capture

```typescript
// In spawnAgent (graph/agent-helpers.ts) or in SwarmModeController

agentSession.subscribe(event => {
  if (event.type === "agent_end") {
    const lastMsg = extractFinalResponse(event.messages);
    
    // Persist to crew transcript
    crewManager.persistMessage(crewId, agentId, lastMsg);
    
    // Also persist tool calls as collapsible entries
    for (const toolCall of extractToolCalls(event.messages)) {
      crewManager.persistMessage(crewId, agentId, 
        JSON.stringify({ tool: toolCall.name, args: summarizeArgs(toolCall.args) }),
        { kind: "tool", toolName: toolCall.name, collapsed: true }
      );
    }
    
    // Update Profile (credit, success rate, etc.)
    profileRegistry.recordTaskCompleted(profileId, !isError, { domain, role, durationMs });
  }
});
```

### 4.3 @mention Semantics

- `@agentId` matches only members of the active Crew
- Messages are **always visible to all Crew members** (群聊语义)
- `@` is a "directed question" hint — the mentioned agent is expected to respond, but others can also see and interject
- `@` triggers auto-complete dropdown in TUI input (Tab to select)
- Auto-complete shows: agent name + credit score + archetype icon

---

## 5. Agent Lifecycle & Profile Integration

### 5.1 Stable Profile ID Mapping

Current problem: `StageBehavior` generates IDs like `agent-1`, `agent-2`, making profiles non-reusable.

Fix:

```typescript
// graph/behaviors/stage-behavior.ts

// Map task roles to stable archetype-based profileIds
const ROLE_TO_PROFILE: Record<string, string> = {
  planner:      "swarm-planner",
  implementer:  "swarm-implementer", 
  reviewer:     "swarm-reviewer",
  architect:    "swarm-architect",
  debugger:     "swarm-debugger",
  tester:       "swarm-tester",
  reflector:    "swarm-reflector",
};

// Use these when spawning agents
const specs = roles.map((role, i) => ({
  id: ROLE_TO_PROFILE[role] ?? `worker-${role}`,    // stable
  profileId: ROLE_TO_PROFILE[role] ?? `worker-${role}`, // persistent
  role,
  roleSource: "profile" as const,
  // ...
}));
```

### 5.2 Profile-Aware Agent Selection

When creating a Crew, present available profiles sorted by fitness:

```typescript
// Using existing agent-selector.ts
const scored = selectAgents({
  profiles: profileRegistry.list(),
  requiredArchetypes: ["architect", "implementer"],  // min 2 distinct
  taskDomains: extractDomains(userInput),
  minScore: 30,  // credit score threshold
});

// TUI shows scored agents with:
// - name / archetype / credit score / success rate / domain match %
```

### 5.3 Agent Spawn with Profile Context

When a Crew agent is spawned, inject Profile context into system prompt:

```typescript
// In spawnAgent — already partially implemented via ProfileSource
// context/sources/profile-source.ts (priority 1)

// The profile hook (hooks/builtins/profile-hook.ts) already:
// 1. agent:beforeSpawn → getOrCreate profile
// 2. agent:afterComplete → recordTaskCompleted
// 3. workflow:afterPhase → recordCollaboration

// Gap: profile context injection relies on spec.id matching profileId.
// Fix: ensure spec.profileId is set and matches the profile key.
```

---

## 6. Crew Management

### 6.1 Create Crew Flow

```
User: /swarm start
  → TUI: Profile selection dialog
    - Shows scored agent list (credit score, archetype, domains)
    - Minimum 2 agents required (enforced by agent-selector.ts)
    - Multi-select with Space, confirm with Enter
  → CrewManager.createCrew(name, selectedProfileIds)
    - Snowflake ID
    - CommChannel with members + human(observer)
    - Persists to .stp/sessions/crews/{crewId}.json
  → TUI switches to Crew View
```

### 6.2 Dynamic Membership

```
/add @agent-name    → crewManager.addMember(crewId, agentId)
/remove @agent-name → crewManager.removeMember(crewId, agentId)
```

Also via Sidebar: select Crew → Enter → "Manage Members" dialog.

### 6.3 Crew Persistence

```
.stp/sessions/crews/
  {crewId}.json     ← CrewState (members, graph binding)
  {crewId}.jsonl    ← Transcript (one JSON line per message)
```

`CrewManager.restore()` already loads all crews on startup. SwarmSidebar already renders them in the tree.

---

## 7. Graph Integration (Optional Workflow)

### 7.1 Attaching a Graph to a Crew

```
/graph theatre              → attach builtin/theatre.graph.yaml
/graph .stp/graphs/ci.yaml  → attach custom graph
/graph off                  → detach graph, return to free discussion
```

### 7.2 Graph Lifecycle in Crew Context

When a graph is active:

1. **Phase transitions** broadcast system messages to the Crew channel
2. **Script phase**: the Crew discusses requirements; one agent (matching `planner` role) writes plan.md
3. **Stage phase**: `StageBehavior` parses plan.md → spawns worker agents (using stable profileIds)
4. **Curtain phase**: reporter agent summarizes; all agents' Profiles are updated

Human can intervene at any time:
```
/phase pause   → pause current phase
/phase resume  → resume
/phase abort   → abort graph, return to free discussion
```

### 7.3 GraphRunner Changes

```typescript
// graph/graph-runner.ts — new method
async attachCrew(crewId: string, crewManager: CrewManager): Promise<void> {
  const crew = crewManager.getCrew(crewId);
  // Wire graph phase transitions → crew channel broadcasts
  this.onPhaseChange = (phase) => {
    crew.channel.broadcast(`[System] Phase: ${phase}`);
    crewManager.persistMessage(crewId, "system", `Phase: ${phase}`);
  };
}
```

---

## 8. TUI Design

### 8.1 Layout

```
┌─ SwarmSidebar (Ctrl+B, 35%) ───┬─ Main View ───────────────────────────────┐
│                                  │                                          │
│ 📁 Session                       │  ┌─ Tabs ──────────────────────────────┐ │
│  ○ Main (idle)                   │  │ [Crew: api-redesign] [@architect]   │ │
│                                  │  └─────────────────────────────────────┘ │
│ 📁 Agents                        │                                          │
│  ○ swarm-architect (busy) ●      │  ┌─ Crew View ─────────────────────────┐ │
│  ○ swarm-impl (running)          │  │                                       │ │
│  ○ swarm-reviewer (idle)         │  │ ═══ Phase: stage · 2/4 tasks ═══════ │ │
│                                  │  │                                       │ │
│ 📁 Crews                         │  │ human · 14:32:05                     │ │
│  ▼ api-redesign (3)              │  │ @architect JWT认证方案呢？            │ │
│   ○ human                        │  │                                       │ │
│   ○ swarm-architect (busy) ●     │  │ ┌─ architect · 14:32:12 ─┐ 🟢 92分  │ │
│   ○ swarm-impl (running)         │  │ │ JWT + refresh token   │ [展开]   │ │
│                                  │  │ │ [2 tool calls]        │          │ │
│  [+ New Crew]  (Ctrl+N)          │  │ └───────────────────────┘          │ │
│                                  │  │                                       │ │
│ ─────────────────────            │  │ ┌─ implementer · 14:32:30 ┐ 🟡 67分 │ │
│ Alt+1 Crew View                  │  │ │ /auth 路由已实现        │ [展开]   │ │
│ Alt+2 Agent View                 │  │ │ [1 tool call]          │          │ │
│ Ctrl+G Apply Graph               │  │ └───────────────────────┘          │ │
│                                  │  └───────────────────────────────────────┘ │
│                                  │                                          │
│                                  │  ┌─ Input ──────────────────────────────┐ │
│                                  │  │ > @architect refresh token TTL设多少  │ │
│                                  │  │   ┌──────────────────────────┐       │ │
│                                  │  │   │ architect (92)  ▸        │       │ │
│                                  │  │   │ implementer (67)         │       │ │
│                                  │  │   └──────────────────────────┘       │ │
│                                  │  └───────────────────────────────────────┘ │
└──────────────────────────────────┴────────────────────────────────────────────┘
```

### 8.2 Collapsible Agent Responses

To prevent information overload from multiple agents, each agent's turn is rendered as a **collapsible block**:

**Collapsed state** (default for non-human messages):
```
┌─ architect · 14:32:12 ──────────────────────────┐ 🟢 92分
│ JWT + refresh token 模式，access token 15min...   │
│ [2 tool calls: read(auth-flow.md), write(plan.md)]│
│                                      [Enter: 展开]│
└──────────────────────────────────────────────────┘
```

**Expanded state** (after Enter):
```
┌─ architect · 14:32:12 ──────────────────────────┐ 🟢 92分
│                                                   │
│ JWT + refresh token 模式。建议：                    │
│ - access token: 15min TTL                         │
│ - refresh token: 7d TTL, 存储在 httpOnly cookie    │
│ - 加入 token rotation 和 revocation list           │
│                                                   │
│ ┌─ tool: read ──────────────────────────────────┐ │
│ │ File: auth-flow.md                             │ │
│ │ Lines: 42                                      │ │
│ └───────────────────────────────────────────────┘ │
│ ┌─ tool: write ─────────────────────────────────┐ │
│ │ File: plan.md                                  │ │
│ │ Wrote: 1.2KB                                   │ │
│ └───────────────────────────────────────────────┘ │
│                                      [Enter: 折叠]│
└──────────────────────────────────────────────────┘
```

### 8.3 Collapse/Expand Protocol (Reusing Existing Patterns)

The codebase has a well-established convention for collapsible content:

- **Interface**: duck-typed `setExpanded(expanded: boolean)` on any `Component`
- **Global toggle**: `app.tools.expand` keybinding (default `Ctrl+O`) iterates all children calling `setExpanded()`
- **Hint rendering**: `formatExpandHint(theme, expanded, hasMore)` from `tools/render-utils.ts` renders dim `[Ctrl+O: Expand]`
- **Preview limits**: `PREVIEW_LIMITS` dict (collapsed ~3-4 lines, expanded ~12 lines)
- **Component tracking**: `ChatTranscriptBuilder.#expandables` array tracks all expandable components

For Crew View entries, we follow this protocol with per-entry `Enter` toggle + global `Ctrl+O`:

```typescript
class CrewEntryBlock implements Component {
  #collapsed = true;
  #agentId: string;
  #entries: CrewTranscriptEntry[];

  setExpanded(expanded: boolean): void {
    this.#collapsed = !expanded;  // collapsed = NOT expanded
  }

  render(width: number): readonly string[] {
    if (this.#collapsed) return this.#renderCollapsed(width);
    return this.#renderExpanded(width);
  }

  handleInput(data: string): void {
    if (data === "\r") this.#collapsed = !this.#collapsed;  // Enter toggle
  }
}
```

Both `Enter` (per-entry) and `Ctrl+O` (global) work to expand/collapse.

### 8.4 Rendering Implementation

```typescript
// Reusing existing patterns:

// 1. Framed block (same as ToolExecutionComponent)
//    - swarmPanel() for the outer box with header
//    - formatStatusIcon() for agent status
//    - formatExpandHint() for expand/collapse hint

// 2. Collapse state tracking
class CrewEntryBlock {
  #collapsed = true;
  #agentId: string;
  #entries: CrewTranscriptEntry[];  // Grouped by turnId
  
  render(width: number): string[] {
    if (this.#collapsed) {
      return this.#renderCollapsed(width);
    }
    return this.#renderExpanded(width);
  }
  
  handleInput(key: string): void {
    if (key === "\r") {  // Enter
      this.#collapsed = !this.#collapsed;
    }
  }
}
```

### 8.5 Existing Components to Reuse

| Component | Reuse |
|-----------|-------|
| `swarmPanel(title, contentFn, theme)` | Frame all panels with consistent borders |
| `formatExpandHint(theme, expanded, hasMore)` | "Enter: 展开" hint |
| `formatStatusIcon(status, theme)` | Agent status glyphs |
| `formatBadge(label, color, theme)` | Credit score badges |
| `agentColor(agentId, theme)` | Stable color per agent (DJB2 hash → 8-color palette) |
| `formatTime(ts, theme)` | HH:MM:SS timestamps |
| `truncateToWidth(text, width)` | Line truncation |
| `renderStatusLine(...)` | Status bar at bottom |

### 8.6 Keyboard Shortcuts

| Key | Context | Action |
|-----|---------|--------|
| `Ctrl+B` | Global | Toggle SwarmSidebar |
| `Ctrl+N` | Sidebar | New Crew dialog |
| `Ctrl+G` | Crew View | Apply Graph template |
| `Alt+1` | Global | Switch to Crew View tab |
| `Alt+2..9` | Global | Switch to Agent View tab |
| `Ctrl+Tab` | Global | Next tab |
| `Ctrl+Shift+Tab` | Global | Previous tab |
| `Ctrl+W` | Global | Close current tab |
| `Enter` | Crew View (on entry) | Expand/collapse agent response |
| `Enter` | Sidebar (on crew) | Focus that Crew |
| `Enter` | Sidebar (on agent) | Open Agent View tab |
| `@` | Input | Trigger agent autocomplete |
| `Tab` | Input (autocomplete open) | Select next suggestion |
| `f` | Crew View | Toggle agent filter popup |
| `t` | Crew View | Toggle messages-only / messages+tools |
| `r` | Crew View | Cycle round filter (when graph active) |
| `j/k` | Crew View | Scroll transcript |
| `Esc` | Filter popup / dialog | Close |

### 8.7 Agent Conversation View

When user opens an agent's individual view (Enter on agent in Sidebar or via tab):

```
┌─ [@swarm-architect] ───────────────────────────────────────┐
│                                                              │
│  Profile: swarm-architect · archetype: architect             │
│  Credit: 92/100 · Tasks: 47 (94% success)                    │
│  Domains: typescript, system-design, api                     │
│  Last active: 2 hours ago                                    │
│                                                              │
│  ── Conversation ────────────────────────────────────────── │
│                                                              │
│  [system] You are an architect specializing in...            │
│                                                              │
│  human · 14:30:01                                            │
│  设计一个 JWT 认证方案                                        │
│                                                              │
│  architect · 14:30:15                                        │
│  我建议使用 access + refresh token 模式...                    │
│  ┌─ tool: read ───────────────────────────────────────────┐ │
│  │ ...                                                     │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌─ tool: write ──────────────────────────────────────────┐ │
│  │ ...                                                     │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  human · 14:32:05                                            │
│  refresh token 的 TTL 设多少？                                │
│                                                              │
│  architect · 14:32:12                                        │
│  标准做法 access 15min, refresh 7d...                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Data source: `SwarmSessionManager` reading from `.stp/sessions/swarm-{name}/agents/{agentId}.jsonl`.

---

## 9. SwarmModeController (New Orchestrator)

### 9.1 Responsibilities

This new class bridges TUI and Crew infrastructure. It lives alongside `InteractiveMode`:

```typescript
// modes/controllers/swarm-mode-controller.ts

class SwarmModeController {
  // Active state
  #activeCrewId: string | null;
  #crewManager: CrewManager;
  #ircBus: IrcBus;
  #profileRegistry: ProfileRegistry;
  #graphRunner: GraphRunner | null;
  
  // TUI components
  #crewView: CrewTranscriptView;
  #agentViews: Map<string, AgentConversationView>;
  #sidebar: SwarmSidebar;
  
  // Lifecycle
  isCrewActive(): boolean;
  createCrew(name: string, profileIds: string[]): Promise<string>;
  disposeCrew(crewId: string): Promise<void>;
  
  // Message routing
  handleUserInput(text: string, images?: ImageContent[]): Promise<void>;
  
  // Graph
  attachGraph(graphPath: string): Promise<void>;
  detachGraph(): Promise<void>;
  
  // Agent views
  openAgentView(agentId: string): void;
  closeAgentView(agentId: string): void;
}
```

### 9.2 Integration with InteractiveMode

```typescript
// interactive-mode.ts — key integration points

class InteractiveMode {
  #swarmModeController: SwarmModeController;
  
  // In input submission path:
  async #submitInput(text: string, images?: ImageContent[]): Promise<void> {
    // Check if Crew is active BEFORE routing to Main agent
    if (this.#swarmModeController.isCrewActive()) {
      await this.#swarmModeController.handleUserInput(text, images);
      return;  // Don't reach Main agent
    }
    
    // Normal path: Main agent session.prompt()
    await this.session.prompt(text, { images });
  }
  
  // Wire sidebar selection → Crew/Agent views
  #setupSwarmSidebar(): void {
    this.#swarmSidebar = new SwarmSidebar({
      crewManager: this.#swarmModeController.crewManager,
      onSelectAgent: (agentId) => this.#swarmModeController.openAgentView(agentId),
      onSelectCrew: (crewId) => this.#swarmModeController.focusCrew(crewId),
    });
  }
}
```

---

## 10. CLI Entry Points

### 10.1 New Commands

```bash
# Start a new swarm session with crew selection
stp swarm start
stp swarm start --graph theatre
stp swarm start --graph .stp/graphs/ci-flow.yaml

# Resume an existing crew
stp swarm resume <crew-name>

# List active crews
stp swarm list
```

### 10.2 Slash Commands (in existing TUI session)

```
/swarm start          → Create new crew (profile selection dialog)
/swarm start --graph theatre → Create crew with theatre graph
/crew <name>          → Switch to an existing crew
/graph theatre        → Attach graph to current crew
/graph off            → Detach graph
/add @agent-name      → Add member to current crew
/remove @agent-name   → Remove member
/phase pause|resume|abort → Control active graph phase
```

### 10.3 Backward Compatibility

The existing `/swarm` slash command (and keyword detection in `agent-session.ts`) remains functional. When triggered:

1. If no Crew is active: falls through to current behavior (Main agent as planner)
2. Future: could route to Crew creation flow instead

---

## 11. Implementation Plan

### Phase 1: Core Message Flow (P0 — ~3 days)

| # | Task | Files | Dependencies |
|---|------|-------|--------------|
| 1.1 | `parseMentions()` parser | **new** `modes/mention-parser.ts` | None |
| 1.2 | `SwarmModeController` skeleton | **new** `modes/controllers/swarm-mode-controller.ts` | None |
| 1.3 | Message routing in `input-controller.ts` | `modes/controllers/input-controller.ts:790-832` | 1.1, 1.2 |
| 1.4 | Wire `CrewTranscriptView` into TUI | `modes/components/swarm/crew-transcript-view.ts`, `interactive-mode.ts` | 1.2 |
| 1.5 | Agent response capture (`agent_end` → `persistMessage`) | `graph/agent-helpers.ts`, `crew/crew-manager.ts` | 1.2 |
| 1.6 | Crew creation flow (profile selection dialog → `CrewManager.createCrew`) | **new** dialog, `crew/crew-manager.ts` | 1.2 |

**Phase 1 acceptance**: User can create a Crew, type `@agent message`, see color-coded responses in Crew view.

### Phase 2: Collapsible Responses & Profile Integration (P1 — ~2 days)

| # | Task | Files |
|---|------|-------|
| 2.1 | `CrewEntryBlock` component (collapsible agent responses) | **new** `modes/components/swarm/crew-entry-block.ts` |
| 2.2 | Integrate collapse into `CrewTranscriptView` | `crew-transcript-view.ts` |
| 2.3 | Stable `profileId` in `StageBehavior` | `graph/behaviors/stage-behavior.ts` |
| 2.4 | Profile-aware `spawnAgent` (inject profile context) | `graph/agent-helpers.ts` |
| 2.5 | `AgentConversationView` (per-agent full history) | **new** `modes/components/swarm/agent-conversation-view.ts` |

### Phase 3: Graph Decoupling & Full Interaction (P2 — ~2 days)

| # | Task | Files |
|---|------|-------|
| 3.1 | Graph as optional template (`/graph theatre`) | `swarm-mode-controller.ts`, `graph-runner.ts` |
| 3.2 | Phase transition messages → Crew channel | `graph-runner.ts` |
| 3.3 | Sidebar member operations (add/remove from UI) | `swarm-sidebar.ts` |
| 3.4 | Tab switching system (Crew View ↔ Agent Views) | `interactive-mode.ts` |
| 3.5 | End-to-end integration test | **new** test file |

---

## 12. TUI Component Dependencies (Rendering Stack)

```
CrewView (swarmPanel-framed)
  ├─ phaseBar (from phase-view.ts, existing)
  ├─ CrewEntryBlock[] (new, collapsible)
  │    ├─ agentColor() (existing, stable per-agent color)
  │    ├─ formatTime() (existing)
  │    ├─ formatExpandHint() (existing)
  │    └─ tool call summary (new, reusing tool-execution.ts patterns)
  ├─ agent filter popup (existing in CrewTranscriptView)
  └─ shortcut hint bar (existing)

AgentConversationView (swarmPanel-framed, new)
  ├─ profile header (credit score, archetype, domains)
  └─ message stream (reuse transcript rendering patterns)
       ├─ system messages (dim)
       ├─ human messages (accent)
       ├─ agent messages (colored by agentColor)
       └─ tool execution blocks (reuse ToolExecutionComponent)

SwarmSidebar (existing, Ctrl+B)
  ├─ session node
  ├─ agent nodes
  ├─ crew nodes (existing, currently read-only)
  │    └─ crew member nodes
  └─ [+ New Crew] action (new)

ProfileSelectionDialog (new, reusing AskDialogComponent patterns)
  ├─ scored agent list
  ├─ multi-select (Space)
  └─ confirm/cancel (Enter/Esc)
```

---

## 13. Files to Create

| File | Purpose |
|------|---------|
| `docs/swarm-crew-architecture.md` | This document |
| `modes/mention-parser.ts` | @mention parser |
| `modes/controllers/swarm-mode-controller.ts` | Crew/Graph/TUI orchestrator |
| `modes/components/swarm/crew-entry-block.ts` | Collapsible agent response block |
| `modes/components/swarm/agent-conversation-view.ts` | Per-agent full history view |
| `modes/components/swarm/profile-select-dialog.ts` | Profile selection for crew creation |

## 14. Files to Modify

| File | Change |
|------|--------|
| `modes/controllers/input-controller.ts` | Route swarm messages to `SwarmModeController` |
| `modes/interactive-mode.ts` | Wire `SwarmModeController`, tabs, `CrewTranscriptView` |
| `modes/components/swarm/crew-transcript-view.ts` | Integrate `CrewEntryBlock`, remove orphan status |
| `modes/components/swarm/swarm-sidebar.ts` | Add member operations, new-crew action |
| `graph/behaviors/stage-behavior.ts` | Stable `profileId`, profile-aware agent spawning |
| `graph/agent-helpers.ts` | Profile context injection in `spawnAgent` |
| `crew/crew-manager.ts` | Minor: `turnId` grouping, `collapsed` flag on entries |
| `graph/graph-runner.ts` | `attachCrew()` method, phase→crew broadcast |
| `config/keybindings.ts` | Add `app.swarm.dashboard`, `app.swarm.newCrew` bindings |
