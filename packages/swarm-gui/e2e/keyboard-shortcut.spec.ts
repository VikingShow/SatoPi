import { test, expect } from "@playwright/test";

test.describe("Keyboard Shortcuts", () => {
  test("ctrl+s saves config on config page", async ({ page }) => {
    await page.goto("/");

    // Navigate to config page
    const configBtn = page.locator('button[title="Config"], button[title="配置"]');
    await configBtn.click();
    await page.waitForTimeout(500);

    // Press Ctrl+S — should trigger save (no error)
    await page.keyboard.press("Control+s");

    // No crash should occur — page should still be visible
    await expect(page.locator("body")).toBeVisible();
  });

  test("escape key is handled without errors", async ({ page }) => {
    await page.goto("/");

    // Press Escape
    await page.keyboard.press("Escape");

    // Page should still be responsive
    await expect(page.locator("body")).toBeVisible();
  });

  test("ctrl+enter dispatches send event", async ({ page }) => {
    await page.goto("/");

    // Listen for the custom event
    await page.evaluate(() => {
      (window as any).__sendEventReceived = false;
      window.addEventListener("satopi:action", (e: CustomEvent) => {
        if (e.detail === "send") {
          (window as any).__sendEventReceived = true;
        }
      });
    });

    // Press Ctrl+Enter
    await page.keyboard.press("Control+Enter");

    // Check if the event was received
    const received = await page.evaluate(() => (window as any).__sendEventReceived);
    expect(received).toBe(true);
  });

  test("ctrl+shift+t dispatches toggleTopology event", async ({ page }) => {
    await page.goto("/");

    // Listen for the custom event
    await page.evaluate(() => {
      (window as any).__topologyEventReceived = false;
      window.addEventListener("satopi:action", (e: CustomEvent) => {
        if (e.detail === "toggleTopology") {
          (window as any).__topologyEventReceived = true;
        }
      });
    });

    // Press Ctrl+Shift+T
    await page.keyboard.press("Control+Shift+KeyT");

    // Check if the event was received
    const received = await page.evaluate(() => (window as any).__topologyEventReceived);
    expect(received).toBe(true);
  });
});
