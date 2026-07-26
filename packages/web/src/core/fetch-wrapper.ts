/**
 * Generic fetch wrapper with typed JSON responses.
 *
 * Provides:
 * - Structured error handling via {@link ApiError}
 * - Request timeout via {@link AbortController}
 * - Binary downloads via {@link fetchBlob}
 */

// ── Error taxonomy ────────────────────────────────────────────────────

export type ApiErrorCategory =
  | "timeout"
  | "network"
  | "unauthorized"
  | "notFound"
  | "conflict"
  | "server"
  | "validation"
  | "unknown";

/** Structured API error — prefer inspecting `category` over string-matching `message`. */
export class ApiError extends Error {
  public readonly category: ApiErrorCategory;
  public readonly status: number;
  public readonly body: unknown;

  constructor(message: string, category: ApiErrorCategory, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.category = category;
    this.status = status;
    this.body = body;
  }

  get isClientError(): boolean { return this.status >= 400 && this.status < 500; }
  get isServerError(): boolean { return this.status >= 500; }
  get isNetworkError(): boolean { return this.category === "network"; }
  get isTimeoutError(): boolean { return this.category === "timeout"; }
}

// ── Status → category mapping ─────────────────────────────────────────

function categoryFromStatus(status: number): ApiErrorCategory {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "notFound";
  if (status === 409) return "conflict";
  if (status === 422) return "validation";
  if (status >= 500) return "server";
  return "unknown";
}

// ── Helpers ───────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;

function timeoutSignal(timeoutMs: number, existingSignal?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);

  // If caller already provided a signal, forward its abort to our controller.
  if (existingSignal) {
    if (existingSignal.aborted) {
      clearTimeout(timer);
      controller.abort(existingSignal.reason);
    } else {
      existingSignal.addEventListener("abort", () => {
        clearTimeout(timer);
        controller.abort(existingSignal.reason);
      }, { once: true });
    }
  }

  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// ── Public API ────────────────────────────────────────────────────────

export interface FetchJsonOptions extends Omit<RequestInit, "signal"> {
  /** Timeout in milliseconds (default 30 000). Set to 0 to disable. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Typed JSON fetch.
 *
 * Throws {@link ApiError} on non-2xx responses, timeouts, and network failures
 * so callers can branch on `err.category` instead of string-matching `err.message`.
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...init } = options;

  const { signal, clear } = timeoutMs > 0
    ? timeoutSignal(timeoutMs, callerSignal)
    : { signal: callerSignal, clear: () => {} };

  try {
    const res = await fetch(url, {
      ...init,
      signal,
      headers: { "Content-Type": "application/json", ...init.headers },
    });

    clear();

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const category = categoryFromStatus(res.status);
      const msg = `API error: ${res.status} ${res.statusText}`;
      console.error(msg, body);
      throw new ApiError(msg, category, res.status, body);
    }

    return res.json() as Promise<T>;
  } catch (err: unknown) {
    clear();

    // Already an ApiError — rethrow as-is.
    if (err instanceof ApiError) throw err;

    // AbortError from our timeout controller.
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError(`Request timed out after ${timeoutMs}ms`, "timeout", -1);
    }

    // AbortError from caller's signal — rethrow as plain AbortError so callers
    // can distinguish intentional cancellation from a timeout.
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }

    // Network error (fetch throws TypeError for DNS / connection failures).
    if (err instanceof TypeError) {
      throw new ApiError("Network error — check your connection", "network", 0);
    }

    // Unknown — wrap preserving the original message.
    throw new ApiError(String((err as Error)?.message ?? err), "unknown", 0);
  }
}

/**
 * Fetch a binary blob (for file downloads).
 *
 * Returns the raw {@link Response} so callers can read `.blob()`, `.arrayBuffer()`,
 * or inspect headers (e.g. Content-Disposition for filenames).
 */
export async function fetchBlob(url: string, options: FetchJsonOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...init } = options;

  const { signal, clear } = timeoutMs > 0
    ? timeoutSignal(timeoutMs, callerSignal)
    : { signal: callerSignal, clear: () => {} };

  try {
    const res = await fetch(url, { ...init, signal });
    clear();

    if (!res.ok) {
      const category = categoryFromStatus(res.status);
      const msg = `API error: ${res.status} ${res.statusText}`;
      throw new ApiError(msg, category, res.status);
    }

    return res;
  } catch (err: unknown) {
    clear();
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError(`Request timed out after ${timeoutMs}ms`, "timeout", -1);
    }
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (err instanceof TypeError) {
      throw new ApiError("Network error — check your connection", "network", 0);
    }
    throw new ApiError(String((err as Error)?.message ?? err), "unknown", 0);
  }
}
