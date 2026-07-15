# Accessibility

`omp` is a terminal application. Accessibility in the terminal has different constraints than the web: no DOM, no ARIA, no browser zoom. This document covers what `omp` provides and how to configure it for screen readers, color-blindness, low vision, and keyboard-only use.

## Quick-start: screen reader users

```bash
omp config set symbolPreset ascii
omp config set statusLine.preset ascii
omp config set statusLine.separator ascii
```

These three settings replace every Unicode glyph, Nerd Font icon, and Powerline separator with plain ASCII text that screen readers can speak. The result reads as labelled text instead of silent or garbled Unicode.

## Symbol presets

`omp` renders status indicators, tool icons, tree connectors, box-drawing borders, and language badges with a configurable glyph set. Three presets exist:

| Preset | Description | Screen reader |
|---|---|---|
| `unicode` | Standard Unicode symbols (default) | Partial — some symbols speak, others are silent |
| `nerd` | Nerd Font private-use codepoints | No — private-use area is never spoken |
| `ascii` | Plain ASCII with text labels | Full — every element has a readable label |

Set the preset:

```bash
omp config set symbolPreset ascii
```

Or in the Settings panel: Appearance → Symbol Preset → ASCII.

The ASCII preset replaces every symbol across the entire UI: status indicators (`[ok]`, `[!!]`, `[*]`), tool icons (`$` for bash, `>_` for eval, `>>>` for task), box borders (`+`, `-`, `|`), tree connectors (`|--`, `'--`), language badges (`ts`, `py`, `rs`), and thinking level labels (`[min]`, `[high]`). Every glyph that would be silent or garbled becomes readable text.

The full symbol map (83 entries) lives in `packages/coding-agent/src/modes/theme/theme.ts` under `ASCII_SYMBOLS`.

## Status line

The status line at the bottom of the screen has its own preset and separator controls:

```bash
# Screen-reader-friendly: no non-ASCII separators, no Nerd Font icons
omp config set statusLine.preset ascii
omp config set statusLine.separator ascii

# Minimal: only path and git status, fewer elements to parse
omp config set statusLine.preset minimal
```

| Status line preset | What it shows |
|---|---|
| `default` | Model, path, git, context, tokens, cost |
| `minimal` | Path and git only |
| `compact` | Model, git, cost, context |
| `full` | All segments including time |
| `nerd` | Maximum info with Nerd Font icons |
| `ascii` | No special characters — screen-reader safe |
| `custom` | User-defined segments |

The separator setting controls the visual divider between status line segments. `ascii` uses `>` / `<`; `pipe` uses `|`; `none` removes dividers entirely.

## Color and contrast

### Color-blind mode

Shifts diff-addition green toward blue, making `+` lines in diffs distinguishable for protanopia/deuteranopia:

```bash
omp config set colorBlindMode true
```

The adjustment is applied at runtime to the `toolDiffAdded` theme color token. It only affects hex-valued tokens (numeric and variable-reference colors pass through unchanged). All other colors and the diff-removal (`toolDiffRemoved`) token are unaffected.

### Theme slots

`omp` maintains separate dark and light theme slots and auto-selects based on your terminal background:

```bash
omp config set theme.dark titanium
omp config set theme.light light
```

The auto-detection uses terminal-reported background luminance (OSC 11), the `COLORFGBG` variable, and macOS appearance as fallback. You can switch themes at any time from the Settings panel (Appearance → Dark Theme / Light Theme).

### High-contrast themes

`omp` ships with 80+ built-in themes. Several have high contrast between foreground text and background blocks:

- **`onyx`** / **`obsidian`** / **`dark-terminal`** — maximum contrast dark themes
- **`light-paper`** / **`light-github`** / **`light-monochrome`** — high-contrast light themes
- **`light-solarized`** / **`dark-solarized`** — well-tested contrast ratios

You can also create a custom theme. Copy any built-in from `~/.omp/agent/themes/` (the directory auto-creates on first launch), edit the colors, and select it by name. Every color token is required; see [Theming Reference](./theme.md) for the full schema and token list.

```json
{
  "name": "high-contrast",
  "colors": {
    "accent": "#00ffff",
    "text": "#ffffff",
    "muted": "#cccccc",
    "dim": "#999999",
    "selectedBg": "#444444",
    …
  }
}
```

## Keyboard navigation

`omp` is fully keyboard-driven. Every action has a keybinding, and every keybinding is remappable.

### View current bindings

Type `/hotkeys` inside an `omp` session to see every active chord and its action.

### Remap keys

Edit `~/.omp/agent/keybindings.yml`:

```yaml
app.model.cycleForward: Ctrl+P
app.model.cycleBackward: Shift+Ctrl+P
app.history.search: Ctrl+R
app.tools.expand: Ctrl+O
app.thinking.toggle: Ctrl+T
app.display.reset: Ctrl+L
app.message.followUp: Ctrl+Enter
app.retry: Alt+R
app.editor.external: Ctrl+G
app.clipboard.copyLine: Alt+Shift+L
```

Set an action to `[]` (empty array) to disable it. Chord names are case-insensitive and use the same notation shown in the UI (`Ctrl+P`, `Alt+Shift+P`, `Shift+Enter`, `Ctrl+Backspace`).

### Editor key bindings

The multi-line editor supports standard readline/emacs shortcuts:

| Key | Action |
|---|---|
| `Enter` | Submit |
| `Shift+Enter` / `Ctrl+Enter` / `Alt+Enter` | New line |
| `Tab` | Autocomplete |
| `Ctrl+A` / `Ctrl+E` | Line start/end |
| `Ctrl+W` / `Alt+Backspace` | Delete word backwards |
| `Alt+D` / `Alt+Delete` | Delete word forward |
| `Ctrl+U` | Delete to line start |
| `Ctrl+K` | Delete to line end / delete line |
| `Ctrl+-` | Undo last edit |
| `Ctrl+Left` / `Ctrl+Right` | Word navigation |
| `Alt+Left` / `Alt+Right` | Word navigation |

### Common action IDs

See [Keybindings](./keybindings.md) for the full table.

## Visual accessibility

### Hardware cursor

By default, `omp` shows the terminal's hardware cursor. If your terminal's cursor style or blink rate makes tracking difficult, you can hide it:

```bash
omp config set showHardwareCursor false
```

The software cursor (rendered inline in text) remains visible.

### Images

Inline images rely on Kitty or iTerm2 graphics protocols. If your terminal does not support these, or if images are visually distracting:

```bash
omp config set terminal.showImages false
```

Image placeholders are replaced with `[Image #N]` markers.

### Hyperlinks

OSC 8 hyperlinks can be disabled:

```bash
omp config set tui.hyperlinks off
```

### Font recommendations

- **Screen readers**: any monospace font works with `symbolPreset: ascii`
- **Nerd Font preset**: install a [Nerd Font](https://www.nerdfonts.com) (e.g. `JetBrainsMono Nerd Font`)
- **Unicode preset**: most modern monospace fonts have adequate coverage
- **CJK/wide-glyph scripts**: the TUI uses UAX#11 width measurement; wide glyphs are measured correctly

## Terminal emulator compatibility

`omp` targets modern terminal emulators with full ANSI escape support, synchronized output (DEC 2026), and bracketed paste. It probes capabilities at startup and degrades gracefully.

### Recommended terminals

| Terminal | Screen reader support | Notes |
|---|---|---|
| **VS Code integrated terminal** | Good — uses OS accessibility APIs | Works with VoiceOver, NVDA, JAWS, Orca |
| **iTerm2** | Good on macOS | Full graphic protocol support |
| **Ghostty** | Good | Fast, modern, Kitty graphics |
| **Windows Terminal** | Good with Narrator/NVDA | OSC 5522 enhanced paste |
| **WezTerm** | Good | Cross-platform, multiplexer |
| **Alacritty** | Basic — no multiplexer | Fast but fewer features |

### Multiplexers

`tmux` and `zellij` work but have known limitations: synchronized output may be disabled inside multiplexers, resizes wrap at old pane width, and `ED3` (clear scrollback) is never emitted inside a multiplexer to avoid pane corruption. For screen reader users, running `omp` directly in the terminal (not inside a multiplexer) generally works better.

## Environment overrides

| Variable | Effect |
|---|---|
| `PI_NO_SYNC_OUTPUT=1` | Disable DEC 2026 synchronized output |
| `PI_NO_DECCARA=1` | Disable DECCARA rectangular fills |
| `PI_TUI_SYNC_OUTPUT=0` | Same as `PI_NO_SYNC_OUTPUT` |
| `PI_FORCE_SYNC_OUTPUT=1` | Force synchronized output on |
| `COLORTERM=truecolor` | Force truecolor mode |

## Verification checklist

After configuring accessibility settings, verify they took effect:

```bash
# Confirm settings are active
omp config get symbolPreset
omp config get colorBlindMode
omp config get statusLine.preset
omp config get statusLine.separator

# Expected output for screen reader setup:
#   symbolPreset = ascii
#   colorBlindMode = false
#   statusLine.preset = ascii
#   statusLine.separator = ascii
```

Launch `omp` and confirm:
- Status indicators read as `[ok]`, `[!!]`, `[*]` rather than Unicode symbols
- Box borders use `+`, `-`, `|` characters
- Tool output headers show text labels (`$`, `>_`, `>>>`) rather than Nerd Font glyphs
- Status line segments use ASCII separators
