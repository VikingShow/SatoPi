/**
 * AgentTopology — Real-time swarm agent relationship graph.
 *
 * Uses React Flow (@xyflow/react) with dagre auto-layout to visualize
 * swarm agents (workers, cloners, reviewer, socrates) and their
 * communication edges in real-time.
 */
import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { useSwarmStore } from "../../stores/swarm-store";

// ── Agent colors ────────────────────────────────────────────────
const AGENT_COLORS: Record<string, string> = {
  developer: "#10B981",
  reviewer: "#F59E0B",
  planner: "#3B82F6",
};

const STATUS_COLORS: Record<string, string> = {
  idle: "#525252",
  thinking: "#F59E0B",
  working: "#3B82F6",
  done: "#10B981",
  crashed: "#EF4444",
  waiting: "#A3A3A3",
};

// ── Layout engine (dagre) — dynamic node sizing ──────────────────
const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));
dagreGraph.setGraph({ rankdir: "TB", nodesep: 80, ranksep: 100 });

/** Rough heuristic: ~7.5px per char + padding for icon/badge. */
function estimateNodeSize(label: string): { width: number; height: number } {
  const minW = 140, maxW = 280, charW = 7.5, pad = 44;
  return { width: Math.max(minW, Math.min(maxW, Math.round(label.length * charW + pad))), height: 80 };
}

function layoutNodes(nodes: Node[], edges: Edge[]): Node[] {
  dagreGraph.nodes().forEach((n) => dagreGraph.removeNode(n));

  for (const node of nodes) {
    dagreGraph.setNode(node.id, estimateNodeSize((node.data as { label: string }).label));
  }
  for (const edge of edges) {
    dagreGraph.setEdge(edge.source, edge.target);
  }

  dagre.layout(dagreGraph);

  return nodes.map((node) => {
    const pos = dagreGraph.node(node.id);
    if (!pos) return node;
    const s = estimateNodeSize((node.data as { label: string }).label);
    return {
      ...node,
      position: { x: pos.x - s.width / 2, y: pos.y - s.height / 2 },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    };
  });
}

// ── Custom Agent Node ────────────────────────────────────────────
function AgentNode({ data }: { data: { label: string; agentType: string; status: string; model?: string; iteration: number; score?: number } }) {
  const color = AGENT_COLORS[data.agentType] || "#7C3AED";
  const statusColor = STATUS_COLORS[data.status] || "#525252";

  return (
    <div
      className="px-3 py-2 rounded-xl border shadow-lg min-w-[140px]"
      style={{
        background: "linear-gradient(135deg, #141414 0%, #1a1a1a 100%)",
        borderColor: color,
        boxShadow: `0 0 12px ${color}22`,
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColor }} />
        <span className="text-xs font-semibold text-foreground truncate">{data.label}</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="uppercase tracking-wider" style={{ color }}>{data.agentType}</span>
        {data.model && <span className="opacity-60">{data.model}</span>}
      </div>
      <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground/60">
        <span>#{data.iteration}</span>
        {data.score !== undefined && <span>★ {data.score.toFixed(1)}</span>}
      </div>
    </div>
  );
}

const nodeTypes = { agentNode: AgentNode };

// ── Component ────────────────────────────────────────────────────
export default function AgentTopology() {
  const swarmState = useSwarmStore((s) => s.swarmState);
  const activities = useSwarmStore((s) => s.activities);

  const agents = swarmState?.agents ?? {};

  // Build nodes from swarm agents
  const rawNodes: Node[] = useMemo(() => {
    return Object.entries(agents).map(([name, agent]) => ({
      id: name,
      type: "agentNode",
      data: {
        label: name,
        agentType: agent.role === "reviewer" ? "reviewer" : agent.role === "reviewer" || name.includes("-r") ? "reviewer" : "agent",
        status: agent.status,
        model: (agent as unknown as { modelName?: string }).modelName,
        iteration: agent.iteration ?? 0,
        score: agent.praiseCount !== undefined ? agent.praiseCount - (agent.criticismCount ?? 0) : undefined,
      },
      position: { x: 0, y: 0 },
    }));
  }, [agents]);

  // Build edges from all message activities (not just last 50).
  // Dedup by source→target so long-running swarms retain full topology.
  const rawEdges: Edge[] = useMemo(() => {
    const edges = new Map<string, Edge>();

    for (const a of activities) {
      if (a.type !== "broadcast" && a.type !== "steering") continue;
      const src = (a as unknown as { from?: string }).from;
      const tgt = (a as unknown as { to?: string }).to;
      if (!src || !tgt || src === tgt) continue;

      const key = `${src}→${tgt}`;
      if (!edges.has(key)) {
        edges.set(key, {
          id: key,
          source: src,
          target: tgt,
          animated: true,
          style: { stroke: "#525252", strokeWidth: 1, opacity: 0.5 },
          type: "smoothstep",
        });
      }
    }
    return Array.from(edges.values());
  }, [activities]);

  const nodes = useMemo(() => layoutNodes(rawNodes, rawEdges), [rawNodes, rawEdges]);

  if (rawNodes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground/60 text-sm">
        No agents spawned yet. Start a swarm run to see topology.
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={rawEdges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.3 }}
      minZoom={0.3}
      maxZoom={2}
      nodesDraggable={false}
      elementsSelectable={false}
      proOptions={{ hideAttribution: true }}
      className="bg-background"
    >
      <Background color="#1a1a1a" gap={20} />
      <Controls className="bg-card! border-border! rounded-lg!" />
      <MiniMap
        nodeColor={(n) => AGENT_COLORS[(n.data as { agentType: string }).agentType] || "#7C3AED"}
        maskColor="rgba(0,0,0,0.7)"
        className="bg-background! border-border! rounded-lg!"
      />
    </ReactFlow>
  );
}
