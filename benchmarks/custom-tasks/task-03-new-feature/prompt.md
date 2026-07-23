# Task: Add Pagination to User List API

Add pagination support to the existing `listUsers` function in `src/user-api.ts`. The function currently returns all users at once, which doesn't scale.

**Requirements:**
1. Add a `PaginationOptions` interface with `page` (default 1) and `pageSize` (default 20, max 100)
2. Modify `listUsers` to accept an optional `PaginationOptions` parameter
3. Return a `PaginatedResponse` containing `items`, `total`, `page`, `pageSize`, `totalPages`
4. The existing callers (no options passed) should still work — they should get paginated results with defaults
5. Do NOT change any other files

**Expected behavior:**
- `listUsers(store)` → returns first 20 users with pagination metadata
- `listUsers(store, { page: 2, pageSize: 10 })` → returns users 11-20 with correct metadata
- `listUsers(store, { pageSize: 200 })` → pageSize should be clamped to 100
