import { useEffect } from "react";

type KeyHandler = Record<string, () => void>;

export function useGlobalKeybindings(handlers: KeyHandler) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore when typing in input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      // Ctrl+Enter: Send message
      if (e.ctrlKey && e.key === "Enter") { handlers["send"]?.(); }
      // Escape: Close modal / cancel
      if (e.key === "Escape") { handlers["escape"]?.(); }
      // Ctrl+S: Save
      if (e.ctrlKey && e.key === "s") { e.preventDefault(); handlers["save"]?.(); }
      // Ctrl+K: Command palette (placeholder)
      if (e.ctrlKey && e.key === "k") { e.preventDefault(); handlers["command"]?.(); }
      // Ctrl+Shift+T: Toggle topology/chat
      if (e.ctrlKey && e.shiftKey && e.key === "T") { handlers["toggleTopology"]?.(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handlers]);
}
