import { useRef, useEffect, useState, useMemo, useCallback, memo } from "react";
import { Send, Shield, Megaphone, Loader2, Swords, Check, CheckCircle2, Square, X, Sparkles, Bot, ChevronDown, ChevronUp } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSwarmStore } from "../../stores/swarm-store";
import type { ChatMessage, LoopPhase } from "../../lib/types";
import { highlightCode } from "@oh-my-pi/pi-web/shiki";
import { EmptyState } from "../shared/EmptyState";

// ── Code block cache ──────────────────────────────────────────────────
const codeCache = new Map<string, string>();
function cacheKey(code: string, lang: string) { return `${lang}:${code.slice(0, 200)}`; }

// ── Shiki code block renderer ──────────────────────────────────────────

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

// ── Custom code renderer for ReactMarkdown ─────────────────────────────

function CodeRenderer({ className, children }: { className?: string; children?: React.ReactNode }) {
  const lang = className?.replace("language-", "") ?? "";
  const code = String(children ?? "").replace(/\n$/, "");
  return <ShikiCodeBlock code={code} lang={lang} />;
}

function MessageBody({ body }: { body: string }) {
  return (
    <div className="prose prose-sm prose-invert max-w-none break-words 
      [&_p]:my-1 [&_p]:leading-relaxed
      [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5
      [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5
      [&_li]:my-0.5
      [&_h1]:text-lg [&_h1]:font-bold [&_h1]:my-2
      [&_h2]:text-base [&_h2]:font-semibold [&_h2]:my-1.5
      [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:my-1
      [&_blockquote]:border-l-2 [&_blockquote]:border-neutral-600 [&_blockquote]:pl-3 [&_blockquote]:my-1 [&_blockquote]:text-neutral-400 [&_blockquote]:italic
      [&_strong]:font-bold [&_strong]:text-neutral-100
      [&_em]:italic
      [&_del]:line-through [&_del]:text-neutral-500
      [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2
      [&_code]:bg-[#0d0d0d] [&_code]:text-primary/90 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono
      [&_table]:w-full [&_table]:my-1 [&_table]:text-xs [&_table]:border-collapse
      [&_th]:border [&_th]:border-[#1a1a1a] [&_th]:px-2 [&_th]:py-1 [&_th]:bg-[#0d0d0d] [&_th]:font-semibold [&_th]:text-left
      [&_td]:border [&_td]:border-[#1a1a1a] [&_td]:px-2 [&_td]:py-1
      [&_hr]:border-neutral-700 [&_hr]:my-2
    ">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ className, children, ...props }) => {
            // Only use custom code renderer for block code (has className with language-)
            if (className) {
              return <CodeRenderer className={className}>{children}</CodeRenderer>;
            }
            // Inline code
            return <code className="bg-[#0d0d0d] text-primary/90 px-1 py-0.5 rounded text-xs font-mono" {...props}>{children}</code>;
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
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
  const loadBeforeLoopHistory = useSwarmStore((s) => s.loadBeforeLoopHistory);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [inputText, setInputText] = useState("");
  // P2-2: Before-loop history state.
  const [historyEntries, setHistoryEntries] = useState<Array<{ role: string; content: string }>>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (loopPhase === "before-loop-dialog" || loopPhase === "before-loop-confirm") {
      loadBeforeLoopHistory().then(h => { if (h.length > 0) { setHistoryEntries(h); setShowHistory(true); } });
    }
  }, [loopPhase, loadBeforeLoopHistory]);

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
      // Always include index to guarantee unique keys
      result.push({ type: "message", key: `m-${i}-${msg.id || msg.timestamp}`, msg });
    }
    return result;
  }, [systemEvents, channelMessages]);

  // Virtual scrolling for large message lists
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: displayMessages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const item = displayMessages[index];
      if (!item) return 64;
      if (item.type === "message") {
        const body = item.msg.body;
        if (body.includes("```")) return 280;
        if (body.length > 800) return 200;
        if (body.length > 300) return 120;
      }
      return 64;
    },
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
  const isBeforeLoopConfirm = loopPhase === "before-loop-confirm";
  const isLoopRunning = loopPhase === "running";
  const canSend = isIdle || isBeforeLoopDialog || isLoopRunning;
  const isBusy = beforeLoopState?.busy ?? false;
  const planReady = beforeLoopState?.planReady ?? false;

  const placeholder = isIdle
    ? "Describe your task..."
    : isBeforeLoopDialog
    ? (isBusy ? "Socrates is thinking..." : "Reply...")
    : isBeforeLoopConfirm
    ? "Plan is ready. Use the buttons above to confirm or refine."
    : isLoopRunning
    ? "Give feedback or guidance..."
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
      {/* P2-2: Before-loop conversation history */}
      {historyEntries.length > 0 && showHistory && (
        <div className="px-4 pt-2">
          <button
            onClick={() => setShowHistory(false)}
            className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300 mb-1 cursor-pointer"
          >
            <ChevronDown size={12} /> Previous planning conversation ({historyEntries.length} turns) — click to hide
          </button>
          <div className="space-y-1 max-h-48 overflow-y-auto bg-neutral-900/30 rounded-lg p-2 border border-neutral-800/50">
            {historyEntries.map((entry, i) => (
              <div key={i} className={`text-xs px-2 py-1 rounded ${entry.role === "user" ? "text-neutral-400" : "text-primary/70"}`}>
                <span className="font-medium">{entry.role === "user" ? "You" : "Socrates"}:</span>{" "}
                {entry.content.slice(0, 300)}{entry.content.length > 300 ? "…" : ""}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Messages — virtualized for performance */}
      <div ref={parentRef} className="flex-1 overflow-y-auto px-4 py-3">
        {displayMessages.length === 0 && (
          <>
            {isIdle ? (
              <EmptyState
                icon={<Sparkles size={32} />}
                title="What would you like the swarm to build?"
                description="Describe your task below to start planning. You can also paste a GitHub issue, spec, or error message."
              />
            ) : isBeforeLoopDialog ? (
              <EmptyState
                icon={<Loader2 size={32} className="animate-spin" />}
                title="Discussing requirements with Socrates"
                description="Answer the questions to help refine the task. A plan will emerge from this dialogue."
              />
            ) : isLoopRunning ? (
              <EmptyState
                icon={<Bot size={32} />}
                title="Waiting for swarm activity..."
                description="Agents are being initialized. Messages will appear here once work begins."
              />
            ) : null}
          </>
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
            disabled={!canSend || isBusy}
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
