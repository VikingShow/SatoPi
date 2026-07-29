# Plan: Change PI_LOGO Rows 2–5 to 2π Side

## Overview
In `welcome.ts`, the `PI_LOGO` ASCII-art array currently uses 3π characters on each side for rows 2–5 (the vertical side panels). Change these to 2π per side, adjusting indentation to preserve the 25-character total width, and update all associated comments.

## Phase 1: Modify PI_LOGO and Comments
**Contract:** `PI_LOGO` remains a `readonly string[]` of 8 rows, each 25 characters wide. Only rows 2–5 change. All consumers (`gradientLogo`, `REST_FRAME`, splash, outro, wizard-overlay) are unaffected — they operate on whatever characters the array holds.

- [ ] **Task: Update PI_LOGO rows 2–5 and doc comments**
  - Files: `src/modes/components/welcome.ts`
  - Change:
    1. Header doc comment (line ~454): change `side(3π)` to `side(2π)` in the ring thickness description.
    2. Row 2 (line ~466): replace `"   πππ··πππππππππ··πππ   "` with `"    ππ··πππππππππ··ππ    "` and update the trailing comment to `//  row 2 — 2π side + 2· + 9π bar + 2· + 2π side`.
    3. Row 3 (line ~467): replace `"   πππ···πππ·πππ···πππ   "` with `"    ππ···πππ·πππ···ππ    "` and update the trailing comment to `//  row 3 — 2π side + 3· + 3π leg + · + 3π leg + 3· + 2π side`.
    4. Row 4 (line ~468): replace `"   πππ···πππ·πππ···πππ   "` with `"    ππ···πππ·πππ···ππ    "` (no comment needed; mirrors row 3).
    5. Row 5 (line ~469): replace `"   πππ···πππ·πππ···πππ   "` with `"    ππ···πππ·πππ···ππ    "` (no comment needed; mirrors row 3).
  - Acceptance: Each updated row is exactly 25 characters wide. `PI_LOGO` has 8 elements. All 2π and 3π character counts match their updated comments. File passes type-check.
  - Depends: none

## Phase 2: Verify
**Contract:** No behavioral regression. The logo renders identically through all existing consumers.

- [ ] **Task: Type-check and confirm no regressions**
  - Files: `src/modes/components/welcome.ts`
  - Change: Run `bun check` (or `tsc --noEmit`) on the package to confirm no type errors introduced.
  - Acceptance: Type-check passes with zero errors. `PI_LOGO` still exported and usable by all importers.
  - Depends: Update PI_LOGO rows 2–5 and doc comments
