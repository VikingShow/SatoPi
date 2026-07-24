# Task: Fix Validation Bug in User Service

Fix the input validation bug in `src/user-service.ts`. The `validateUserAge` function has a bug that allows invalid ages (zero and negative numbers).

**Requirements:**
1. Fix `validateUserAge` to reject age <= 0 (should require age >= 1)
2. Do NOT change `validateUserEmail` or `validateUserName` — they work correctly
3. Do NOT add or remove any comments
4. Do NOT change the VALID_EMAIL_REGEX constant

**Expected behavior:**
- `validateUserAge(0)` should return `{ valid: false, message: "..." }`
- `validateUserAge(-5)` should return `{ valid: false, message: "..." }`
- `validateUserAge(25)` should return `{ valid: true }` (existing behavior preserved)
