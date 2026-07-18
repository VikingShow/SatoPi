import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface XtermTerminalProps {
  sseUrl?: string;
  className?: string;
}

export function XtermTerminal({ sseUrl = "/api/terminal/connect", className = "" }: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const inputBufferRef = useRef("");

  const fitTerminal = useCallback(() => {
    if (fitAddonRef.current) {
      try { fitAddonRef.current.fit(); } catch { /* ignore resize errors */ }
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      theme: {
        background: "#0d0d0d",
        foreground: "#d4d4d4",
        cursor: "#7C3AED",
        selectionBackground: "#7C3AED40",
        black: "#1a1a1a",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#f59e0b",
        blue: "#3b82f6",
        magenta: "#8b5cf6",
        cyan: "#06b6d4",
        white: "#d4d4d4",
        brightBlack: "#525252",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#fbbf24",
        brightBlue: "#60a5fa",
        brightMagenta: "#a78bfa",
        brightCyan: "#22d3ee",
        brightWhite: "#f5f5f5",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // SSE connection for terminal output
    const es = new EventSource(sseUrl);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "output") {
          terminal.write(data.data);
        }
      } catch {
        terminal.write(event.data);
      }
    };

    es.onerror = () => {
      terminal.writeln("\r\n\x1b[33m[Connection lost — retrying...]\x1b[0m");
    };

    // Send user input via POST
    terminal.onData((data) => {
      inputBufferRef.current += data;
      if (data === "\r") {
        // Carriage return → send the command
        const cmd = inputBufferRef.current.replace(/\r?\n$/, "");
        inputBufferRef.current = "";
        fetch("/api/terminal/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: cmd }),
        }).catch(() => terminal.writeln("\r\n\x1b[31m[Failed to send input]\x1b[0m"));
      }
    });

    const handleResize = () => fitTerminal();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      es.close();
      terminal.dispose();
    };
  }, [sseUrl, fitTerminal]);

  useEffect(() => {
    const observer = new ResizeObserver(() => fitTerminal());
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [fitTerminal]);

  return (
    <div
      ref={containerRef}
      className={`w-full h-full min-h-[200px] rounded-lg overflow-hidden ${className}`}
    />
  );
}
