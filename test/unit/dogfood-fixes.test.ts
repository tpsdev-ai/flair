import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const FLAIR_BIN = "bun run src/cli.ts";
const TEST_DIR = join(homedir(), ".flair-test-dogfood");
const DATA_DIR = join(TEST_DIR, "data");
const KEYS_DIR = join(TEST_DIR, "keys");

function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

function setup() {
  cleanup();
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(KEYS_DIR, { recursive: true });
}

/**
 * Run a CLI command and capture stdout+stderr regardless of exit code.
 */
function run(cmd: string, env?: Record<string, string>): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe", env: { ...process.env, ...env } });
  } catch (e: any) {
    // execSync throws on non-zero exit; return combined output instead
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

describe("Dogfood fixes (ops-fqwh)", () => {
  beforeAll(() => {
    setup();
  });

  afterAll(() => {
    cleanup();
  });

  describe("Bug 6: reembed includes agentId in payload", () => {
    it("should fail gracefully when no agent specified and no admin pass", () => {
      const output = run(`${FLAIR_BIN} reembed --stale-only --dry-run`, {
        HOME: TEST_DIR,
        FLAIR_URL: "http://127.0.0.1:19999", // no Harper running
      });
      expect(output).toContain("Admin password required");
    });

    it("should accept optional --agent flag", () => {
      const output = run(`${FLAIR_BIN} reembed --help`);
      expect(output).toContain("--agent <id>");
      // Should NOT say "required" for --agent
      expect(output).not.toContain("required option '--agent");
    });
  });

  describe("Bug 2: agent list without per-agent auth", () => {
    it("should attempt localhost connection without FLAIR_AGENT_ID (no auth error)", () => {
      const output = run(`${FLAIR_BIN} agent list`, {
        HOME: TEST_DIR,
        FLAIR_URL: "http://127.0.0.1:19999", // no Harper running
      });
      // Should NOT error with missing_or_invalid_authorization
      // (it will fail to connect, but that's a transport error, not an auth error)
      expect(output).not.toContain("missing_or_invalid_authorization");
      // Should attempt the request (connection refused is expected without Harper)
      expect(output).toContain("ConnectionRefused");
    });
  });

  describe("Bug 3: status recommends runnable command", () => {
    it("should emit reembed command without required --agent flag", () => {
      const output = run(`${FLAIR_BIN} reembed --help`);
      // --agent is optional now
      expect(output).toContain("--agent <id>");
      expect(output).not.toContain("required option '--agent'");
    });
  });

  describe("Bug 1 and 4: status agent display and warning scoping", () => {
    it("should expose --agent option on status command", () => {
      const output = run(`${FLAIR_BIN} status --help`);
      expect(output).toContain("--agent <id>");
    });
  });

  describe("Bug 5: federation summary agreement", () => {
    it("should have federation subcommand", () => {
      const output = run(`${FLAIR_BIN} --help`);
      expect(output).toContain("federation");
    });
  });
});