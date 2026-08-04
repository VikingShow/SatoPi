/**
 * Regression: Esc while an agent session is focused inside a crew must return
 * to the crew page (unfocus), not hit the crew-nav listener's leaveCrew path.
 *
 * TUI input dispatch runs global input listeners BEFORE the focused component
 * (tui.ts #handleInput), and a `{ consume: true }` result stops the dispatch.
 * The crew-nav listener used to match Esc whenever a crew was active and the
 * editor was focused+empty — including while viewing an agent session — and
 * called leaveCrew(), destroying the crew the user was trying to get back to.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CrewTranscriptView } from "@satopi/pi-coding-agent/modes/components/swarm/crew-transcript-view";
import { InputController } from "@satopi/pi-coding-agent/modes/controllers/input-controller";
import type { SwarmModeController } from "@satopi/pi-coding-agent/modes/controllers/swarm-mode-controller";
import { initTheme, theme } from "@satopi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@satopi/pi-coding-agent/modes/types";
import { TUI } from "@satopi/pi-tui";
import type { Terminal, TerminalAppearance } from "@satopi/pi-tui/terminal";

class MinimalTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	appearance: TerminalAppearance | undefined;
	#onInput: ((data: string) => void) | undefined;

	start(onInput: (data: string) => void): void {
		this.#onInput = onInput;
	}
	stop(): void {
		this.#onInput = undefined;
	}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}

	sendInput(data: string): void {
		this.#onInput?.(data);
	}
}

/** Editor double that carries the onEscape callback wired by setupKeyHandlers. */
function makeEditorStub() {
	const editor: {
		text: string;
		onEscape?: () => void;
		onLeftAtStart?: () => void;
		onChange?: (text: string) => void;
		onSubmit?: (text: string) => Promise<void> | void;
		onSpaceHoldStart?: () => void;
		onSpaceHoldEnd?: () => void;
		onExpandTools?: () => void;
		onDequeue?: () => void;
		onRetry?: () => void;
		onCopyPrompt?: () => void;
		pendingImages: unknown[];
		setText(text: string): void;
		getText(): string;
		setActionKeys(id: string, keys: string[]): void;
		setCustomKeyHandler(key: string, handler: () => void): void;
		clearCustomKeyHandlers(): void;
		addToHistory(text: string): void;
		clearDraft(historyText?: string): void;
		pasteText(text: string): void;
		render(width: number): string[];
		handleInput(data: string): void;
		sttHoldEnabled: boolean | (() => boolean);
	} = {
		text: "",
		pendingImages: [],
		setText(text: string) {
			this.text = text;
		},
		getText() {
			return this.text;
		},
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
		addToHistory: vi.fn(),
		clearDraft: vi.fn(),
		pasteText: vi.fn(),
		render() {
			return [] as string[];
		},
		handleInput(data: string) {
			if (data === "\x1b") this.onEscape?.();
			else if (data === "\u001b[D") this.onLeftAtStart?.();
		},
		sttHoldEnabled: false,
	};
	return editor;
}

function makeHarness() {
	const terminal = new MinimalTerminal();
	const tui = new TUI(terminal);
	const editor = makeEditorStub();
	const leaveCrew = vi.fn();
	const unfocusSession = vi.fn(async () => {});
	const focusState: { focusedAgentId?: string } = {};
	const crewView = new CrewTranscriptView(
		{
			crew: { id: "c1", name: "Test Crew", members: [], createdAt: Date.now() },
			topic: "test",
			totalRounds: 1,
			entries: [],
		},
		theme,
		() => {},
	);
	const ctx = {
		ui: tui,
		editor,
		keybindings: { getKeys: () => [] as string[] },
		swarmModeController: {
			isCrewActive: () => true,
			activeCrewView: crewView,
			leaveCrew,
		} as unknown as SwarmModeController,
		get focusedAgentId(): string | undefined {
			return focusState.focusedAgentId;
		},
		unfocusSession,
		hasActiveBtw: () => false,
		handleBtwEscape: () => false,
		hasActiveOmfg: () => false,
		handleOmfgEscape: () => false,
		loopModeEnabled: false,
		pauseLoop: vi.fn(),
		session: { isStreaming: false, extensionRunner: undefined },
		cancelPendingSubmission: vi.fn(),
		collabGuest: undefined,
		viewSession: {
			isCompacting: false,
			isGeneratingHandoff: false,
			isRetrying: false,
			abortCompaction: vi.fn(),
			abortHandoff: vi.fn(),
			abortRetry: vi.fn(),
		},
		showStatus: vi.fn(),
		showAgentHub: vi.fn(),
		showSwarmSidebar: vi.fn(),
		handlePlanModeCommand: vi.fn(),
		handleClearCommand: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		handleFollowUp: vi.fn(),
		handleSTTToggle: vi.fn(),
		handleCopyCurrentLine: vi.fn(),
		toggleToolOutputExpansion: vi.fn(),
		handleDequeue: vi.fn(),
		handleRetry: vi.fn(),
	} as unknown as InteractiveModeContext;

	return { terminal, tui, editor, ctx, leaveCrew, unfocusSession, focusState };
}

describe("crew-nav Esc arbitration", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("Esc while an agent session is focused unfocuses (returns to crew) instead of leaving the crew", () => {
		const { terminal, tui, editor, ctx, leaveCrew, unfocusSession, focusState } = makeHarness();
		const input = new InputController(ctx);
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			input.setupKeyHandlers();
			focusState.focusedAgentId = "Worker";

			terminal.sendInput("\x1b");

			expect(leaveCrew).not.toHaveBeenCalled();
			expect(unfocusSession).toHaveBeenCalledTimes(1);
		} finally {
			tui.stop();
		}
	});

	it("Esc on the crew page (nothing focused) still leaves the crew", () => {
		const { terminal, tui, editor, ctx, leaveCrew, unfocusSession } = makeHarness();
		const input = new InputController(ctx);
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			input.setupKeyHandlers();
			terminal.sendInput("\x1b");

			expect(leaveCrew).toHaveBeenCalledTimes(1);
			expect(unfocusSession).not.toHaveBeenCalled();
		} finally {
			tui.stop();
		}
	});
});
