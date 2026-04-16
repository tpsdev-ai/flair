import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.FLAIR_URL ?? "http://localhost:9926";
const adminPass = process.env.FLAIR_ADMIN_PASS ?? "admin123";
const basicAuth = "Basic " + Buffer.from(`admin:${adminPass}`).toString("base64");

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  retries: 0,
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
