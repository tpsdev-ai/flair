import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Renders each server-side admin page in chromium, asserts a meaningful
// element is visible, and captures a full-page screenshot. Basic auth is
// wired via `use.httpCredentials` in playwright.config.ts.
//
// Screenshots land in test/e2e/screenshots/ (gitignored — this is smoke-test
// render coverage, not pixel-diff regression).

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.join(__dirname, "screenshots");

interface AdminPage {
  name: string;
  path: string;
  /** A heading string that must be visible on the rendered page. */
  heading: string;
}

const pages: AdminPage[] = [
  { name: "dashboard", path: "/AdminDashboard", heading: "Dashboard" },
  { name: "memory", path: "/AdminMemory", heading: "Memory" },
  { name: "principals", path: "/AdminPrincipals", heading: "Principals" },
  { name: "connectors", path: "/AdminConnectors", heading: "Connectors" },
  { name: "idp", path: "/AdminIdp", heading: "IdP" },
  { name: "instance", path: "/AdminInstance", heading: "Instance" },
];

test.describe("Admin UI — screenshots", () => {
  for (const p of pages) {
    test(`renders ${p.path}`, async ({ page }) => {
      const res = await page.goto(p.path, { waitUntil: "domcontentloaded" });
      expect(res, `no response for ${p.path}`).not.toBeNull();
      expect(res!.status(), `bad status for ${p.path}`).toBe(200);

      // Page title is set by admin-layout.ts as "<Title> — Flair Admin"
      await expect(page).toHaveTitle(new RegExp(`${p.heading} — Flair Admin`));

      // Main content <h1> should match the page heading.
      await expect(page.locator("main h1")).toContainText(p.heading);

      // Sidebar brand confirms the shared layout rendered.
      await expect(page.locator(".sidebar-brand")).toContainText("Flair");

      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `${p.name}.png`),
        fullPage: true,
      });
    });
  }
});

test.describe("Observation Center — screenshot", () => {
  test("renders /ObservationCenter", async ({ page }) => {
    const res = await page.goto("/ObservationCenter", { waitUntil: "domcontentloaded" });
    expect(res, "no response for /ObservationCenter").not.toBeNull();
    expect(res!.status(), "bad status for /ObservationCenter").toBe(200);
    await expect(page).toHaveTitle(/Observation Center/);
    await expect(page.locator(".hero h1")).toContainText("Observation Center");
    await expect(page.locator("#adminPass")).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "observation-center.png"),
      fullPage: true,
    });
  });
});
