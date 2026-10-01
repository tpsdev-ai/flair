import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = join(import.meta.dir, "..", "..", "src", "cli.ts");
const repo = join(import.meta.dir, "..", "..");

describe("flair mcp disable remote admin password text", () => {
  test("local admin credentials do not satisfy a remote target or appear as a suggested remedy", () => {
    const home = mkdtempSync(join(tmpdir(), "flair-2121-home-"));
    try {
      const flairDir = join(home, ".flair");
      mkdirSync(flairDir);
      const passFile = join(flairDir, "admin-pass");
      writeFileSync(passFile, "local-file-pass\n");
      chmodSync(passFile, 0o600);

      const result = spawnSync(process.execPath, [cli, "mcp", "disable", "--instance", "https://remote.example.invalid", "--confirm-flag-off"], {
        cwd: repo,
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          HOME: home,
          FLAIR_ADMIN_PASS: "local-env-pass",
          FLAIR_URL: "",
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--admin-pass <pass> is required for a REMOTE target");
      expect(result.stderr).toContain("Pass the target instance's admin password explicitly.");
      expect(result.stderr).not.toContain("FLAIR_ADMIN_PASS");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("help requires the target's admin password via --admin-pass", () => {
    const result = spawnSync(process.execPath, [cli, "mcp", "disable", "--help"], {
      cwd: repo,
      encoding: "utf8",
      timeout: 10000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Admin password for the remote target instance; pass it\s+explicitly with --admin-pass/);
    expect(result.stdout).not.toContain("FLAIR_ADMIN_PASS");
  }, 20_000);
});
