/**
 * Shiki syntax highlighter — singleton wrapper for on-demand code highlighting.
 *
 * Lazy-loads the highlighter on first use. Supports all major languages
 * used in swarm agent output (TS, JS, Python, Bash, SQL, YAML, etc.).
 */
import { createHighlighter, type Highlighter } from "shiki";

let highlighter: Highlighter | null = null;

const LANGS = [
  "typescript", "javascript", "python", "bash", "json",
  "yaml", "markdown", "sql", "html", "css", "tsx", "jsx",
];

export async function getHighlighter(): Promise<Highlighter> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: ["one-dark-pro"],
      langs: LANGS,
    });
  }
  return highlighter;
}

export async function highlightCode(code: string, lang: string): Promise<string> {
  try {
    const h = await getHighlighter();
    const langToUse = h.getLoadedLanguages().includes(lang) ? lang : "text";
    return h.codeToHtml(code.trimEnd(), {
      lang: langToUse,
      theme: "one-dark-pro",
    });
  } catch {
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
