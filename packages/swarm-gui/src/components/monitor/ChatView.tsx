import { useRef, useEffect, useState, useMemo, useCallback, memo } from "react";
import { Send, Shield, Megaphone, Loader2, Swords, Check, CheckCircle2, Square, X } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useSwarmStore } from "../../stores/swarm-store";
import type { ChatMessage, LoopPhase } from "../../lib/types";
import { highlightCode } from "@oh-my-pi/pi-web/shiki";

// ── Code block cache ──────────────────────────────────────────────────
const codeCache = new Map<string, string>();
function cacheKey(code: string, lang: string) { return `${lang}:${code.slice(0, 200)}`; }

// ── Shiki code block renderer ──────────────────────────────────────────

type BodySegment = { type: "text"; content: string } | { type: "code"; lang: string; code: string };

function parseCodeBlocks(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(body)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: body.slice(lastIndex, match.index) });
    }
    segments.push({ type: "code", lang: match[1] || "text", code: match[2] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < body.length) {
    segments.push({ type: "text", content: body.slice(lastIndex) });
  }

  return segments;
}

function ShikiCodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(() => codeCache.get(cacheKey(code, lang)) ?? null);

  useEffect(() => {
    let cancelled = false;
    const ck = cacheKey(code, lang);
    if (codeCache.has(ck)) { setHtml(codeCache.get(ck)!); return; }
    highlightCode(code, lang).then((h) => {
      if (!cancelled) { codeCache.set(ck, h); setHtml(h); }
    });
    return () => { cancelled = true; };
  }, [code, lang]);

  if (html === null) {
    return (
      <pre className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-lg p-3 overflow-x-auto my-1 text-xs font-mono">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      className="shiki-wrapper my-1 rounded-lg overflow-hidden border border-[#1a1a1a] text-xs [&_pre]:bg-transparent! [&_pre]:p-3 [&_pre]:overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function MessageBody({ body }: { body: string }) {
  const segments = parseCodeBlocks(body);
  if (segments.length <= 1) {
    return <>{body}</>;
  }
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === "code"
          ? <ShikiCodeBlock key={i} code={seg.code} lang={seg.lang} />
          : <span key={i} className="whitespace-pre-wrap">{seg.content}</span>
      )}
    </>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isSteering = msg.body.startsWith("[CLONER STEERING]");
  const isOperator = msg.from === "operator";
  const isSystem = msg.from === "system";
  const isSocrates = msg.from === "socrates";

  return (
    <div className={`flex flex-col gap-0.5 ${isOperator ? "items-end" : "items-start"}`}>
      <div className="flex items-center gap-1.5 px-1">
        <span className={`text-xs font-medium ${
          isSocrates ? "text-primary" :
          isSystem ? "text-neutral-500" :
          "text-neutral-300"
        }`}>{msg.from}</span>
        <span className="text-xs text-neutral-600">
          {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
        {isSteering && <Megaphone size={11} className="text-status-accent" />}
      </div>
      <div
        className={`max-w-[75%] rounded-xl px-3 py-1.5 text-sm ${
          isSteering
            ? "bg-status-accent/15 border border-status-accent/30 text-neutral-200"
            : isSystem
            ? "bg-neutral-800/50 text-neutral-400 italic text-xs"
            : isOperator
            ? "bg-primary/20 text-neutral-100"
            : isSocrates
            ? "bg-primary/10 border border-primary/20 text-neutral-100"
            : "bg-background-elevated text-neutral-200"
        }`}
      >
        <MessageBody body={isSteering ? msg.body.replace("[CLONER STEERING] ", "") : msg.body} />
      </div>
    </div>
  );
}

// Memoized to prevent re-render when other messages change
const MemoMessageBubble = memo(MessageBubble);

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
  const loopPhase = useSwarmStore((s) => s.loopPhase);
  const isRunning = useSwarmStore((s) => s.isRunning);
  const beforeLoopState = useSwarmStore((s) => s.beforeLoopState);
  const sendBeforeLoopMessage = useSwarmStore((s) => s.sendBeforeLoopMessage);
  const sendSteering = useSwarmStore((s) => s.sendSteering);
  const startPlanning = useSwarmStore((s) => s.startPlanning);
  const runDebate = useSwarmStore((s) => s.runDebate);
  const confirmAndStart = useSwarmStore((s) => s.confirmAndStart);
  const stopRun = useSwarmStore((s) => s.stopRun);
  const cancelBeforeLoop = useSwarmStore((s) => s.cancelBeforeLoop);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [inputText, setInputText] = useState("");

  const channelMessages = messages.get(activeId ?? "roundtable") ?? [];

  // Interleave system events (verdict, phase, scaling) into chat
  const systemEvents = activities.filter(
    (a) => a.type === "verdict" || a.type === "phase" || a.type === "scaling" || a.type === "nomination" || a.type === "crash"
  );

  // Build message list: system events first, then channel messages
  const displayMessages = useMemo(() => {
    // Combine into a single flat list for virtualization
    const result: Array<{ type: "system"; key: string; text: string } | { type: "message"; key: string; msg: ChatMessage }> = [];
    // Show only last 20 system events for performance
    // Use a per-render counter to guarantee unique keys even when ts collides
    // (e.g. multiple system events with the same timestamp from history replay)
    for (let i = 0; i < systemEvents.slice(-20).length; i++) {
      const a = systemEvents.slice(-20)[i];
      result.push({ type: "system", key: `s-${a.ts}-${i}`, text: getSystemText(a) });
    }
    for (let i = 0; i < channelMessages.length; i++) {
      const msg = channelMessages[i];
      // Fallback to index-based key for messages without a stable id
      result.push({ type: "message", key: msg.id || `m-${i}-${msg.timestamp}`, msg });
    }
    return result;
  }, [systemEvents, channelMessages]);

  // Virtual scrolling for large message lists
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: displayMessages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 5,
  });

  // Auto-scroll to bottom on new messages
  const prevLenRef = useRef(displayMessages.length);
  useEffect(() => {
    if (displayMessages.length > prevLenRef.current) {
      virtualizer.scrollToIndex(displayMessages.length - 1, { behavior: "smooth" });
    }
    prevLenRef.current = displayMessages.length;
  }, [displayMessages.length, virtualizer]);

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

  // Determine input behavior based on loopPhase
  const isIdle = loopPhase === "idle";
  const isBeforeLoopDialog = loopPhase === "before-loop-dialog";
  const isLoopRunning = loopPhase === "running";
  const canSend = isIdle || isBeforeLoopDialog || isLoopRunning;
  const isBusy = beforeLoopState?.busy ?? false;
  const planReady = beforeLoopState?.planReady ?? false;

  const placeholder = isIdle
    ? "描述你的任务，开始规划..."
    : isBeforeLoopDialog
    ? (isBusy ? "Socrates is thinking..." : "Reply to Socrates...")
    : isLoopRunning
    ? "Type a steering message to the swarm..."
    : "";

  function handleSend() {
    const text = inputText.trim();
    if (!text || !canSend || isBusy) return;

    if (isIdle) {
      startPlanning(text);
    } else if (isBeforeLoopDialog) {
      sendBeforeLoopMessage(text);
    } else if (isLoopRunning) {
      sendSteering(text);
    }

    setInputText("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex-1 flex flex-col bg-background">
      {/* Messages — virtualized for performance */}
      <div ref={parentRef} className="flex-1 overflow-y-auto px-4 py-3">
        {displayMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-neutral-600 text-sm gap-2">
            {isIdle ? (
              <>
                <span className="text-2xl">👋</span>
                <span>在下方输入框描述你要完成的任务，开始 Before Loop 规划</span>
              </>
            ) : isBeforeLoopDialog
              ? "Describe your task to start planning with Socrates..."
              : isLoopRunning
              ? "No messages yet. Waiting for swarm activity..."
              : ""}
          </div>
        )}
        {displayMessages.length > 0 && (
          <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = displayMessages[virtualItem.index];
              return (
                <div
                  key={item.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                >
                  {item.type === "system"
                    ? <SystemEvent text={item.text} />
                    : <MemoMessageBubble msg={item.msg} />
                  }
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Context Action Bar — appears when plan is ready or debate is done */}
      {((loopPhase === "before-loop-dialog" && planReady) || loopPhase === "before-loop-confirm") && !isBusy && (
        <div className="border-t border-purple-800/40 px-4 py-2 bg-linear-to-r from-purple-950/30 to-blue-950/30">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-purple-300">
              <CheckCircle2 size={12} />
              {loopPhase === "before-loop-confirm" ? "Debate complete — plan refined" : "Plan draft ready"}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => runDebate()}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-white bg-purple-600 hover:bg-purple-500 rounded-md transition-colors cursor-pointer"
              >
                <Swords size={12} />
                {loopPhase === "before-loop-confirm" ? "Run Debate Again" : "Run Debate"}
              </button>
              <button
                onClick={() => confirmAndStart()}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-md transition-colors cursor-pointer"
              >
                <Check size={12} />
                Confirm & Start
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input bar — right-side button morphs based on loop phase:
            - idle / before-loop-confirm (with text) → Send
            - before-loop-dialog / before-loop-confirm (idle) → Cancel planning
            - running → Stop Swarm (red)
        */}
      <div className="border-t border-background-border px-4 py-2.5 bg-background-card">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 text-xs text-neutral-500 px-2 py-1 rounded-md bg-background-elevated">
            {isIdle ? (
              <>
                <Shield size={12} />
                <span>New Task</span>
              </>
            ) : isBeforeLoopDialog ? (
              <>
                <Shield size={12} />
                <span>Operator → Socrates</span>
              </>
            ) : isRunning ? (
              <>
                <Megaphone size={12} />
                <span>Steering</span>
              </>
            ) : (
              <>
                <Shield size={12} />
                <span>Operator</span>
              </>
            )}
          </div>
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!canSend || isBusy || isRunning}
            placeholder={placeholder}
            className="flex-1 bg-background-elevated text-neutral-200 text-sm px-3 py-1.5 rounded-lg border border-background-border focus:border-primary/50 focus:outline-hidden disabled:opacity-50"
          />
          {/* Right-side action button — morphs by phase */}
          {loopPhase === "running" && isRunning ? (
            <button
              onClick={() => stopRun()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors cursor-pointer"
              title="Stop the running swarm"
            >
              <Square size={14} fill="currentColor" />
              <span>Stop</span>
            </button>
          ) : (loopPhase === "before-loop-dialog" || loopPhase === "before-loop-confirm") && !isBusy ? (
            <button
              onClick={() => cancelBeforeLoop()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-neutral-200 bg-neutral-700 hover:bg-neutral-600 rounded-lg transition-colors cursor-pointer"
              title="Cancel Before Loop planning"
            >
              <X size={14} />
              <span>Cancel</span>
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend || isBusy || !inputText.trim()}
              className="p-1.5 rounded-lg bg-primary/20 hover:bg-primary/30 text-primary transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              title="Send message"
            >
              {isBusy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
