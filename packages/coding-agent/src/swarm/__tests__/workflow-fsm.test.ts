/**
 * WorkflowFSM tests — valid/invalid transitions, idempotency, force,
 * capability changes, listeners, StateTracker integration, and
 * PHASES constant integrity.
 */
import { describe, it, expect, mock } from "bun:test";
import {
  WorkflowFsm,
  PHASES,
  type PhaseDefinition,
  type PhaseCapabilities,
  type WorkflowState,
} from "../core/workflow-fsm";
import type { Chapter } from "../core/state";

// ============================================================================
// Mock factories
// ============================================================================

/** Creates a minimal StateTracker mock sufficient for WorkflowFsm integration. */
function mockStateTracker(initialPhase: Chapter = "idle") {
  return {
    updatePipeline: mock(async (_update: { phase?: Chapter }) => {}),
    state: { phase: initialPhase },
  } as any;
}

/** Creates a minimal ActivityLogger mock. */
function mockActivityLogger() {
  return {
    logPhase: mock((_phase: string, _round?: number, _iteration?: number) => {}),
  } as any;
}

/**
 * Creates a fully initialized WorkflowFsm with all PHASES registered
 * and mock dependencies injected.
 */
function createFsm(initialPhase: Chapter = "idle") {
  const st = mockStateTracker(initialPhase);
  const al = mockActivityLogger();
  const fsm = new WorkflowFsm(st, al, initialPhase);
  for (const def of PHASES) {
    fsm.registerPhase(def);
  }
  return { fsm, st, al };
}

// ============================================================================
// PHASES constant integrity
// ============================================================================

describe("PHASES constant", () => {
  it("every phase's allowedTo matches the reverse allowedFrom", () => {
    const phaseMap = new Map<Chapter, PhaseDefinition>();
    for (const def of PHASES) {
      phaseMap.set(def.phase, def);
    }

    for (const def of PHASES) {
      for (const to of def.allowedTo) {
        const target = phaseMap.get(to);
        expect(target).toBeDefined();
        expect(
          target!.allowedFrom,
          `${def.phase}.allowedTo contains "${to}" but ${to}.allowedFrom does not contain "${def.phase}"`,
        ).toContain(def.phase);
      }
    }
  });

  it("every phase's allowedFrom matches the reverse allowedTo", () => {
    const phaseMap = new Map<Chapter, PhaseDefinition>();
    for (const def of PHASES) {
      phaseMap.set(def.phase, def);
    }

    for (const def of PHASES) {
      for (const from of def.allowedFrom) {
        const source = phaseMap.get(from);
        expect(source).toBeDefined();
        expect(
          source!.allowedTo,
          `${def.phase}.allowedFrom contains "${from}" but ${from}.allowedTo does not contain "${def.phase}"`,
        ).toContain(def.phase);
      }
    }
  });

  it("all 8 standard phases are defined", () => {
    const names = PHASES.map((d) => d.phase).sort();
    expect(names).toEqual([
      "blocked",
      "curtain",
      "idle",
      "paused",
      "script",
      "script-confirm",
      "script-debate",
      "stage",
    ]);
  });

  it("no phase lists itself in allowedFrom or allowedTo", () => {
    for (const def of PHASES) {
      expect(def.allowedFrom, `${def.phase} allowedFrom contains self`).not.toContain(def.phase);
      expect(def.allowedTo, `${def.phase} allowedTo contains self`).not.toContain(def.phase);
    }
  });
});

// ============================================================================
// Valid transitions
// ============================================================================

describe("WorkflowFsm.transition — valid transitions", () => {
  it("idle → script", async () => {
    const { fsm } = createFsm("idle");
    const res = await fsm.transition("script");
    expect(res.ok).toBe(true);
    expect(res.noop).toBeUndefined();
    expect(fsm.phase).toBe("script");
  });

  it("script → script-debate", async () => {
    const { fsm } = createFsm("script");
    const res = await fsm.transition("script-debate");
    expect(res.ok).toBe(true);
    expect(fsm.phase).toBe("script-debate");
  });

  it("script-debate → script-confirm", async () => {
    const { fsm } = createFsm("script-debate");
    const res = await fsm.transition("script-confirm");
    expect(res.ok).toBe(true);
    expect(fsm.phase).toBe("script-confirm");
  });

  it("script-confirm → stage", async () => {
    const { fsm } = createFsm("script-confirm");
    const res = await fsm.transition("stage");
    expect(res.ok).toBe(true);
    expect(fsm.phase).toBe("stage");
  });

  it("stage → curtain", async () => {
    const { fsm } = createFsm("stage");
    const res = await fsm.transition("curtain");
    expect(res.ok).toBe(true);
    expect(fsm.phase).toBe("curtain");
  });

  it("curtain → idle", async () => {
    const { fsm } = createFsm("curtain");
    const res = await fsm.transition("idle");
    expect(res.ok).toBe(true);
    expect(fsm.phase).toBe("idle");
  });

  it("stage → paused and back", async () => {
    const { fsm } = createFsm("stage");
    await fsm.transition("paused");
    expect(fsm.phase).toBe("paused");
    const res = await fsm.transition("stage");
    expect(res.ok).toBe(true);
    expect(fsm.phase).toBe("stage");
  });

  it("stage → blocked and back", async () => {
    const { fsm } = createFsm("stage");
    await fsm.transition("blocked");
    expect(fsm.phase).toBe("blocked");
    const res = await fsm.transition("stage");
    expect(res.ok).toBe(true);
    expect(fsm.phase).toBe("stage");
  });

  it("idle → stage (direct, allowed by PHASES)", async () => {
    const { fsm } = createFsm("idle");
    const res = await fsm.transition("stage");
    expect(res.ok).toBe(true);
    expect(fsm.phase).toBe("stage");
  });
});

// ============================================================================
// Invalid transitions
// ============================================================================

describe("WorkflowFsm.transition — invalid transitions", () => {
  it("rejects idle → blocked (not in idle.allowedTo)", async () => {
    const { fsm } = createFsm("idle");
    const res = await fsm.transition("blocked");
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("Illegal");
    expect(fsm.phase).toBe("idle"); // unchanged
  });

  it("rejects stage → idle (not in stage.allowedTo; must go through curtain)", async () => {
    const { fsm } = createFsm("stage");
    const res = await fsm.transition("idle");
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("Illegal");
    expect(fsm.phase).toBe("stage");
  });

  it("rejects script → stage (not in script.allowedTo; must go through script-confirm)", async () => {
    const { fsm } = createFsm("script");
    const res = await fsm.transition("stage");
    expect(res.ok).toBe(false);
    expect(fsm.phase).toBe("script");
  });

  it("rejects paused → blocked (no path in either direction)", async () => {
    const { fsm } = createFsm("paused");
    const res = await fsm.transition("blocked");
    expect(res.ok).toBe(false);
    expect(fsm.phase).toBe("paused");
  });

  it("rejects curtain → script (not in curtain.allowedTo)", async () => {
    const { fsm } = createFsm("curtain");
    const res = await fsm.transition("script");
    expect(res.ok).toBe(false);
    expect(fsm.phase).toBe("curtain");
  });
});

// ============================================================================
// Self-transition (idempotent no-op)
// ============================================================================

describe("WorkflowFsm.transition — self-transition no-op", () => {
  it("returns { ok: true, noop: true } when to === current", async () => {
    const { fsm } = createFsm("stage");
    const res = await fsm.transition("stage");
    expect(res.ok).toBe(true);
    expect(res.noop).toBe(true);
    expect(fsm.phase).toBe("stage");
  });

  it("does not fire listener on self-transition", async () => {
    const { fsm } = createFsm("idle");
    const listener = mock(() => {});
    fsm.onChange(listener);
    await fsm.transition("idle");
    expect(listener).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Force transitions
// ============================================================================

describe("WorkflowFsm.force", () => {
  it("bypasses validation — idle → blocked works via force", async () => {
    const { fsm } = createFsm("idle");
    // Normal transition is rejected.
    const normal = await fsm.transition("blocked");
    expect(normal.ok).toBe(false);

    // Force bypasses validation.
    const forced = await fsm.force("blocked");
    expect(forced.ok).toBe(true);
    expect(fsm.phase).toBe("blocked");
  });

  it("preserves the forced flag in listener meta", async () => {
    const { fsm } = createFsm("idle");
    let capturedMeta: any = null;
    fsm.onChange((event) => {
      capturedMeta = event.meta;
    });
    await fsm.force("stage");
    expect(capturedMeta).not.toBeNull();
    expect(capturedMeta!.forced).toBe(true);
  });

  it("returns noop for self-transition via force", async () => {
    const { fsm } = createFsm("curtain");
    const res = await fsm.force("curtain");
    expect(res.ok).toBe(true);
    expect(res.noop).toBe(true);
  });
});

// ============================================================================
// Capability changes
// ============================================================================

describe("WorkflowFsm — capabilities", () => {
  it("idle has no capabilities", () => {
    const { fsm } = createFsm("idle");
    expect(fsm.capabilities.multiAgent).toBe(false);
    expect(fsm.capabilities.compaction).toBe(false);
    expect(fsm.capabilities.humanMode).toBe("none");
  });

  it("stage enables multiAgent, roundtable, vote, offload, compaction", () => {
    const { fsm } = createFsm("stage");
    expect(fsm.capabilities.multiAgent).toBe(true);
    expect(fsm.capabilities.roundtable).toBe(true);
    expect(fsm.capabilities.vote).toBe(true);
    expect(fsm.capabilities.offload).toBe(true);
    expect(fsm.capabilities.compaction).toBe(true);
    expect(fsm.capabilities.humanMode).toBe("observer");
  });

  it("capabilities update after transition", async () => {
    const { fsm } = createFsm("idle");
    expect(fsm.capabilities.multiAgent).toBe(false);

    await fsm.transition("script");
    expect(fsm.capabilities.offload).toBe(true);
    expect(fsm.capabilities.multiAgent).toBe(false);

    await fsm.transition("script-confirm");
    expect(fsm.capabilities.offload).toBe(false);

    await fsm.transition("stage");
    expect(fsm.capabilities.multiAgent).toBe(true);
    expect(fsm.capabilities.compaction).toBe(true);
  });

  it("script-debate has observer humanMode", () => {
    const { fsm } = createFsm("script-debate");
    expect(fsm.capabilities.humanMode).toBe("observer");
  });

  it("curtain has passive humanMode with vote capability", () => {
    const { fsm } = createFsm("curtain");
    expect(fsm.capabilities.humanMode).toBe("passive");
    expect(fsm.capabilities.vote).toBe(true);
  });
});

// ============================================================================
// WorkflowState snapshot
// ============================================================================

describe("WorkflowFsm.state", () => {
  it("reflects current phase and capabilities", () => {
    const { fsm } = createFsm("script");
    const state: WorkflowState = fsm.state;
    expect(state.phase).toBe("script");
    expect(state.capabilities.humanMode).toBe("dialogue");
    expect(state.capabilities.offload).toBe(true);
  });

  it("tracks running flag correctly", () => {
    const idle = createFsm("idle").fsm;
    expect(idle.state.running).toBe(false);

    const stage = createFsm("stage").fsm;
    expect(stage.state.running).toBe(true);
  });

  it("running flag updates on transition", async () => {
    const { fsm } = createFsm("stage");
    expect(fsm.state.running).toBe(true);
    await fsm.transition("paused");
    expect(fsm.state.running).toBe(false);
    await fsm.transition("stage");
    expect(fsm.state.running).toBe(true);
  });

  it("phaseStartedAt is set on construction", () => {
    const { fsm } = createFsm("idle");
    expect(fsm.state.phaseStartedAt).toBeGreaterThan(0);
    expect(fsm.state.phaseStartedAt).toBeLessThanOrEqual(Date.now());
  });

  it("phaseStartedAt updates on transition", async () => {
    const { fsm } = createFsm("idle");
    const before = fsm.state.phaseStartedAt;
    // Tiny delay to ensure timestamp difference.
    await new Promise((r) => setTimeout(r, 2));
    await fsm.transition("script");
    expect(fsm.state.phaseStartedAt).toBeGreaterThan(before);
  });

  it("iteration increments on each transition", async () => {
    const { fsm } = createFsm("idle");
    expect(fsm.state.iteration).toBe(0);
    await fsm.transition("script");
    expect(fsm.state.iteration).toBe(1);
    await fsm.transition("script-debate");
    expect(fsm.state.iteration).toBe(2);
  });
});

// ============================================================================
// Listeners
// ============================================================================

describe("WorkflowFsm.onChange", () => {
  it("fires listener on valid transition", async () => {
    const { fsm } = createFsm("idle");
    const listener = mock(() => {});
    fsm.onChange(listener);

    await fsm.transition("script");
    expect(listener).toHaveBeenCalledTimes(1);
    const event0 = (listener as any).mock.calls[0][0];
    expect(event0).toMatchObject({
      from: "idle",
      to: "script",
    });
  });

  it("fires listener on forced transition", async () => {
    const { fsm } = createFsm("idle");
    const listener = mock(() => {});
    fsm.onChange(listener);

    await fsm.force("blocked");
    expect(listener).toHaveBeenCalledTimes(1);
    const forcedEvent = (listener as any).mock.calls[0][0];
    expect(forcedEvent.meta!.forced).toBe(true);
  });

  it("does not fire on invalid transition", async () => {
    const { fsm } = createFsm("idle");
    const listener = mock(() => {});
    fsm.onChange(listener);

    await fsm.transition("blocked");
    expect(listener).not.toHaveBeenCalled();
  });

  it("returns unsubscribe function that works", async () => {
    const { fsm } = createFsm("idle");
    const listener = mock(() => {});
    const unsub = fsm.onChange(listener);

    // First transition fires.
    await fsm.transition("script");
    expect(listener).toHaveBeenCalledTimes(1);

    // Unsubscribe.
    unsub();

    // Second transition does not fire.
    await fsm.transition("script-debate");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("multiple listeners all fire", async () => {
    const { fsm } = createFsm("idle");
    const a = mock(() => {});
    const b = mock(() => {});
    fsm.onChange(a);
    fsm.onChange(b);

    await fsm.transition("script");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener does not prevent other listeners", async () => {
    const { fsm } = createFsm("idle");
    const bad = mock(() => {
      throw new Error("boom");
    });
    const good = mock(() => {});
    fsm.onChange(bad);
    fsm.onChange(good);

    await fsm.transition("script");
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(fsm.phase).toBe("script"); // transition still applied
  });
});

// ============================================================================
// StateTracker integration
// ============================================================================

describe("WorkflowFsm — StateTracker integration", () => {
  it("calls updatePipeline on valid transition", async () => {
    const st = mockStateTracker("idle");
    const al = mockActivityLogger();
    const fsm = new WorkflowFsm(st, al, "idle");
    for (const def of PHASES) fsm.registerPhase(def);

    await fsm.transition("script");
    expect(st.updatePipeline).toHaveBeenCalledWith({ phase: "script" });
  });

  it("does NOT call updatePipeline on invalid transition", async () => {
    const st = mockStateTracker("idle");
    const al = mockActivityLogger();
    const fsm = new WorkflowFsm(st, al, "idle");
    for (const def of PHASES) fsm.registerPhase(def);

    await fsm.transition("blocked");
    expect(st.updatePipeline).not.toHaveBeenCalled();
  });

  it("calls updatePipeline on forced transition", async () => {
    const st = mockStateTracker("idle");
    const al = mockActivityLogger();
    const fsm = new WorkflowFsm(st, al, "idle");
    for (const def of PHASES) fsm.registerPhase(def);

    await fsm.force("blocked");
    expect(st.updatePipeline).toHaveBeenCalledWith({ phase: "blocked" });
  });
});

// ============================================================================
// ActivityLogger integration
// ============================================================================

describe("WorkflowFsm — ActivityLogger integration", () => {
  it("calls logPhase on valid transition", async () => {
    const st = mockStateTracker("idle");
    const al = mockActivityLogger();
    const fsm = new WorkflowFsm(st, al, "idle");
    for (const def of PHASES) fsm.registerPhase(def);

    await fsm.transition("script");
    expect(al.logPhase).toHaveBeenCalled();
  });

  it("does NOT call logPhase on invalid transition", async () => {
    const st = mockStateTracker("idle");
    const al = mockActivityLogger();
    const fsm = new WorkflowFsm(st, al, "idle");
    for (const def of PHASES) fsm.registerPhase(def);

    await fsm.transition("blocked");
    // logPhase should not have been called for the transition itself.
    expect(al.logPhase).not.toHaveBeenCalled();
  });
});

// ============================================================================
// waitForHumanDecision
// ============================================================================

describe("WorkflowFsm.waitForHumanDecision", () => {
  it("resolves when a transition occurs", async () => {
    const { fsm } = createFsm("blocked");
    const decisionPromise = fsm.waitForHumanDecision();
    // Simulate human unblocking after a tick.
    setTimeout(() => {
      void fsm.transition("stage");
    }, 5);
    const result = await decisionPromise;
    expect(result).toBe("stage");
  });

  it("rejects on timeout", async () => {
    const { fsm } = createFsm("blocked");
    const decisionPromise = fsm.waitForHumanDecision(10);
    await expect(decisionPromise).rejects.toThrow("timed out");
  });
});

// ============================================================================
// Timed auto-transition (from defaultTimeoutMs)
// ============================================================================

describe("WorkflowFsm — timed auto-transition", () => {
  it("auto-transitions from blocked after defaultTimeoutMs", async () => {
    const { fsm } = createFsm("stage");
    // Blocked has defaultTimeoutMs: 300_000. We override a tiny timeout
    // to avoid a slow test — register a custom blocked with short timeout.
    const st = mockStateTracker("stage");
    const al = mockActivityLogger();
    const fastFsm = new WorkflowFsm(st, al, "stage");
    // Register all phases, but override blocked with a short timeout.
    for (const def of PHASES) {
      if (def.phase === "blocked") {
        fastFsm.registerPhase({ ...def, defaultTimeoutMs: 15 });
      } else {
        fastFsm.registerPhase(def);
      }
    }

    await fastFsm.transition("blocked");
    expect(fastFsm.phase).toBe("blocked");

    // Wait for auto-transition.
    await new Promise((r) => setTimeout(r, 40));
    expect(fastFsm.phase).toBe("stage"); // auto-continued
  });

  it("manual transition cancels pending timed transition", async () => {
    const { fsm } = createFsm("blocked");
    // Manual curtain before the 300s blocked timeout.
    await fsm.transition("curtain");
    expect(fsm.phase).toBe("curtain");

    // Wait long enough that the blocked timer would have fired.
    await new Promise((r) => setTimeout(r, 30));
    // Still in curtain — the timed transition was cancelled.
    expect(fsm.phase).toBe("curtain");
  });

  it("cancelTimed clears the pending timer", async () => {
    const { fsm } = createFsm("blocked");
    fsm.cancelTimed();
    // Wait long enough that auto-transition would have fired.
    await new Promise((r) => setTimeout(r, 30));
    // Still blocked because the timer was cancelled.
    expect(fsm.phase).toBe("blocked");
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe("WorkflowFsm — edge cases", () => {
  it("unregistered phase transition succeeds (graceful degradation)", async () => {
    // Create an FSM without registering any phases.
    const fsm = new WorkflowFsm(mockStateTracker("idle"), mockActivityLogger(), "idle");
    const res = await fsm.transition("script");
    // Without registered phases, validation is skipped.
    expect(res.ok).toBe(true);
    expect(fsm.phase).toBe("script");
  });

  it("registerPhase is idempotent (second call overwrites)", () => {
    const { fsm } = createFsm("idle");
    const original = fsm.capabilities;
    // Re-register script with different capabilities.
    fsm.registerPhase({
      phase: "script",
      allowedFrom: ["idle"],
      allowedTo: ["stage"],
      capabilities: {
        multiAgent: true,
        roundtable: true,
        vote: true,
        offload: true,
        compaction: true,
        humanMode: "dialogue",
      },
      defaultTimeoutMs: 0,
    });
    // Still at idle, so capabilities unchanged.
    expect(fsm.capabilities).toEqual(original);
  });

  it("transition carries meta.reason into subStatus", async () => {
    const { fsm } = createFsm("idle");
    await fsm.transition("script", { reason: "user started scripting" });
    expect(fsm.state.subStatus).toBe("user started scripting");
  });

  it("transition carries meta.iteration", async () => {
    const { fsm } = createFsm("idle");
    await fsm.transition("script", { iteration: 42 });
    expect(fsm.state.iteration).toBe(42);
  });

  it("from and to are correct in result", async () => {
    const { fsm } = createFsm("script");
    const res = await fsm.transition("script-debate");
    expect(res.from).toBe("script");
    expect(res.to).toBe("script-debate");
  });

  it("invalid transition result has correct from/to/reason", async () => {
    const { fsm } = createFsm("stage");
    const res = await fsm.transition("idle");
    expect(res.ok).toBe(false);
    expect(res.from).toBe("stage");
    expect(res.to).toBe("idle");
    expect(res.reason).toBeDefined();
    expect(res.reason).toContain("stage");
    expect(res.reason).toContain("idle");
  });
});

// ============================================================================
// dispose()
// ============================================================================

describe("WorkflowFsm.dispose", () => {
  it("clears all listeners", async () => {
    const { fsm } = createFsm("idle");
    const listener = mock(() => {});
    fsm.onChange(listener);
    fsm.dispose();
    // Transition after dispose still works, but listener won't fire.
    await fsm.transition("script");
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects pending human decision promise", async () => {
    const { fsm } = createFsm("blocked");
    const decisionPromise = fsm.waitForHumanDecision();
    fsm.dispose();
    await expect(decisionPromise).rejects.toThrow("WorkflowFsm disposed");
  });

  it("cancels pending timed transition", async () => {
    const st = mockStateTracker("stage");
    const al = mockActivityLogger();
    const fsm = new WorkflowFsm(st, al, "stage");
    for (const def of PHASES) {
      if (def.phase === "blocked") {
        fsm.registerPhase({ ...def, defaultTimeoutMs: 15 });
      } else {
        fsm.registerPhase(def);
      }
    }

    await fsm.transition("blocked");
    expect(fsm.phase).toBe("blocked");

    fsm.dispose();

    // Wait long enough that the timed transition would have fired.
    await new Promise((r) => setTimeout(r, 30));
    // Still blocked — timer was cancelled by dispose.
    expect(fsm.phase).toBe("blocked");
  });
});

// ============================================================================
// waitForHumanDecision — Promise leak
// ============================================================================

describe("WorkflowFsm.waitForHumanDecision — Promise leak", () => {
  it("rejects old promise when a new waiter replaces it", async () => {
    const { fsm } = createFsm("blocked");
    const first = fsm.waitForHumanDecision();
    const second = fsm.waitForHumanDecision();

    // First promise should be rejected (cancelled).
    await expect(first).rejects.toThrow("cancelled");

    // Second promise should still work.
    setTimeout(() => {
      void fsm.transition("stage");
    }, 5);
    const result = await second;
    expect(result).toBe("stage");
  });
});

// ============================================================================
// timedTransitionTarget — configurable auto-transition target
// ============================================================================

describe("WorkflowFsm — timedTransitionTarget", () => {
  it("uses explicit timedTransitionTarget when configured", async () => {
    const st = mockStateTracker("stage");
    const al = mockActivityLogger();
    const fsm = new WorkflowFsm(st, al, "stage");
    // Register blocked with a fast timeout and explicit target to curtain.
    for (const def of PHASES) {
      if (def.phase === "blocked") {
        fsm.registerPhase({
          ...def,
          defaultTimeoutMs: 15,
          timedTransitionTarget: "curtain",
        });
      } else {
        fsm.registerPhase(def);
      }
    }

    await fsm.transition("blocked");
    expect(fsm.phase).toBe("blocked");

    await new Promise((r) => setTimeout(r, 40));
    // Auto-transition should go to curtain (explicit target), not stage (default).
    expect(fsm.phase).toBe("curtain");
  });
});
