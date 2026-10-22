// test/integration suites declare server-read FLAIR_* variables through
// startHarper's serverEnv. A bare assignment on the test process instead only
// reaches the spawned Harper by inheritance and leaks into later tests, so it
// is allowed only for a variable this process reads, listed here per (file,
// variable) with its reader.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const INTEGRATION_DIR = join(REPO_ROOT, "test", "integration");
const ASSIGNMENT = /process\.env\.(FLAIR_[A-Z0-9_]+)\s*=(?!=)/;

const ALLOWED: ReadonlyArray<{ file: string; variable: string; reason: string }> = [
  {
    file: "test/integration/feed-ephemeral-expiry-e2e.test.ts",
    variable: "FLAIR_EPHEMERAL_TTL_HOURS",
    reason: "the in-process stampEphemeralExpiry() call reads it; the spawned Harper gets it through serverEnv",
  },
  {
    file: "test/integration/cursor-wake-cli-launch-receipt-1940.test.ts",
    variable: "FLAIR_AGENT_ID",
    reason: "the cursor-wake CLI child reads it in-process",
  },
  {
    file: "test/integration/cursor-wake-cli-launch-receipt-1940.test.ts",
    variable: "FLAIR_URL",
    reason: "the cursor-wake CLI child reads it in-process",
  },
  {
    file: "test/integration/cursor-wake-cli-launch-receipt-1940.test.ts",
    variable: "FLAIR_KEY_PATH",
    reason: "the cursor-wake CLI child reads it in-process",
  },
  {
    file: "test/integration/write-reply-redaction-2537.test.ts",
    variable: "FLAIR_URL",
    reason: "the in-process pi-flair client reads it",
  },
  {
    file: "test/integration/write-reply-redaction-2537.test.ts",
    variable: "FLAIR_AGENT_ID",
    reason: "the in-process pi-flair client reads it",
  },
  {
    file: "test/integration/write-reply-redaction-2537.test.ts",
    variable: "FLAIR_KEY_PATH",
    reason: "the in-process pi-flair client reads it",
  },
];

function integrationFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...integrationFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found.sort();
}

function assignments(): Array<{ file: string; variable: string; line: number }> {
  const found: Array<{ file: string; variable: string; line: number }> = [];
  for (const path of integrationFiles(INTEGRATION_DIR)) {
    const file = relative(REPO_ROOT, path);
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((text, index) => {
        for (const match of text.matchAll(new RegExp(ASSIGNMENT, "g"))) {
          found.push({ file, variable: match[1]!, line: index + 1 });
        }
      });
  }
  return found;
}

const key = (entry: { file: string; variable: string }): string => `${entry.file}\u0000${entry.variable}`;

test("test/integration assigns no FLAIR_* variable outside the allowlist", () => {
  const allowed = new Set(ALLOWED.map(key));
  const unexpected = assignments()
    .filter((entry) => !allowed.has(key(entry)))
    .map((entry) => `${entry.file}:${entry.line} process.env.${entry.variable} =`);
  expect(unexpected).toEqual([]);
});

test("every allowlist entry is an existing assignment and carries a reason", () => {
  const current = new Set(assignments().map(key));
  const stale = ALLOWED.filter((entry) => entry.reason.trim().length === 0 || !current.has(key(entry))).map(
    (entry) => `${entry.file}: ${entry.variable}`,
  );
  expect(stale).toEqual([]);
});
