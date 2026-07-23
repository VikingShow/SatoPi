# Task: Write Unit Tests for Data Transformer

Write comprehensive unit tests for the `transformData` utility function in `src/transformer.ts`. The function converts raw data records into a normalized format but currently has **no tests**.

**Requirements:**
1. Create `src/__tests__/transformer.test.ts` with comprehensive test cases
2. Cover the following scenarios:
   - Normal input with valid records
   - Empty input array
   - Input with missing optional fields (should use defaults)
   - Input with `null` or `undefined` values in optional fields
   - Input with invalid `id` (zero or negative) — should be filtered out
   - Verify correct field mapping (input fields → output fields)
3. Use a standard test framework (describe/it pattern or equivalent)
4. Do NOT modify `transformer.ts` — only add the test file

**Expected behavior:**
- All 6 test scenarios should pass
- The test file should be at `src/__tests__/transformer.test.ts`
