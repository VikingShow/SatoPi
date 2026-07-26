/**
 * agent-handle.ts — Thin wrapper around oh-my-pi's Agent + AgentSession.
 *
 * Provides a simplified API for the swarm system: wait(), send(), abort(),
 * and outputStream(). The AgentHandle is the only reference the swarm
 * pipeline needs to interact with a running agent.
 *
 * Part of the AgentRuntime system (Phase 3A).
 */

import type { Agent, AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";

// ============================================================================
// AgentHandle
// ============================================================================

/**
 * A lightweight handle for tracking and controlling a spawned agent.
 *
 * Wraps oh-my-pi's Agent instance without replacing it. The swarm pipeline
 * uses AgentHandle for status queries, result collection, messaging, and
 * streaming — no direct Agent manipulation needed.
 */
export class AgentHandle {
  readonly id: string;
  readonly role: string;
  readonly #agent: Agent;
  readonly #session: unknown; // oh-my-pi AgentSession — use `unknown` to avoid import complexity
  #status: "running" | "completed" | "failed" | "aborted" = "running";
  #completionPromise: Promise<SingleResult>;
  #resolveCompletion!: (result: SingleResult) => void;

  constructor(
    id: string,
    role: string,
    agent: Agent,
    session: unknown,
  ) {
    this.id = id;
    this.role = role;
    this.#agent = agent;
    this.#session = session;

    // Build completion promise — resolved when the agent finishes
    this.#completionPromise = new Promise<SingleResult>((resolve) => {
      this.#resolveCompletion = resolve;
    });

    // Listen for agent end events
    this.#wireCompletionTracking();
  }

  /** Current agent status. */
  get status(): "running" | "completed" | "failed" | "aborted" {
    return this.#status;
  }

  /** The underlying oh-my-pi Agent instance (for advanced use). */
  get agent(): Agent {
    return this.#agent;
  }

  /** The underlying oh-my-pi AgentSession (for advanced use). */
  get session(): unknown {
    return this.#session;
  }

	/**
	 * Subscribe to raw AgentEvents from the underlying Agent.
	 * Use this to wire Dashboard tool-execution rendering or
	 * bridge events to ActivityLogger.
	 *
	 * Returns an unsubscribe function.
	 */
	subscribe(callback: (event: AgentEvent) => void): () => void {
		return this.#agent.subscribe(callback);
	}

	bridgeToolEvents(activityLogger: { logToolCall: (agentName: string, toolName: string, input?: string, output?: string, error?: string, durationMs?: number) => void }): () => void {
		const toolTimers = new Map<string, number>();
		return this.#agent.subscribe((event: AgentEvent) => {
			switch (event.type) {
				case "tool_execution_start":
					toolTimers.set(event.toolCallId, Date.now());
					activityLogger.logToolCall(
						this.id,
						event.toolName,
						typeof event.args === "string" ? event.args : JSON.stringify(event.args),
					);
					break;
				case "tool_execution_end":
					activityLogger.logToolCall(
						this.id,
						event.toolName,
						undefined,
						typeof event.result === "string" ? event.result : JSON.stringify(event.result),
						event.isError ? String(event.result) : undefined,
						toolTimers.has(event.toolCallId)
							? Date.now() - toolTimers.get(event.toolCallId)!
							: undefined,
					);
					toolTimers.delete(event.toolCallId);
					break;
			}
		});
	}

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Wait for the agent to finish and return the result.
   *
   * Resolves when the agent's internal loop completes (success or failure).
   * Rejects only if the agent crashes without emitting an agent_end event
   * within a timeout (300s default).
   */
  async wait(timeoutMs = 300_000): Promise<SingleResult> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Agent "${this.id}" timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    );

    return Promise.race([this.#completionPromise, timeout]);
  }

  /**
   * Send a message to a running agent (steering interrupt).
   *
   * Uses oh-my-pi's `agent.steer()` to inject a message mid-turn.
   * The agent will process it at the next injection boundary.
   */
  async send(message: string): Promise<void> {
    const agentMessage: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: message }],
      timestamp: Date.now(),
    };
    this.#agent.steer(agentMessage);
  }

  /**
   * Send a follow-up message (processed after current turn completes).
   */
  async followUp(message: string): Promise<void> {
    const agentMessage: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: message }],
      timestamp: Date.now(),
    };
    this.#agent.followUp(agentMessage);
  }

  /**
   * Abort the agent immediately.
   *
   * Calls oh-my-pi's `agent.abort()` and marks the handle as "aborted".
   */
  abort(reason?: string): void {
    if (this.#status !== "running") return;
    this.#status = "aborted";
    this.#agent.abort(reason ?? "aborted by swarm pipeline");
    this.#resolveCompletion({
      index: 0,
      id: "aborted",
      agent: this.id,
      agentSource: "project" as const,
      task: "",
      exitCode: 1,
      output: `[Aborted] ${reason ?? "aborted by swarm pipeline"}`,
      stderr: "",
      truncated: false,
      durationMs: 0,
      tokens: 0,
      requests: 0,
    });
  }

  /**
   * Get an async iterable of output strings for real-time UI streaming.
   *
   * Subscribes to oh-my-pi Agent events and yields message deltas
   * as they arrive. The iterator ends when the agent finishes.
   */
  async *outputStream(): AsyncIterable<string> {
    const buffer: string[] = [];
    let done = false;
    let resolveNext: ((value: IteratorResult<string>) => void) | null = null;

    const unsubscribe = this.#agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "message_update": {
          const content = (event.message as { content?: unknown }).content;
          let text = "";
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("");
          }
          if (text && resolveNext) {
            resolveNext({ value: text, done: false });
            resolveNext = null;
          } else if (text) {
            buffer.push(text);
          }
          break;
        }
        case "message_end": {
          const content = (event.message as { content?: unknown }).content;
          let text = "";
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("");
          }
          if (text && resolveNext) {
            resolveNext({ value: text, done: false });
            resolveNext = null;
          } else if (text) {
            buffer.push(text);
          }
          break;
        }
        case "agent_end": {
          done = true;
          if (resolveNext) {
            resolveNext({ value: undefined, done: true });
            resolveNext = null;
          }
          break;
        }
      }
    });

    try {
      while (!done) {
        if (buffer.length > 0) {
          yield buffer.shift()!;
        } else {
          const result = await new Promise<IteratorResult<string>>((resolve) => {
            resolveNext = resolve;
          });
          if (result.done) break;
          yield result.value;
        }
      }
      // Drain remaining buffer
      while (buffer.length > 0) {
        yield buffer.shift()!;
      }
    } finally {
      unsubscribe();
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Wire oh-my-pi agent events into handle completion tracking.
   *
   * Listens for agent_end events to resolve the completion promise
   * with the assembled SingleResult.
   */
  #wireCompletionTracking(): void {
    const messages: string[] = [];

    this.#agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "message_start":
          // Track the full message text for the result
          break;

        case "message_update": {
          const content = (event.message as { content?: unknown }).content;
          if (typeof content === "string") {
            messages.push(content);
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") {
                messages.push(block.text);
              }
            }
          }
          break;
        }

        case "agent_end": {
          const output = messages.join("\n") || "(no output)";
          if (this.#status === "running") {
            this.#status = "completed";
          }
          this.#resolveCompletion({
            index: 0,
            id: this.id,
            agent: this.id,
            agentSource: "project" as const,
            task: "",
            exitCode: 0,
            output,
            stderr: "",
            truncated: false,
            durationMs: 0,
            tokens: 0,
            requests: 0,
          });
          break;
        }
      }
    });
  }
}
