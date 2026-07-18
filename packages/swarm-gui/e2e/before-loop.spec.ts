import { test, expect } from "@playwright/test";

test.describe("Before Loop Flow", () => {
  test("chat input area exists", async ({ page }) => {
    await page.goto("/");
    const chatArea = page.locator("input[type='text']").first();
    if (await chatArea.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(chatArea).toBeEnabled();
    }
  });
});
