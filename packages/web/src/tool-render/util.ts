/**
 * Utility functions for tool renderers.
 * Extracted and simplified from collab-web tool-render.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function shortenPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return parts.slice(0, 2).join("/") + "/…/" + parts[parts.length - 1];
}

export function truncate(s: string, maxLen = 100): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const ANSI_RE =
  /[][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  toml: "ini",
  md: "markdown",
  sql: "sql",
  html: "html",
  css: "css",
  scss: "scss",
  xml: "xml",
  svg: "xml",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
};

export function languageFromPath(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  return EXT_TO_LANG[ext] ?? null;
}

export function resultTextOf(result: { content?: readonly { type: string; text?: string }[] } | undefined): string {
  if (!result?.content || !Array.isArray(result.content)) return "";
  return result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}
