import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("boot probes retain their output and descriptor validation", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flair-boot-probe-")));
  const script = realpathSync(join(import.meta.dir, "../../scripts/ci/boot-probe.mjs"));
  const run = (...args: string[]) => execFileSync("node", [script, ...args], { cwd: root, encoding: "utf8", timeout: 5000 });
  try {
    const file = join(root, "data.json"), mod = join(root, "descriptors.mjs"); writeFileSync(file, JSON.stringify({ pid: 123, version: "1.2.3" }));
    expect(run("realpath", file)).toBe(realpathSync(file));
    expect(run("pid", file)).toBe("123");
    expect(run("version", file)).toBe("1.2.3\n");
    expect(run("password")).toMatch(/^[A-Za-z0-9_-]{24}$/);
    writeFileSync(mod, "export const TOOL_DESCRIPTORS = [{}];\n");
    expect(run("descriptors", mod)).toBe("");
    writeFileSync(mod, "export const TOOL_DESCRIPTORS = [];\n");
    const bad = spawnSync("node", [script, "descriptors", mod], { cwd: root, encoding: "utf8", timeout: 5000 });
    expect(bad.error).toBeUndefined(); expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("no TOOL_DESCRIPTORS export");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
