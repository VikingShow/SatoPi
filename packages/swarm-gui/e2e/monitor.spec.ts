import { test, expect } from "@playwright/test";

test.describe("SatoPi Monitor Page", () => {
  test("page loads with top bar", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("text=SatoPi Swarm")).toBeVisible();
  });

  test("shows status indicator when no swarm running", async ({ page }) => {
    await page.goto("/");
    const status = page.locator("header span.text-xs.font-mono").first();
    await expect(status).toBeVisible({ timeout: 10000 });
  });

  test("config button is visible", async ({ page }) => {
    await page.goto("/");
    const configBtn = page.locator('button[title="Config"]').first();
    await expect(configBtn).toBeVisible({ timeout: 5000 });
  });

  test("renders without crashing", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("header")).toBeVisible({ timeout: 5000 });
  });
});
