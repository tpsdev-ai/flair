import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLlamaNative, type InstallRunner } from "../../scripts/ci/install-llama-native.mjs";
import { LOCKFILE, ROOT, readLlamaNativeVersion } from "../../scripts/ci/llama-native-version.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "flair-llama-installer-"));
  dirs.push(dir);
  return realpathSync(dir);
}
function recordingRunner(status = 0) {
  const calls: Parameters<InstallRunner>[] = [];
  const runner: InstallRunner = (...args) => { calls.push(args); return { status }; };
  return { calls, runner };
}
const log = () => {};
const script = join(ROOT, "scripts/ci/install-llama-native.mjs");

describe("install-llama-native", () => {
  test("checkout runs bun with argv, current directory and shell disabled", () => {
    const cwd = fixture();
    const { calls, runner } = recordingRunner();
    const messages: string[] = [];
    const version = readLlamaNativeVersion(readFileSync(LOCKFILE, "utf8"));
    expect(installLlamaNative([], { cwd, runner, log: message => messages.push(message) })).toEqual({
      version, source: LOCKFILE, command: "bun", argv: ["add", "--no-save", `@node-llama-cpp/linux-x64@${version}`], cwd,
    });
    expect(calls).toEqual([["bun", ["add", "--no-save", `@node-llama-cpp/linux-x64@${version}`], { cwd, shell: false, stdio: "inherit" }]]);
    expect(messages.join("\n")).toContain(`version ${version}; source ${LOCKFILE}`);
    expect(messages.join("\n")).toContain(`command "bun" "add" "--no-save" "@node-llama-cpp/linux-x64@${version}"; cwd ${cwd}`);
  });

  test("installed mode runs npm in the selected directory and reports its manifest", () => {
    const cwd = fixture();
    const dir = join(cwd, "installed tree");
    const root = join(dir, "node_modules/@node-llama-cpp/mac-arm64-metal");
    mkdirSync(root, { recursive: true });
    const source = join(root, "package.json");
    writeFileSync(source, JSON.stringify({ name: "@node-llama-cpp/mac-arm64-metal", version: "3.17.2", main: "index.js" }));
    writeFileSync(join(root, "index.js"), "");
    const { calls, runner } = recordingRunner();
    const messages: string[] = [];
    const result = installLlamaNative(["--installed", "installed tree", "--platform", "mac-arm64-metal"], {
      cwd, runner, log: message => messages.push(message),
    });
    expect(result).toEqual({ version: "3.17.2", source, command: "npm", argv: ["install", "--no-save", "@node-llama-cpp/mac-arm64-metal@3.17.2"], cwd: dir });
    expect(calls).toEqual([["npm", ["install", "--no-save", "@node-llama-cpp/mac-arm64-metal@3.17.2"], { cwd: dir, shell: false, stdio: "inherit" }]]);
    expect(messages.join("\n")).toContain(`version 3.17.2; source ${source}`);
    expect(messages.join("\n")).toContain(`command "npm" "install" "--no-save" "@node-llama-cpp/mac-arm64-metal@3.17.2"; cwd ${dir}`);
  });

  for (const version of ["3", "3.22.3-beta", "3.22.3;echo bad", "3.22.3\n"]) {
    test(`refuses malformed version ${JSON.stringify(version)} before running`, () => {
      const lockfile = join(fixture(), "bun.lock");
      writeFileSync(lockfile, `"node-llama-cpp": ["node-llama-cpp@${version}"]`);
      const { calls, runner } = recordingRunner();
      expect(() => installLlamaNative([], { runner, log, lockfile })).toThrow(/install-llama-native:.*not x.y.z/s);
      expect(calls).toEqual([]);
    });
  }

  for (const args of [["--platform", "../linux-x64"], ["--platform", "Linux-x64"], ["--unknown"], ["--installed"], ["--platform"]]) {
    test(`refuses arguments ${JSON.stringify(args)} before running`, () => {
      const { calls, runner } = recordingRunner();
      expect(() => installLlamaNative(args, { runner, log })).toThrow(/install-llama-native:/);
      expect(calls).toEqual([]);
      const result = spawnSync("node", [script, ...args], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("install-llama-native:");
    });
  }

  test("missing lockfile refuses before running", () => {
    const { calls, runner } = recordingRunner();
    expect(() => installLlamaNative([], { runner, log, lockfile: join(fixture(), "missing.lock") })).toThrow(/install-llama-native:/);
    expect(calls).toEqual([]);
  });

  test("malformed installed version refuses before running", () => {
    const dir = fixture();
    const root = join(dir, "node_modules/node-llama-cpp");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "node-llama-cpp", version: "3", main: "index.js" }));
    writeFileSync(join(root, "index.js"), "");
    const { calls, runner } = recordingRunner();
    expect(() => installLlamaNative(["--installed", dir], { runner, log })).toThrow(/install-llama-native: llama-installed-version:.*not x.y.z/);
    expect(calls).toEqual([]);
  });

  test("lookup failure refuses before running", () => {
    const dir = fixture();
    const { calls, runner } = recordingRunner();
    expect(() => installLlamaNative(["--installed", dir], { runner, log })).toThrow(/install-llama-native: llama-installed-version:/);
    expect(calls).toEqual([]);
  });

  test("nonzero runner exit fails after one attempt", () => {
    const { calls, runner } = recordingRunner(7);
    expect(() => installLlamaNative([], { runner, log })).toThrow(/install-llama-native: bun install failed: exit 7/);
    expect(calls).toHaveLength(1);
    const result = spawnSync("node", ["--input-type=module", "-e", `
      import { installLlamaNative } from ${JSON.stringify(script)};
      installLlamaNative([], { runner: () => ({ status: 7 }), log: () => {} });
    `], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("install-llama-native: bun install failed: exit 7");
  });

  test("runner launch error fails after one attempt", () => {
    let calls = 0;
    expect(() => installLlamaNative([], { log, runner: () => {
      calls++;
      return { status: null, error: new Error("missing executable") };
    } })).toThrow(/install-llama-native: missing executable/);
    expect(calls).toBe(1);
  });
});
