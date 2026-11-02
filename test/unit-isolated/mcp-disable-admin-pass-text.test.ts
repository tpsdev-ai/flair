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

  test("help names both explicit password options for the target instance", () => {
    const result = spawnSync(process.execPath, [cli, "mcp", "disable", "--help"], {
      cwd: repo,
      encoding: "utf8",
      timeout: 10000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const help = result.stdout.replace(/\s+/g, " ");
    expect(help).toContain("Admin password for the target instance; use --admin-pass or --admin-pass-file");
    expect(help).toContain("Read the target instance's admin password from an owner-only file (group and world permission bits are refused; an owner-only mode such as 0600 or 0400 is accepted)");
    expect(help).toContain("Flair instance to disable against (else FLAIR_URL)");
    expect(help).not.toContain("remote");
    expect(result.stdout).not.toContain("FLAIR_ADMIN_PASS");
  }, 20_000);
});
