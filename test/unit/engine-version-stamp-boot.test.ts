import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ENGINE_VERSION_STAMP, readEngineVersionStamp, readInstalledHarperVersion } from "../../src/engine-version.ts";
import { flairDataDir } from "../../src/lib/flair-paths.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("compiled boot module stamps the HOME data directory with the installed engine", () => {
  const root = join(import.meta.dir, "../..");
  const home = tempDir("flair-engine-boot-");
  const dir = flairDataDir(home);
  mkdirSync(dir, { recursive: true });
  const moduleUrl = pathToFileURL(join(root, "dist/resources/engine-version-stamp-boot.js")).href;
  const result = spawnSync("node", ["--input-type=module", "-e",
    "const { stampEngineVersionOnBoot } = await import(process.argv[1]); stampEngineVersionOnBoot(process.argv[2]);",
    moduleUrl, join(home, "missing"),
  ], { encoding: "utf8", timeout: 10_000, env: { ...process.env, HOME: home, USERPROFILE: home } });
  expect(result.status, result.stderr).toBe(0);
  const version = readInstalledHarperVersion(root);
  expect(version).not.toBeNull();
  expect(readEngineVersionStamp(dir)).toBe(version);
  expect(readFileSync(join(dir, ENGINE_VERSION_STAMP), "utf8")).toBe(`${version}\n`);
  expect(existsSync(join(home, "missing"))).toBe(false);
}, 15_000);
