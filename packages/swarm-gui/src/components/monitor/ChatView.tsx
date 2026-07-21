import { useState, useRef, useEffect, useMemo, useCallback, memo } from "react";
import { Send, Shield, Megaphone, Loader2, Swords, Check, CheckCircle2, Square, X, Sparkles, Bot, Brain, ChevronDown, Copy } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkTreeToCode } from "../../lib/remark-tree-to-code";
import { useSwarmStore } from "../../stores/swarm-store";
import { useSessionStore } from "../../stores/session-store";
import type { ChatMessage, LoopPhase } from "../../lib/types";
import { highlightCode } from "@oh-my-pi/pi-web/shiki";
import { EmptyState } from "../shared/EmptyState";
import { ErrorBoundary } from "../shared/ErrorBoundary";

// ── Code block cache ──────────────────────────────────────────────────
const codeCache = new Map<string, string>();
function cacheKey(code: string, lang: string) { return `${lang}:${code.slice(0, 200)}`; }

// ── Shiki code block renderer with copy button ─────────────────────────

function ShikiCodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(() => codeCache.get(cacheKey(code, lang)) ?? null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ck = cacheKey(code, lang);
    if (codeCache.has(ck)) { setHtml(codeCache.get(ck)!); return; }
    highlightCode(code, lang).then((h) => {
      if (!cancelled) { codeCache.set(ck, h); setHtml(h); }
    });
    return () => { cancelled = true; };
  }, [code, lang]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard denied */ }
  }, [code]);

  const header = (
    <div className="flex items-center justify-between px-3 py-1.5 bg-background border-b border-border rounded-t-lg">
      <span className="text-[11px] text-muted-foreground font-mono">{lang || "text"}</span>
      <button
        onClick={handleCopy}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground/80 transition-colors cursor-pointer"
      >
        {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );

  if (html === null) {
    return (
      <div className="my-1.5 rounded-lg overflow-hidden border border-border bg-background">
        {header}
        <pre className="p-3 overflow-x-auto text-xs font-mono bg-background">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="my-1.5 rounded-lg overflow-hidden border border-border bg-background">
      {header}
      <div
        className="shiki-wrapper text-xs [&_pre]:bg-background! [&_pre]:p-3 [&_pre]:overflow-x-auto"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
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
      [&_h1]:text-lg [&_h1]:font-bold [&_h1]:my-2 [&_h1]:border-b [&_h1]:border-border [&_h1]:pb-1
      [&_h2]:text-base [&_h2]:font-semibold [&_h2]:my-1.5
      [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:my-1
      [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:my-1.5 [&_blockquote]:text-muted-foreground [&_blockquote]:italic [&_blockquote]:bg-card/30 [&_blockquote]:py-1 [&_blockquote]:rounded-r
      [&_strong]:font-bold [&_strong]:text-foreground/90
      [&_em]:italic
      [&_del]:line-through [&_del]:text-muted-foreground
      [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a]:hover:text-primary/80
      [&_code]:bg-background [&_code]:text-primary/90 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono
      [&_table]:w-full [&_table]:my-1.5 [&_table]:text-xs [&_table]:border-collapse
      [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1.5 [&_th]:bg-background [&_th]:font-semibold [&_th]:text-left
      [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1
      [&_hr]:border-border [&_hr]:my-2
      [&_img]:rounded-lg [&_img]:max-w-full
    ">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkTreeToCode]}
        components={{
          code: ({ className, children, ...props }) => {
            if (className) {
              return <CodeRenderer className={className}>{children}</CodeRenderer>;
            }
            return <code className="bg-background text-primary/90 px-1 py-0.5 rounded text-xs font-mono" {...props}>{children}</code>;
          },
          pre: ({ children }) => <>{children}</>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

// ── Thinking block ── collapsible chain-of-thought section ─────────────

function ThinkingBlock({ thinking }: { thinking: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-muted-foreground transition-colors cursor-pointer select-none"
      >
        <Brain size={11} />
        <span>Thinking</span>
        <ChevronDown
          size={10}
          className={`transition-transform duration-200 ${open ? "rotate-0" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <div className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap border-l-2 border-border/60 pl-2.5 py-1 max-h-48 overflow-y-auto leading-relaxed">
          {thinking}
        </div>
      )}
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
          isSystem ? "text-muted-foreground" :
          "text-foreground/80"
        }`}>{msg.from}</span>
        <span className="text-xs text-muted-foreground/60">
          {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
        {isSteering && <Megaphone size={11} className="text-status-accent" />}
      </div>
      <div
        className={`max-w-[75%] rounded-xl px-3 py-1.5 text-sm ${
          isSteering
            ? "bg-status-accent/15 border border-status-accent/30 text-foreground"
            : isSystem
            ? "bg-card/50 text-muted-foreground italic text-xs"
            : isOperator
            ? "bg-primary/20 text-foreground/90"
            : isSocrates
            ? "bg-primary/10 border border-primary/20 text-foreground/90"
            : "bg-background-elevated text-foreground"
        }`}
      >
        {(msg as any).thinking ? <ThinkingBlock thinking={(msg as any).thinking} /> : null}
        {msg.streaming && !msg.body ? (
          <div className="flex items-center gap-1.5 py-0.5">
            <span className="inline-block w-2 h-2 rounded-full bg-background-overlay animate-pulse" style={{ animationDelay: "0ms" }} />
            <span className="inline-block w-2 h-2 rounded-full bg-background-overlay animate-pulse" style={{ animationDelay: "200ms" }} />
            <span className="inline-block w-2 h-2 rounded-full bg-background-overlay animate-pulse" style={{ animationDelay: "400ms" }} />
          </div>
        ) : (
          <ErrorBoundary fallbackText={msg.body}>
            <MessageBody body={isSteering ? msg.body.replace("[CLONER STEERING] ", "") : msg.body} />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}

// Memoized to prevent re-render when other messages change
const MemoMessageBubble = memo(MessageBubble);

function SystemEvent({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center py-1">
      <span className="text-xs text-muted-foreground/60 bg-background-elevated px-2 py-0.5 rounded-full">{text}</span>
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
  const viewingSession = useSessionStore((s) => s.viewingSession);
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

  // ── P1-3: stick-to-bottom during streaming ────────────────────────────
  // The last bubble grows token-by-token WITHOUT changing displayMessages.length,
  // so a length-only effect would not follow the stream. We track whether the
  // user is pinned near the bottom; if so we follow both new messages and the
  // growing body of the last one. If the user scrolls up to read history, we
  // stop auto-scrolling so we don't yank them back down.
  const stickRef = useRef(true);
  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // Body length of the last message — changes on every flushed stream batch.
  const lastBodyLen = channelMessages.length > 0
    ? channelMessages[channelMessages.length - 1].body.length
    : 0;

  // Reset stick + force scroll when switching sessions.
  useEffect(() => {
    stickRef.current = true;
  }, [viewingSession]);

  useEffect(() => {
    if (displayMessages.length === 0) return;
    if (stickRef.current) {
      // Instant align to end — smooth behavior janks during rapid streaming.
      virtualizer.scrollToIndex(displayMessages.length - 1, { align: "end" });
    }
  }, [displayMessages.length, lastBodyLen, viewingSession, virtualizer]);

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
      {/* ── Streaming indicator bar (always visible during active run) ── */}
      {loopPhase === "running" && isRunning && (
        <div className="shrink-0 flex items-center justify-between gap-3 border-b border-emerald-500/20 bg-emerald-950/30 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse-ring" />
            <span className="text-xs font-medium text-emerald-300/90">Swarm is working</span>
            <span className="text-[10px] text-emerald-400/60 hidden sm:inline">
              Press Stop to interrupt at the next iteration boundary.
            </span>
          </div>
          <button
            onClick={() => stopRun()}
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-foreground bg-red-600/80 hover:bg-red-500 rounded-md transition-colors cursor-pointer"
          >
            <Square size={12} fill="currentColor" />
            Stop Swarm
          </button>
        </div>
      )}

      {/* Messages — virtualized for performance */}
      <div ref={parentRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-3">
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
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-foreground bg-purple-600 hover:bg-purple-500 rounded-md transition-colors cursor-pointer"
              >
                <Swords size={12} />
                {loopPhase === "before-loop-confirm" ? "Run Debate Again" : "Run Debate"}
              </button>
              <button
                onClick={() => confirmAndStart()}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-foreground bg-emerald-600 hover:bg-emerald-500 rounded-md transition-colors cursor-pointer"
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
      <div className="border-t border-border px-4 py-2.5 bg-background-card">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 text-xs text-muted-foreground px-2 py-1 rounded-md bg-background-elevated">
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
            className="flex-1 bg-background-elevated text-foreground text-sm px-3 py-1.5 rounded-lg border border-border focus:border-primary/50 focus:outline-hidden disabled:opacity-50"
          />
          {/* Right-side action button — morphs by phase */}
          {loopPhase === "running" && isRunning ? (
            <button
              onClick={() => stopRun()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-foreground bg-red-600 hover:bg-red-500 rounded-lg transition-colors cursor-pointer"
              title="Stop the running swarm"
            >
              <Square size={14} fill="currentColor" />
              <span>Stop</span>
            </button>
          ) : (loopPhase === "before-loop-dialog" || loopPhase === "before-loop-confirm") && !isBusy ? (
            <button
              onClick={() => cancelBeforeLoop()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-foreground bg-background-elevated hover:bg-background-overlay rounded-lg transition-colors cursor-pointer"
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
