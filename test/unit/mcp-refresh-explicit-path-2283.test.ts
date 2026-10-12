import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshMcpOAuthFlag } from "../../src/lib/mcp-enable.ts";

test.each([false, true])("a dangling symlink at an explicit staging path is refused before any ops request (dryRun=%s)", async (dryRun) => {
  const dir = mkdtempSync(join(tmpdir(), "flair-refresh-explicit-path-"));
  try {
    const target = join(dir, "missing.env");
    const path = join(dir, "refresh.env");
    symlinkSync(target, path);
    let requests = 0;
    const fetchImpl = (async () => {
      requests++;
      throw new Error("unexpected ops request");
    }) as unknown as typeof fetch;
    const result = await refreshMcpOAuthFlag({
      instance: "https://flair.example.com",
      adminUser: "admin",
      adminPass: "fixture-password",
      secretsStagingPath: path,
      dryRun,
    }, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.dryRun).toBe(dryRun);
    expect(result.failedStep).toBe("secrets-provisioning");
    expect(result.refused?.message).toContain(path);
    expect(result.secretsPath).toBeUndefined();
    expect(requests).toBe(0);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe(target);
    expect(existsSync(target)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
