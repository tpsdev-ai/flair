import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  ], { encoding: "utf8", timeout: 10_000, env: { ...process.env, HOME: home, USERPROFILE: home, ROOTPATH: "" } });
  expect(result.status, result.stderr).toBe(0);
  const version = readInstalledHarperVersion(root);
  expect(version).not.toBeNull();
  expect(readEngineVersionStamp(dir)).toBe(version);
  expect(readFileSync(join(dir, ENGINE_VERSION_STAMP), "utf8")).toBe(`${version}\n`);
  expect(existsSync(join(home, "missing"))).toBe(false);
}, 15_000);


test("compiled boot module stamps ROOTPATH and leaves the HOME store unchanged", () => {
  const root = join(import.meta.dir, "../..");
  const home = tempDir("flair-engine-home-");
  const active = tempDir("flair-engine-active-");
  const dir = flairDataDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ENGINE_VERSION_STAMP), "5.2.8\n");
  const moduleUrl = pathToFileURL(join(root, "dist/resources/engine-version-stamp-boot.js")).href;
  const result = spawnSync("node", ["--input-type=module", "-e", "await import(process.argv[1]);", moduleUrl], {
    encoding: "utf8", timeout: 10_000, env: { ...process.env, HOME: home, USERPROFILE: home, ROOTPATH: active },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(readEngineVersionStamp(active)).toBe(readInstalledHarperVersion(root));
  expect(readEngineVersionStamp(dir)).toBe("5.2.8");
}, 15_000);

for (const writer of ["boot", "cli"]) {
  for (const failSync of [false, true]) {
    test(`${writer} stamp replacement ${failSync ? "retains the old stamp on fsync failure" : "keeps the old stamp readable until rename"}`, () => {
      const root = join(import.meta.dir, "../..");
      const dir = tempDir("flair-engine-atomic-");
      writeFileSync(join(dir, ENGINE_VERSION_STAMP), "5.2.8\n");
      const result = spawnSync("node", ["--input-type=module", "-e", `
        import fs from 'node:fs';
        import assert from 'node:assert/strict';
        import { syncBuiltinESMExports } from 'node:module';
        import { dirname, join } from 'node:path';
        const [root, dir, writer, failSync, version] = process.argv.slice(1);
        const stamp = join(dir, 'engine-version.txt');
        const write = fs.writeFileSync, sync = fs.fsyncSync, rename = fs.renameSync;
        let synced = false, renamed = false, wrote = false;
        fs.writeFileSync = (target, ...args) => {
          assert.notEqual(target, stamp);
          assert.equal(fs.readFileSync(stamp, 'utf8'), '5.2.8\\n');
          const result = write(target, ...args);
          assert.equal(fs.readFileSync(stamp, 'utf8'), '5.2.8\\n');
          wrote = true;
          return result;
        };
        fs.fsyncSync = fd => {
          assert.equal(wrote, true);
          if (failSync === 'true') throw new Error('injected fsync failure');
          sync(fd); synced = true;
        };
        fs.renameSync = (from, to) => {
          assert.equal(dirname(from), dir);
          assert.equal(to, stamp);
          assert.equal(synced, true);
          assert.equal(fs.readFileSync(stamp, 'utf8'), '5.2.8\\n');
          rename(from, to); renamed = true;
        };
        syncBuiltinESMExports();
        const module = await import(root + (writer === 'boot' ? '/dist/resources/engine-version-stamp-boot.js' : '/dist/engine-version.js'));
        try {
          if (writer === 'boot') module.stampEngineVersionOnBoot(dir);
          else module.writeEngineVersionStamp(dir, '5.3.1');
        } catch (error) {
          if (failSync !== 'true' || !error.message.includes('injected fsync failure')) throw error;
        }
        assert.equal(wrote, true);
        assert.equal(renamed, failSync !== 'true');
        assert.equal(fs.readFileSync(stamp, 'utf8'), failSync === 'true' ? '5.2.8\\n' : version + '\\n');
        assert.deepEqual(fs.readdirSync(dir), ['engine-version.txt']);
      `, root, dir, writer, String(failSync), writer === "boot" ? readInstalledHarperVersion(root)! : "5.3.1"], {
        encoding: "utf8", timeout: 10_000, env: { ...process.env, ROOTPATH: join(dir, "missing") },
      });
      expect(result.status, result.stderr).toBe(0);
    }, 15_000);
  }
}
