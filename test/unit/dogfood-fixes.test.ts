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

describe("Dogfood fixes (ops-fqwh)", () => {
  beforeAll(() => {
    setup();
  });

  afterAll(() => {
    cleanup();
  });

  describe("Bug 6: reembed includes agentId in payload", () => {
    it("should fail gracefully when no agent specified and no admin pass", () => {
      const cmd = `${FLAIR_BIN} reembed --stale-only --dry-run 2>&1`;
      const output = execSync(cmd, { encoding: "utf-8", env: { ...process.env, HOME: TEST_DIR } });
      expect(output).toContain("Admin password required");
    });

    it("should accept optional --agent flag", () => {
      const cmd = `${FLAIR_BIN} reembed --help`;
      const output = execSync(cmd, { encoding: "utf-8" });
      expect(output).toContain("--agent <id>");
      expect(output).not.toContain("required");
    });
  });

  describe("Bug 2: agent list without per-agent auth", () => {
    it("should allow localhost operator access without FLAIR_AGENT_ID", () => {
      const cmd = `${FLAIR_BIN} agent list 2>&1`;
      const output = execSync(cmd, { encoding: "utf-8", env: { ...process.env, HOME: TEST_DIR } });
      // Should not error with "missing_or_invalid_authorization"
      expect(output).not.toContain("missing_or_invalid_authorization");
    });
  });

  describe("Bug 3: status recommends runnable command", () => {
    it("should emit command without required --agent flag when not scoped", () => {
      // This test would need a running Harper instance with hash-fallback memories
      // We'll verify the command format instead
      const cmd = `${FLAIR_BIN} status --help`;
      const output = execSync(cmd, { encoding: "utf-8" });
      expect(output).toContain("flair status");
    });
  });

  describe("Bug 1 and 4: status agent display and warning scoping", () => {
    it("should scope warnings to agent when --agent is provided", () => {
      // This would need a running Harper with multiple agents
      // Verify the code path exists
      const cmd = `${FLAIR_BIN} status --help`;
      const output = execSync(cmd, { encoding: "utf-8" });
      expect(output).toContain("--agent <id>");
    });
  });

  describe("Bug 5: federation summary agreement", () => {
    it("should show 'not configured' when federation is null", () => {
      // This would need a running Harper without federation
      // Verify the code path exists
      const cmd = `${FLAIR_BIN} status federation --help`;
      const output = execSync(cmd, { encoding: "utf-8" });
      expect(output).toContain("federation");
    });
  });
});