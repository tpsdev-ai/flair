/**
 * key-mode-warning-3077.test.ts — flair#3077 slice D.
 *
 * `flair doctor` and `flair status` warn when an agent key file is wider than
 * owner-only in the standard `resolveKeyPath` locations: the path, its octal
 * mode and the exact remedy `chmod 600 <path>`. Explicit key paths (such as
 * `--key`) are outside this scan.
 * A group bit alone (0640) is enough. A symlinked key is reported as not
 * checked and its target is not read for a mode. Neither command changes a
 * key file's bytes or mode.
 *
 * Cases run the source CLI on a throwaway HOME with fixture health responses.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childOverranDeadline } from "../helpers/child-deadline.js";
import { agentKeyLocations, scanAgentKeyModes } from "../../src/lib/key-dir.js";
import { resolveKeyPath } from "../../src/lib/auth-resolve.js";
import { isValidAgentId } from "../../src/lib/agent-id-rule.js";
import { withHome } from "../../src/lib/home.js";

const CLI = join(__dirname, "..", "..", "src", "cli.ts");
// The child's own deadline and the per-case budget above it are written inline
// as literals because the spawn-budget gate reads the call text, not a constant.
const POSIX_ONLY = process.platform === "win32";

let scratch: string;
const url = "http://127.0.0.1:19999";

function makeHome(name: string): string {
  const home = join(scratch, name);
  mkdirSync(join(home, ".flair", "keys"), { recursive: true });
  return home;
}

function writeKey(home: string, id: string, mode: number): string {
  const path = join(home, ".flair", "keys", `${id}.key`);
  writeFileSync(path, `seed-${id}-3077`);
  chmodSync(path, mode);
  return path;
}

/** Async on purpose: the mock instance answers on this process's event loop. */
function runCli(
  args: string[],
  home: string,
  windows = false,
  extraEnv: Record<string, string> = {},
): Promise<{ output: string; status: number | null }> {
  const preload = join(home, "health-fixture.cjs");
  writeFileSync(preload, `${windows ? 'Object.defineProperty(process, "platform", { value: "win32" });' : ""}
    globalThis.fetch = async (input) => {
      const target = String(input);
      if ((target.startsWith(${JSON.stringify(url)}) || target.startsWith("https://remote.example")) && /\\/Health(?:Detail)?$/.test(target)) {
        return new Response(JSON.stringify({ ok: true, version: "0.0.0", pid: 1, uptimeSeconds: 1, warnings: [],
          agents: { total: 1, names: ["agent-a"], perAgent: [{ id: "agent-a", memoryCount: 0 }] } }),
          { headers: { "Content-Type": "application/json" } });
      }
      throw new Error("offline fixture");
    };
  `);
  const startedAt = Date.now();
  const child = spawn("bun", ["--preload", preload, CLI, ...args], {
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", TERM: "dumb", TMPDIR: tmpdir(), ...extraEnv },
    timeout: 30_000,
    killSignal: "SIGTERM",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    child.on("error", (error) => reject(error));
    child.on("close", (status, signal) => {
      const elapsedMs = Date.now() - startedAt;
      if (status === null && elapsedMs >= 30_000) {
        reject(new Error(childOverranDeadline("flair CLI", args.join(" "), 30_000, {
          status,
          signal,
          stdout,
          stderr,
          elapsedMs,
          timeoutSignal: "SIGTERM",
        })));
        return;
      }
      resolve({ output: `${stdout}${stderr}`, status });
    });
  });
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "flair-3077-key-mode-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  mock.restore();
});

describe("agent key file modes are reported by doctor and status", () => {
  test.skipIf(POSIX_ONLY)("doctor warns on 0644 and 0640, stays silent on 0600, and does not follow a symlink", async () => {
    const home = makeHome("doctor");
    const wide = writeKey(home, "agent-a", 0o644);
    const group = writeKey(home, "agent-c", 0o640);
    const narrow = writeKey(home, "agent-b", 0o600);
    const link = join(home, ".flair", "keys", "agent-link.key");
    symlinkSync(narrow, link);

    const { output } = await runCli(["doctor"], home);

    expect(output).toContain(`agent key file ${wide} has mode 0644`);
    expect(output).toContain(`chmod 600 ${wide}`);
    expect(output).toContain(`agent key file ${group} has mode 0640`);
    expect(output).toContain(`chmod 600 ${group}`);
    expect(output).toContain(`agent key file ${link} not checked (symbolic link)`);
    expect(output).not.toContain(`agent key file ${narrow}`);

    expect(readFileSync(wide, "utf8")).toBe("seed-agent-a-3077");
    expect(readFileSync(narrow, "utf8")).toBe("seed-agent-b-3077");
    expect(readFileSync(group, "utf8")).toBe("seed-agent-c-3077");
    expect(readlinkSync(link)).toBe(narrow);
    expect(statSync(wide).mode & 0o777).toBe(0o644);
    expect(statSync(narrow).mode & 0o777).toBe(0o600);
    expect(statSync(group).mode & 0o777).toBe(0o640);
  }, 60_000);

  test.skipIf(POSIX_ONLY)("status prints the same warnings one line each and leaves the files alone", async () => {
    const home = makeHome("status");
    const wide = writeKey(home, "agent-a", 0o644);
    const group = writeKey(home, "agent-c", 0o640);
    const narrow = writeKey(home, "agent-b", 0o600);
    const link = join(home, ".flair", "keys", "agent-link.key");
    symlinkSync(narrow, link);

    const { output, status } = await runCli(["status", "--url", url], home);

    expect(status).toBe(0);
    expect(output).toContain(`agent key file ${wide} has mode 0644`);
    expect(output).toContain(`chmod 600 ${wide}`);
    expect(output).toContain(`agent key file ${group} has mode 0640`);
    expect(output).toContain(`chmod 600 ${group}`);
    expect(output).toContain(`agent key file ${link} not checked (symbolic link)`);
    expect(output).not.toContain(`agent key file ${narrow}`);

    expect(readFileSync(wide, "utf8")).toBe("seed-agent-a-3077");
    expect(readFileSync(narrow, "utf8")).toBe("seed-agent-b-3077");
    expect(readFileSync(group, "utf8")).toBe("seed-agent-c-3077");
    expect(statSync(wide).mode & 0o777).toBe(0o644);
    expect(statSync(narrow).mode & 0o777).toBe(0o600);
    expect(statSync(group).mode & 0o777).toBe(0o640);
  }, 60_000);

  test.skipIf(POSIX_ONLY)("doctor says nothing about a 0600 key", async () => {
    const home = makeHome("doctor-0600");
    writeKey(home, "agent-a", 0o600);

    const { output } = await runCli(["doctor"], home);

    expect(output).not.toContain("agent key file");
  }, 60_000);

  test.skipIf(POSIX_ONLY)("status says nothing about a 0600 key", async () => {
    const home = makeHome("status-0600");
    writeKey(home, "agent-a", 0o600);

    const { output, status } = await runCli(["status", "--url", url], home);

    expect(status).toBe(0);
    expect(output).not.toContain("agent key file");
  }, 60_000);
});


test.skipIf(POSIX_ONLY)("a node-shaped id and a name outside the Agent ID rule both warn in doctor and status", async () => {
  const home = makeHome("node-shaped");
  const key = writeKey(home, "flair_deadbeef", 0o644);
  const invalid = writeKey(home, "invalid.id", 0o644);
  for (const args of [["doctor"], ["status", "--url", url]]) {
    const { output } = await runCli(args, home);
    expect(output).toContain(`agent key file ${key} has mode 0644`);
    expect(output).toContain(`agent key file ${invalid} has mode 0644`);
  }
}, 60_000);

test.skipIf(POSIX_ONLY)("status retains host warnings with an agent filter and in deep output", async () => {
  const home = makeHome("agent-filter");
  const key = writeKey(home, "agent-a", 0o644);
  for (const args of [["status", "--url", url, "--agent", "agent-a"], ["status", "--url", url, "deep"]]) {
    const { output, status } = await runCli(args, home);
    expect(status).toBe(0);
    expect(output).toContain(`agent key file ${key} has mode 0644`);
  }
}, 60_000);

test.skipIf(POSIX_ONLY)("unreachable local status renders host warnings in plain and deep output", async () => {
  const home = makeHome("unreachable");
  const key = writeKey(home, "agent-a", 0o644);
  for (const tail of [[], ["deep"], ["--json"], ["--json", "deep"]]) {
    const { output, status } = await runCli(["status", "--url", "http://127.0.0.1:9", ...tail], home);
    expect(status).toBe(1);
    if (tail.includes("--json")) expect(JSON.parse(output).healthy).toBe(false);
    else expect(output).toContain("unreachable");
    expect(output).toContain(`agent key file ${key} has mode 0644`);
  }
}, 120_000);

test.skipIf(POSIX_ONLY)("doctor issue count increases by its mode findings", async () => {
  const home = makeHome("issue-count");
  const a = writeKey(home, "agent-a", 0o600);
  const b = writeKey(home, "agent-b", 0o600);
  const before = await runCli(["doctor"], home);
  chmodSync(a, 0o644);
  chmodSync(b, 0o640);
  symlinkSync(a, join(home, ".flair", "keys", "agent-link.key"));
  mkdirSync(join(home, ".flair", "keys", "agent-dir.key"));
  const after = await runCli(["doctor"], home);
  const count = (output: string) => {
    const match = output.match(/(\d+) issues? found/);
    expect(match).not.toBeNull();
    return Number(match![1]);
  };
  expect(count(after.output) - count(before.output)).toBe(4);
}, 60_000);

test.skipIf(POSIX_ONLY)("a non-directory keys path is named by doctor and status", async () => {
  const home = makeHome("not-directory");
  const keys = join(home, ".flair", "keys");
  rmSync(keys, { recursive: true });
  writeFileSync(keys, "not a directory");
  const doctor = await runCli(["doctor"], home);
  expect(doctor.output).toContain(`Keys directory could not be read: ${keys} — key checks skipped`);
  for (const tail of [[], ["deep"]]) {
    const { output } = await runCli(["status", "--url", url, ...tail], home);
    expect(output).toContain(`agent key directory ${keys} could not be read (ENOTDIR) — key file modes not checked`);
  }
}, 90_000);

test.skipIf(POSIX_ONLY)("doctor reports an unreadable keys path once when FLAIR_KEY_DIR is a symlink to it", async () => {
  const home = makeHome("alias-unreadable");
  const keys = join(home, ".flair", "keys");
  rmSync(keys, { recursive: true });
  writeFileSync(keys, "not a directory");
  const alias = join(home, "keys-alias");
  symlinkSync(keys, alias);
  const { output } = await runCli(["doctor"], home, false, { FLAIR_KEY_DIR: alias });
  expect(output.split(`Keys directory could not be read: ${keys}`)).toHaveLength(2);
  expect(output).not.toContain(`agent key directory ${alias} could not be read`);
}, 60_000);

test.skipIf(POSIX_ONLY)("remote status omits local key warnings in plain and deep output", async () => {
  const home = makeHome("remote");
  const key = writeKey(home, "agent-a", 0o644);
  for (const tail of [[], ["deep"]]) {
    const { output, status } = await runCli(["status", "--url", "https://remote.example", ...tail], home);
    expect(status).toBe(0);
    expect(output).not.toContain(key);
    expect(output).not.toContain("agent key file");
  }
}, 60_000);

test("Windows mode notice appears with readable, absent and unreadable key directories", async () => {
  for (const state of ["readable", "absent", "unreadable"]) {
    const home = makeHome(`windows-${state}`);
    const keys = join(home, ".flair", "keys");
    if (state !== "readable") rmSync(keys, { recursive: true });
    if (state === "unreadable") writeFileSync(keys, "not a directory");
    for (const args of [["doctor"], ["status", "--url", url]]) {
      const { output } = await runCli(args, home, true);
      expect(output.split("key file modes are not checked on Windows")).toHaveLength(2);
    }
  }
}, 210_000);

test.skipIf(POSIX_ONLY)("key directories are not checked and a symlinked keys directory is read", async () => {
  const home = makeHome("directory-link");
  const keys = join(home, ".flair", "keys");
  const key = writeKey(home, "agent-a", 0o644);
  const dirKey = join(keys, "agent-dir.key");
  mkdirSync(dirKey);
  const linkedHome = makeHome("linked-home");
  const linkedKeys = join(linkedHome, ".flair", "keys");
  rmSync(linkedKeys, { recursive: true });
  symlinkSync(keys, linkedKeys);
  for (const args of [["doctor"], ["status", "--url", url]]) {
    const direct = await runCli(args, home);
    expect(direct.output).toContain(`agent key file ${dirKey} not checked (not a regular file)`);
    const linked = await runCli(args, linkedHome);
    expect(linked.output).toContain(`agent key file ${join(linkedKeys, "agent-a.key")} has mode 0644`);
  }
  expect(readFileSync(key, "utf8")).toBe("seed-agent-a-3077");
}, 120_000);

test.skipIf(POSIX_ONLY)("a wide key in FLAIR_KEY_DIR is warned by doctor and status", async () => {
  const home = makeHome("env-dir");
  const envKeys = join(scratch, "env-keys");
  mkdirSync(envKeys);
  const key = join(envKeys, "agent-a.key");
  writeFileSync(key, "seed-agent-a-3077");
  chmodSync(key, 0o644);
  for (const args of [["doctor"], ["status", "--url", url]]) {
    const { output } = await runCli(args, home, false, { FLAIR_KEY_DIR: envKeys });
    expect(output).toContain(`agent key file ${key} has mode 0644`);
  }
}, 60_000);

test.skipIf(POSIX_ONLY)("a wide key in the legacy directory is warned by doctor and status", async () => {
  const home = makeHome("legacy-dir");
  const legacyKeys = join(home, ".tps", "secrets", "flair");
  mkdirSync(legacyKeys, { recursive: true });
  const key = join(legacyKeys, "agent-a-priv.key");
  writeFileSync(key, "seed-agent-a-3077");
  chmodSync(key, 0o644);
  for (const args of [["doctor"], ["status", "--url", url]]) {
    const { output } = await runCli(args, home);
    expect(output).toContain(`agent key file ${key} has mode 0644`);
  }
}, 60_000);

test.skipIf(POSIX_ONLY)("overlapping legacy and environment directories keep the legacy filename pattern", async () => {
  const home = makeHome("overlapping-legacy");
  const legacyKeys = join(home, ".tps", "secrets", "flair");
  mkdirSync(legacyKeys, { recursive: true });
  const id = "a".repeat(60);
  expect(isValidAgentId(id)).toBe(true);
  expect(isValidAgentId(`${id}-priv`)).toBe(false);
  const key = join(legacyKeys, `${id}-priv.key`);
  writeFileSync(key, "seed-overlapping-3077");
  chmodSync(key, 0o644);
  const previousKeyDir = process.env.FLAIR_KEY_DIR;
  try {
    process.env.FLAIR_KEY_DIR = legacyKeys;
    expect(withHome(home, () => resolveKeyPath(id))).toBe(key);
  } finally {
    if (previousKeyDir === undefined) delete process.env.FLAIR_KEY_DIR;
    else process.env.FLAIR_KEY_DIR = previousKeyDir;
  }
  for (const args of [["doctor"], ["status", "--url", url]]) {
    const { output } = await runCli(args, home, false, { FLAIR_KEY_DIR: legacyKeys });
    expect(output).toContain(`agent key file ${key} has mode 0644`);
    expect(output).toContain(`chmod 600 ${key}`);
  }
}, 60_000);

test.skipIf(POSIX_ONLY)("a key reached through FLAIR_KEY_DIR and the default directory is reported once", async () => {
  const home = makeHome("dedupe");
  const keys = join(home, ".flair", "keys");
  const key = writeKey(home, "agent-a", 0o644);
  for (const args of [["doctor"], ["status", "--url", url]]) {
    const { output } = await runCli(args, home, false, { FLAIR_KEY_DIR: keys });
    expect(output.split(`agent key file ${key} has mode 0644`)).toHaveLength(2);
  }
}, 60_000);

describe("the mode scan's location results", () => {
  test("an absent location is silent", () => {
    const root = mkdtempSync(join(scratch, "absent-"));
    const scan = scanAgentKeyModes([
      { dir: join(root, "no-such-keys"), suffix: ".key" },
      { dir: join(root, "no-such-legacy"), suffix: "-priv.key" },
    ]);
    expect(scan.unreadable).toEqual([]);
    expect(scan.findings).toEqual([]);
  });

  test("an unreadable directory listed under two locations is reported once", () => {
    const root = mkdtempSync(join(scratch, "dup-unreadable-"));
    const notADir = join(root, "keys");
    writeFileSync(notADir, "not a directory");
    const scan = scanAgentKeyModes([
      { dir: notADir, suffix: ".key" },
      { dir: notADir, suffix: "-priv.key" },
    ]);
    expect(scan.unreadable).toHaveLength(1);
    expect(scan.unreadable[0].dir).toBe(notADir);
  });
});

describe("the mode scan reads no key contents", () => {
  test.skipIf(POSIX_ONLY)("scanAgentKeyModes lstats keys in its standard locations without opening or reading them", () => {
    const home = makeHome("no-read");
    const key = writeKey(home, "agent-a", 0o644);
    const envKeys = join(home, "env-keys");
    const legacyKeys = join(home, ".tps", "secrets", "flair");
    mkdirSync(envKeys);
    mkdirSync(legacyKeys, { recursive: true });
    const envKey = join(envKeys, "agent-env.key");
    const legacyKey = join(legacyKeys, "agent-legacy-priv.key");
    for (const path of [envKey, legacyKey]) {
      writeFileSync(path, "seed-no-read-3077");
      chmodSync(path, 0o644);
    }
    const keyPaths = [envKey, key, legacyKey];
    const touched: string[] = [];
    const guard = (name: string, original: (...args: any[]) => any) => (...args: any[]) => {
      if (keyPaths.includes(String(args[0]))) {
        touched.push(name);
        throw new Error(`${name} touched a key file`);
      }
      return original(...args);
    };
    spyOn(fs, "readFileSync").mockImplementation(guard("readFileSync", fs.readFileSync));
    spyOn(fs, "openSync").mockImplementation(guard("openSync", fs.openSync));
    spyOn(fs, "createReadStream").mockImplementation(guard("createReadStream", fs.createReadStream));
    spyOn(fs.promises, "readFile").mockImplementation(guard("promises.readFile", fs.promises.readFile));
    spyOn(fs.promises, "open").mockImplementation(guard("promises.open", fs.promises.open));

    const previousKeyDir = process.env.FLAIR_KEY_DIR;
    try {
      process.env.FLAIR_KEY_DIR = envKeys;
      const scan = withHome(home, () => scanAgentKeyModes());
      expect(withHome(home, () => agentKeyLocations()).map(({ dir }) => dir)).toEqual([envKeys, join(home, ".flair", "keys"), legacyKeys]);
      expect(scan.unreadable).toEqual([]);
      expect(scan.findings).toEqual(keyPaths.map((path) => ({ kind: "wide", path, mode: "0644" })));
    } finally {
      if (previousKeyDir === undefined) delete process.env.FLAIR_KEY_DIR;
      else process.env.FLAIR_KEY_DIR = previousKeyDir;
    }
    expect(touched).toEqual([]);
  });
});

test.skipIf(POSIX_ONLY)("doctor and status never print key contents", async () => {
  const home = makeHome("no-read-output");
  const key = join(home, ".flair", "keys", "agent-a.key");
  writeFileSync(key, "SENTINEL-CONTENT-3077");
  chmodSync(key, 0o644);
  for (const args of [["doctor"], ["status", "--url", url]]) {
    const { output } = await runCli(args, home);
    expect(output).toContain(`agent key file ${key} has mode 0644`);
    expect(output).not.toContain("SENTINEL-CONTENT-3077");
  }
}, 60_000);

test.skipIf(POSIX_ONLY)("the printed chmod remedy runs for a path with a space and a quote", async () => {
  const home = join(scratch, "home with space");
  mkdirSync(join(home, ".flair", "keys"), { recursive: true });
  const envKeys = join(home, "keys'quoted");
  mkdirSync(envKeys);
  const key = join(envKeys, "agent-a.key");
  writeFileSync(key, "seed-agent-a-3077");
  chmodSync(key, 0o644);
  const { output } = await runCli(["status", "--url", url], home, false, { FLAIR_KEY_DIR: envKeys });
  expect(output).toContain(`agent key file ${key} has mode 0644`);
  const match = output.match(/chmod 600 [^\n]*/);
  expect(match).not.toBeNull();
  const command = match![0].replace(/\u001b\[[0-9;]*m/g, "").trim();
  expect(command).not.toBe(`chmod 600 ${key}`);
  const remedy = spawnSync("sh", ["-c", 'eval "$FLAIR_KEY_MODE_REMEDY_3077"'], {
    cwd: scratch,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      FLAIR_KEY_MODE_REMEDY_3077: command,
      FLAIR_TEST_ALLOW_BUN_HARPER: "Exercise the printed key-mode chmod remedy through the POSIX shell",
    },
  });
  expect(remedy.stderr).toBe("");
  expect(remedy.status).toBe(0);
  expect(statSync(key).mode & 0o777).toBe(0o600);
}, 60_000);
