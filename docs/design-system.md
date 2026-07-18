# SatoPi Design Language

> v1.0 — Unified design tokens, terminology, and component patterns for the SatoPi web frontend.
> This is the single source of truth for all UI design decisions.

---

## 1. Design Principles

| Principle | Description |
|-----------|------------|
| **Dark-first, Gold-trimmed** | All UI starts from a dark surface palette. `#F59E0B` (amber-500) is the sole brand accent color. |
| **Translate internals** | Architecture terms (Socrates, Cloner, Before Loop) are never shown to users. Use plain language instead. |
| **One click to action** | No core operation requires more than two clicks. |
| **State always visible** | Current phase, agent activity, and system status are persistently shown. |
| **Reuse omp DNA** | Design token structure follows upstream collab-web patterns. Component architecture mirrors shadcn/ui conventions. |

---

## 2. Color System

### 2.1 Brand

```
Gold (primary)
  DEFAULT:     #F59E0B  (amber-500)
  hover:       #D97706  (amber-600)
  muted:       rgba(245, 158, 11, 0.15)
  foreground:  #0A0A0A  (text on gold backgrounds)
```

### 2.2 Surfaces — Neutral Ramp (Dark)

```
bg:             #0A0A0A  — page background (deepest)
bg-card:        #141414  — cards, sidebar, panels
bg-elevated:    #1C1C1C  — hover states, input backgrounds
bg-overlay:     #262626  — borders, dividers (lightest)
```

### 2.3 Text

```
fg:             #FAFAFA  — primary text
fg-muted:       #A3A3A3  — secondary text
fg-faint:       #525252  — tertiary/disabled text
```

### 2.4 Status Colors

```
success:        #22C55E  — completed, passed, connected
warning:        #F59E0B  — running, in-progress
danger:         #EF4444  — failed, crashed, error
info:           #3B82F6  — informational
accent:         #8B5CF6  — special marker (Cloner/Review context only)
```

### 2.5 Borders & Focus

```
border:         #262626  — default hairline
border-strong:  #404040  — emphasis
ring:           #F59E0B  — focus ring (matches primary)
```

---

## 3. Typography

```
Font UI:   "Inter", system-ui, sans-serif
Font Mono: "JetBrains Mono", "Fira Code", monospace
```

### Size Scale

| Token | Size | Usage |
|-------|------|-------|
| `text-xs` | 12px | Labels, metadata, badges |
| `text-sm` | 14px | Body text, messages, inputs |
| `text-base` | 16px | Headers, titles |
| `text-lg` | 18px | Page titles |
| `text-xl` | 20px | Major headings (rare) |

### Font Weight

| Token | Weight | Usage |
|-------|--------|-------|
| Normal | 400 | Body |
| Medium | 500 | Buttons, nav items |
| Semibold | 600 | Headers, labels |
| Bold | 700 | Emphasis (rare) |

---

## 4. Spacing & Layout

### Spacing Scale (Tailwind default)

| Token | PX | Usage |
|-------|-----|-------|
| `p-1` / `gap-1` | 4px | Icon+text gap, tight groups |
| `p-2` / `gap-2` | 8px | Button padding, card padding |
| `p-3` / `gap-3` | 12px | Content padding, section gaps |
| `p-4` / `gap-4` | 16px | Page padding, large gaps |
| `p-6` | 24px | Modal padding |

### Layout

```
Sidebar width:        56px  (w-14) — icon-only rail
Channel list width:   224px (w-56) — channel sidebar
Context panel width:  256px (w-64) — right detail panel
Header height:        48px  (h-12)
Input bar height:     ~48px (auto with textarea)
```

---

## 5. Border Radius

```
radius-sm:    6px   — inputs, badges, small elements
radius:       8px   — buttons, cards (default)
radius-lg:    12px  — panels, modals, large cards
rounded-full: 9999px — pills, status dots, toggle switches
```

---

## 6. Shadows

```
shadow-card:     0 1px 3px rgba(0, 0, 0, 0.4)    — default card
shadow-dropdown: 0 4px 16px rgba(0, 0, 0, 0.5)   — dropdowns, popovers
shadow-modal:    0 8px 32px rgba(0, 0, 0, 0.6)   — modals, dialogs
```

---

## 7. Component Patterns

### 7.1 Buttons

| Variant | Tailwind | When |
|---------|----------|------|
| Primary | `bg-primary text-background hover:bg-primary-hover` | Main actions (Start, Save, Confirm) |
| Secondary | `bg-background-elevated text-fg border border-border hover:bg-overlay` | Secondary actions |
| Danger | `bg-red-600 text-white hover:bg-red-500` | Destructive actions (Stop, Delete, Abort) |
| Ghost | `text-fg-muted hover:text-fg hover:bg-background-elevated` | Navigation, toggles |
| Icon | `text-fg-muted hover:text-fg p-1.5` | Toolbar buttons |

Size: `px-3 py-1.5 text-sm` (default), `px-4 py-2` (large)

### 7.2 Inputs

```
border border-border bg-background-elevated text-fg
rounded-radius
px-3 py-1.5 text-sm
focus:border-primary/50 focus:outline-none
disabled:opacity-50
placeholder:text-fg-faint
```

### 7.3 Cards

```
bg-background-card border border-border rounded-radius-lg
```

### 7.4 Status Badges

```
inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border

success: bg-success/10 border-success/30 text-success
warning: bg-warning/10 border-warning/30 text-warning
danger:  bg-danger/10 border-danger/30 text-danger
info:    bg-info/10 border-info/30 text-info
```

### 7.5 Empty States

```
Centered flex column
Large icon (text-fg-faint, 32px+)
Title (text-fg-muted, text-sm, font-medium)
Optional description (text-fg-faint, text-xs)
Optional CTA button
```

### 7.6 Loading States

```
Spinner: Loader2 icon with animate-spin (from lucide-react)
Skeleton: bg-background-elevated animate-pulse rounded
Button loading: replace icon with Loader2, disable button
```

---

## 8. Terminology Mapping

| Internal Concept | User-facing Label | Context |
|-----------------|-------------------|---------|
| Before Loop | Planning | Phase label, navigation |
| Socratic Dialogue | Discussing requirements | Chat context |
| Cloner Roundtable | Refining plan | Chat context |
| Before Loop Confirm | Ready to start | Button |
| Workers | Agents | Sidebar, topology |
| Cloners | Reviewers | Sidebar, topology |
| Steering | Give feedback or guidance... | Input placeholder |
| Loop Phase: running | Working | Status indicator |
| Loop Phase: blocked | Needs attention | Status indicator |
| Loop Phase: after-loop | Summarizing | Status indicator |
| Loop Phase: idle | Ready | Status indicator |
| PhasePipeline: Plan | 1. Planning | Step label |
| PhasePipeline: Debate | 2. Refining | Step label |
| PhasePipeline: Workers | 3. Working | Step label |
| PhasePipeline: Review | 4. Reviewing | Step label |
| PhasePipeline: After Loop | 5. Summary | Step label |

---

## 9. Iconography

Use **lucide-react** exclusively. Icons should be `size={14}` for inline, `size={16}` for standalone, `size={20}` for empty states.

| Context | Icon |
|---------|------|
| Brand/Logo | `Sparkles` |
| Monitor/Activity | `Activity` |
| Config/Settings | `Settings` |
| History | `History` |
| New Session | `PlusCircle` |
| Send message | `Send` |
| Stop | `Square` (filled) |
| Cancel | `X` |
| Confirm | `Check` |
| Debate | `Swords` |
| Thinking/Loading | `Loader2` (animated) |
| Connected | `Wifi` |
| Disconnected | `WifiOff` |
| Warning | `AlertTriangle` |
| Error | `AlertOctagon` |
| Worker | `Bot` |
| Reviewer/Cloner | `Crown` |
| Topology | `GitGraph` |
| Roles | `Users` |
| Plan/File | `FileText` |
| Tasks | `ListTodo` |
| Experience/Brain | `Brain` |

---

## 10. Motion

| Pattern | Duration | Easing | Usage |
|---------|----------|--------|-------|
| Hover transition | 150ms | ease-in-out | Buttons, links, interactive elements |
| Page transition | 200ms | ease-out | Page/modal entry |
| Status pulse | 1.5s | ease-in-out infinite | Running status dot |
| Spin | 1s linear infinite | — | Loading spinner |

Tailwind classes: `transition-colors duration-150`, `animate-pulse-ring`, `animate-spin`

---

## 11. Responsive Breakpoints

| Breakpoint | Width | Layout |
|-----------|-------|--------|
| Desktop | ≥1024px | Three-column (channels + chat + context) |
| Tablet | 768-1023px | Two-column (chat + drawer panel) |
| Mobile | <768px | Single column (chat, bottom sheet panels) |

---

## 12. CSS Architecture

```
globals.css structure:
  1. @import 'tailwindcss'
  2. @custom-variant dark
  3. @theme { ... }           — TW4 design tokens (colors, fonts, radii)
  4. @layer base { ... }      — CSS custom properties for shadcn compat
  5. @layer utilities { ... } — animations, markdown, scrollbar styles
```

**Rule**: No raw color values outside `globals.css`. All components reference design tokens via Tailwind classes.
