/**
 * Channel derivation — maps ActivityEntry types to ChatChannel + ChatMessage.
 *
 * Pure function extracted from swarm-store to keep the store focused on state
 * management.  Imported and called by addActivity().
 */

import type { ActivityEntry, ChatChannel, ChatMessage } from "./types";

export function deriveChannel(
  entry: ActivityEntry,
  seq: number,
): { id: string; channel: ChatChannel; message: ChatMessage } | null {
  const ts = entry.ts;
  switch (entry.type) {
    case "broadcast": {
      const id = "roundtable";
      return {
        id,
        channel: { id, type: "roundtable", name: "Roundtable", participants: [], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}-${seq}`, channelId: id, from: entry.from ?? "", to: "all", body: entry.body ?? "", timestamp: ts },
      };
    }
    case "subgroup": {
      const id = `subgroup-${entry.to}`;
      return {
        id,
        channel: { id, type: "subgroup", name: `#${entry.to}`, participants: [], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}-${seq}`, channelId: id, from: entry.from ?? "", to: entry.to ?? "", body: entry.body ?? "", timestamp: ts },
      };
    }
    case "steering": {
      // Operator steering to "all" → goes to roundtable (main chat)
      if (entry.from === "operator" && entry.to === "all") {
        const id = "roundtable";
        return {
          id,
          channel: { id, type: "roundtable", name: "Roundtable", participants: [], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
          message: { id: `${ts}-${entry.from}-${seq}`, channelId: id, from: entry.from ?? "", to: entry.to ?? "", body: entry.body ?? "", timestamp: ts },
        };
      }
      const id = `steering-${entry.from}-${entry.to}`;
      return {
        id,
        channel: { id, type: "steering", name: `${entry.from} -> ${entry.to}`, participants: [entry.from ?? "", entry.to ?? ""], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}-${seq}`, channelId: id, from: entry.from ?? "", to: entry.to ?? "", body: entry.body ?? "", timestamp: ts },
      };
    }
    // ── Deliberation events → per-round deliberation channels ──
    case "deliberation_challenge":
    case "deliberation_rebuttal":
    case "deliberation_ruling": {
      const round = entry.round ?? 0;
      const phase = entry.type === "deliberation_challenge" ? "challenge" : entry.type === "deliberation_rebuttal" ? "rebuttal" : "ruling";
      const id = `deliberation-r${round}`;
      return {
        id,
        channel: { id, type: "deliberation", name: `Deliberation R${round}`, participants: [], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}-${seq}`, channelId: id, from: entry.from ?? "", to: "all", body: `[${phase}] ${entry.body ?? ""}`, timestamp: ts },
      };
    }

    // ── Per-cloner individual verdict → dedicated cloner channel ──
    case "reviewer_individual": {
      const id = `agent-${entry.from}`;
      const verdictLabel = entry.passed ? "PASS" : "FAIL";
      const body = `**${verdictLabel}**${entry.findings?.length ? `\n${(entry.findings as string[]).map((f: string) => `· ${f}`).join("\n")}` : ""}`;
      return {
        id,
        channel: { id, type: "reviewer", name: `${entry.from}`, participants: [], unreadCount: 0, lastMessage: body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}-${seq}`, channelId: id, from: entry.from ?? "", to: "all", body, timestamp: ts },
      };
    }

    // ── File coordination → per-file channel ──
    case "file_coordination": {
      const file = entry.file ?? "unknown";
      const id = `file-${file.replace(/[/.]/g, "-")}`;
      return {
        id,
        channel: { id, type: "file", name: file, participants: [], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}-${seq}`, channelId: id, from: entry.from ?? "", to: "all", body: entry.body ?? "", timestamp: ts },
      };
    }

    // P2-10: Tool calls appear in the roundtable as system-style messages.
    case "tool_call": {
      const id = "roundtable";
      const status = entry.toolError ? "FAILED" : entry.toolDurationMs ? `OK (${(entry.toolDurationMs / 1000).toFixed(1)}s)` : "OK";
      const body = `🔧 **${entry.toolName}** ${status}${entry.toolError ? ` — ${entry.toolError}` : ""}`;
      return {
        id,
        channel: { id, type: "roundtable", name: "Roundtable", participants: [], unreadCount: 0, lastMessage: body, lastMessageTime: ts },
        message: { id: `${ts}-tool-${entry.toolName}-${seq}`, channelId: id, from: entry.agent ?? "agent", to: "all", body, timestamp: ts },
      };
    }
    default:
      return null;
  }
}
