# Task: Refactor Shared Utility Functions

Refactor the `formatPrice` function that is used across multiple files. Currently, `formatPrice` is duplicated in both `src/pricing.ts` and `src/checkout.ts`. The task is to:

1. **Extract** `formatPrice` into a shared utility file at `src/utils/price-formatter.ts`
2. **Update** `src/pricing.ts` to import from the new shared location
3. **Update** `src/checkout.ts` to import from the new shared location
4. **Change the function signature** to accept an optional `locale` parameter (default: `"en-US"`)
5. **Update currency symbol** in the format from `"$"` prefix to using `Intl.NumberFormat`

**Requirements:**
- The new `formatPrice` must use `Intl.NumberFormat` with the given locale
- Both `pricing.ts` and `checkout.ts` must continue to work (all exports and callers preserved)
- The refactored code must produce equivalent output for the default locale `"en-US"`
- Do NOT change any other files
