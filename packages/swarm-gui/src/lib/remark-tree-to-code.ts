/**
 * remark plugin: detect paragraphs containing Unicode box-drawing / tree
 * characters and convert them to fenced code blocks so they render in
 * monospace (preserving alignment).
 *
 * Operates at the mdast AST level — no string-level pre-processing needed.
 *
 * Usage:
 *   <ReactMarkdown remarkPlugins={[remarkGfm, remarkTreeToCode]}>
 *     {body}
 *   </ReactMarkdown>
 */

import type { Root } from "mdast";
import { visit } from "unist-util-visit";

const TREE_RE = /[─━│┃├└┌┐┘┤┴┬┼╭╮╰╯]/;

/**
 * Extract the plain-text content of a paragraph node.
 * Ignores inline formatting (bold, italic, links, inline code) —
 * only concatenates `text` children.
 */
function extractText(node: any): string {
  if (!node.children) return "";
  return node.children
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.value)
    .join("");
}

export function remarkTreeToCode() {
  return (tree: Root) => {
    visit(tree, "paragraph", (node, index, parent) => {
      if (parent === null || parent === undefined) return;
      const text = extractText(node);
      if (!TREE_RE.test(text)) return;

      // Replace the paragraph node with a code node so ReactMarkdown
      // renders it in a monospace <pre> block.
      parent.children.splice(index!, 1, {
        type: "code",
        lang: null,
        meta: null,
        value: text,
      });
    });
  };
}
