import { useRef, useEffect } from "react";
import { Send, Shield, Megaphone } from "lucide-react";
import { useSwarmStore } from "../../stores/swarm-store";
import type { ChatMessage } from "../../lib/types";

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isSteering = msg.body.startsWith("[CLONER STEERING]");
  const isOperator = msg.from === "operator";

  return (
    <div className={`flex flex-col gap-0.5 ${isOperator ? "items-end" : "items-start"}`}>
      <div className="flex items-center gap-1.5 px-1">
        <span className="text-xs font-medium text-neutral-300">{msg.from}</span>
        <span className="text-xs text-neutral-600">
          {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
        {isSteering && <Megaphone size={11} className="text-status-accent" />}
      </div>
      <div
        className={`max-w-[75%] rounded-xl px-3 py-1.5 text-sm ${
          isSteering
            ? "bg-status-accent/15 border border-status-accent/30 text-neutral-200"
            : isOperator
            ? "bg-primary/20 text-neutral-100"
            : "bg-background-elevated text-neutral-200"
        }`}
      >
        {isSteering ? msg.body.replace("[CLONER STEERING] ", "") : msg.body}
      </div>
    </div>
  );
}

function SystemEvent({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center py-1">
      <span className="text-xs text-neutral-600 bg-background-elevated px-2 py-0.5 rounded-full">{text}</span>
    </div>
  );
}

export default function ChatView() {
  const activeId = useSwarmStore((s) => s.activeChannelId);
  const messages = useSwarmStore((s) => s.messages);
  const activities = useSwarmStore((s) => s.activities);
  const scrollRef = useRef<HTMLDivElement>(null);

  const channelMessages = messages.get(activeId ?? "roundtable") ?? [];

  // Interleave system events (verdict, phase, scaling) into chat
  const systemEvents = activities.filter(
    (a) => a.type === "verdict" || a.type === "phase" || a.type === "scaling" || a.type === "nomination" || a.type === "crash"
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [channelMessages.length, systemEvents.length]);

  function getSystemText(a: typeof activities[0]): string {
    switch (a.type) {
      case "verdict": return `${a.passed ? "PASS" : "FAIL"} ${a.approval}/${a.total} ${a.findings?.[0] ?? ""}`;
      case "phase": return `Phase: ${a.phase}`;
      case "scaling": return `${a.action === "add" ? "+" : "-"}${a.worker} (${a.reason})`;
      case "nomination": return `Reviewer elected: ${a.elected ?? "none"}`;
      case "crash": return `${a.worker} crashed: ${a.error}`;
      default: return "";
    }
  }

  return (
    <div className="flex-1 flex flex-col bg-background">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {systemEvents.length > 0 && (
          <div className="space-y-1 mb-2">
            {systemEvents.slice(-10).map((a, i) => (
              <SystemEvent key={`${a.ts}-${i}`} text={getSystemText(a)} />
            ))}
          </div>
        )}
        {channelMessages.length === 0 && systemEvents.length === 0 && (
          <div className="flex items-center justify-center h-full text-neutral-600 text-sm">
            No messages yet. Waiting for swarm activity...
          </div>
        )}
        {channelMessages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}
      </div>

      {/* Input bar */}
      <div className="border-t border-background-border px-4 py-2.5 bg-background-card">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 text-xs text-neutral-500 px-2 py-1 rounded-md bg-background-elevated">
            <Shield size={12} />
            <span>Operator</span>
          </div>
          <input
            type="text"
            placeholder="Type a steering message to the swarm..."
            className="flex-1 bg-background-elevated text-neutral-200 text-sm px-3 py-1.5 rounded-lg border border-background-border focus:border-primary/50 focus:outline-none"
          />
          <button className="p-1.5 rounded-lg bg-primary/20 hover:bg-primary/30 text-primary transition-colors cursor-pointer">
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
