/**
 * @satopi/pi-web — Shared web core for SatoPi
 */

export type { ApiErrorCategory, FetchJsonOptions } from "./fetch-wrapper";
export { ApiError, fetchBlob, fetchJson } from "./fetch-wrapper";
export { getHighlighter, highlightCode } from "./shiki";
export type { ConnectionHandler, SseEventHandler } from "./sse-client";
export { SseClient } from "./sse-client";
export type { ChatChannel, ChatMessage, SseEvent } from "./types";
