import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertFlairDistFresh } from "../helpers/dist-freshness.js";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle.js";

test("startHarper boots a resources-only copied build with a null commit", async () => {
  const source = resolve(import.meta.dirname, "../..");
  const root = mkdtempSync(join(tmpdir(), "flair-resource-build-"));
  let harper: HarperInstance | undefined;
  try {
    for (const path of ["resources", "schemas", "scripts", "templates", "config.yaml", "package.json", "bun.lock", "tsconfig.json"]) {
      cpSync(join(source, path), join(root, path), { recursive: true });
    }
    mkdirSync(join(root, "packages"));
    cpSync(join(source, "packages/flair-tool-descriptors"), join(root, "packages/flair-tool-descriptors"), { recursive: true });
    symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir");
    const build = spawnSync("bun", ["run", "build"], { cwd: root, encoding: "utf-8", timeout: 90_000 });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    expect(existsSync(join(root, ".git"))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "dist/build-info.json"), "utf-8")).commit).toBeNull();
    expect(existsSync(join(root, "dist/cli.js"))).toBe(false);
    expect(() => assertFlairDistFresh(root)).not.toThrow();
    harper = await startHarper({ cwd: root });
    expect(harper.external).toBe(false);
    expect((await fetch(`${harper.httpURL}/Health`)).ok).toBe(true);
    const newer = new Date(Date.now() + 60_000);
    utimesSync(join(root, "resources/health.ts"), newer, newer);
    expect(() => assertFlairDistFresh(root)).toThrow("bun run build");
  } finally {
    try {
      if (harper) await stopHarper(harper);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 300_000);
