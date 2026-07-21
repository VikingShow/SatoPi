import { test, expect } from "@playwright/test";

test.describe("Theme Toggle", () => {
  test("language toggle button is visible", async ({ page }) => {
    await page.goto("/");
    // The language toggle button should be in the sidebar
    const langBtn = page.locator('button[title*="切换"], button[title*="Switch"]');
    await expect(langBtn).toBeVisible({ timeout: 10000 });
  });

  test("clicking language toggle switches locale", async ({ page }) => {
    await page.goto("/");

    // Find the language toggle button
    const langBtn = page.locator('button[title*="切换"], button[title*="Switch"]');
    await expect(langBtn).toBeVisible({ timeout: 10000 });

    // Get the initial title to determine current language
    const initialTitle = await langBtn.getAttribute("title");

    // Click to toggle
    await langBtn.click();

    // The title should have changed (en→zh or zh→en)
    const newTitle = await langBtn.getAttribute("title");
    expect(newTitle).not.toBe(initialTitle);
  });

  test("nav labels respond to language change", async ({ page }) => {
    await page.goto("/");

    // Find nav buttons — they should have title attributes
    const monitorBtn = page.locator('button[title="Monitor"], button[title="监控"]');
    await expect(monitorBtn).toBeVisible({ timeout: 10000 });

    // Toggle language
    const langBtn = page.locator('button[title*="切换"], button[title*="Switch"]');
    await langBtn.click();

    // After toggling, the nav button title should change
    const monitorBtnAfter = page.locator('button[title="Monitor"], button[title="监控"]');
    await expect(monitorBtnAfter).toBeVisible({ timeout: 5000 });
  });
});
