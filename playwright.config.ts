import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.FLAIR_URL ?? "http://localhost:9926";
const adminPass = process.env.FLAIR_ADMIN_PASS ?? "admin123";
const basicAuth = "Basic " + Buffer.from(`admin:${adminPass}`).toString("base64");

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  // The E2E suite runs against the Docker Harper image (5.1.14, matching the
  // bundled npm dep), which has historically carried the HarperFast/harper#386
  // HNSW concurrent-write race (the integration tests dodge it via native spawn;
  // the browser/UI E2E path still needs the Docker server). Parallel Playwright
  // workers fire concurrent writes that trip that race, which momentarily drops
  // the server → `socket hang up` / `ERR_CONNECTION_RESET` failures (ops-qhp0).
  // On CI: serialize to one worker so writes don't race, and retry transient
  // connection drops instead of failing the whole job. Locally (no CI env) keep
  // full parallelism + no retries for fast, honest feedback. This mitigation is
  // version-agnostic; if 5.1.14 has fixed #386 it can be relaxed later.
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL,
    // Flair's auth middleware returns a bare 401 JSON body (no WWW-Authenticate
    // header), so chromium won't auto-send Basic creds after a challenge.
    // Send the header preemptively on every request — for both API-mode tests
    // and browser-mode navigations.
    extraHTTPHeaders: {
      Authorization: basicAuth,
    },
    // Kept for parity with tools that honor it (e.g. API fetches via request).
    httpCredentials: {
      username: "admin",
      password: adminPass,
    },
  },
  projects: [
    {
      // API-only tests — no browser needed. Matches the original #227 pattern.
      name: "api",
      testMatch: /flair-endpoints\.spec\.ts/,
    },
    {
      // UI tests — rendered in chromium with Basic auth credentials.
      name: "chromium",
      testMatch: /admin-ui\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
