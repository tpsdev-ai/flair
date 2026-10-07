import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "../helpers/temp-dir.ts";
import { offlineDoctor } from "../helpers/offline-doctor.ts";
import { detectPersistedAdminUser, resolveInitAdminPasswordSource } from "../../src/lib/init-admin-pass.ts";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;
const sources = ["inline", "file", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD"] as const;
const password = "fixture-explicit-admin-password";

/** Mark `dataDir` as an already-installed instance so an `init --skip-start`
 * fixture does not run Harper's installer (flair#2197). These cases exercise the
 * admin-credential decision, not installation, and the installer needs Node —
 * not this bun-hosted, offline, umask-varying fixture. */
function markInstalled(dataDir: string): void {
  writeFileSync(join(dataDir, "harper-config.yaml"), `rootPath: ${dataDir}\n`);
}

function runInit(home: string, dataDir: string, source: typeof sources[number], platform: string, foreignOwner = false, options: { umask?: number; columns?: string; agent?: string } = {}) {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(FLAIR_|HARPER_|HDB_|FABRIC_|TPS_TEST_ROOT$|ROOTPATH$)/.test(key),
  ));
  Object.assign(env, { HOME: home, USERPROFILE: home, NO_COLOR: "1" });
  const args = ["init", "--data-dir", dataDir, "--port", "9", "--ops-port", "8",
    "--skip-start", "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md"];
  if (options.agent) args.push("--agent", options.agent);
  if (source === "inline") args.push("--admin-pass", password);
  else if (source === "file") {
    const input = join(home, "input-pass");
    writeFileSync(input, password + "\n", { mode: 0o600 });
    args.push("--admin-pass-file", input);
  } else env[source] = password;
  const script = `
    Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
    globalThis.fetch = async () => {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(${JSON.stringify(join(home, "requests.jsonl"))}, "request\\n");
      throw new Error("offline fixture");
    };
    const socketLimitPath = ${JSON.stringify(new URL("../../src/lib/socket-path-limit.ts", import.meta.url).href)};
    const socketLimit = await import(socketLimitPath);
    const { mock: mockSocketLimit } = await import("bun:test");
    mockSocketLimit.module(socketLimitPath, () => ({ ...socketLimit, opsSocketPathRefusal: () => null }));
    ${options.umask === undefined ? "" : `process.umask(${options.umask});`}
    ${options.columns === undefined ? "" : `
      const { createRequire } = await import("node:module");
      const here = createRequire(${JSON.stringify(CLI)});
      const { mock } = await import("bun:test");
      mock.module(createRequire(here.resolve("harper")).resolve("@harperfast/rocksdb-js"), () => ({
        RocksDatabase: { open: () => ({ columns: ${options.columns}, close() {} }) },
      }));
    `}
    const { program } = await import(${JSON.stringify(CLI)});
    ${foreignOwner ? "const uid = process.getuid(); process.getuid = () => uid + 1;" : ""}
    await program.parseAsync(${JSON.stringify(args)}, { from: "user" });
  `;
  return spawnSync(process.execPath, ["-e", script], {
    cwd: home, env, encoding: "utf8", timeout: 20_000,
  });
}

describe("fresh init persists explicit admin credentials", () => {
  test("fresh explicit credentials use the existing re-persist decision", () => {
    expect(resolveInitAdminPasswordSource(false, { explicitCredential: true })).toBe("re-persist");
    expect(resolveInitAdminPasswordSource(false)).toBe("generate-new");
    expect(resolveInitAdminPasswordSource(true, { explicitCredential: true })).toBe("reuse-existing");
    expect(resolveInitAdminPasswordSource(false, { explicitCredential: true, resetRequested: true })).toBe("rotate");
  });

  for (const platform of ["linux", "darwin"]) {
    for (const source of sources) {
      test(`${platform}: ${source} writes 0600 and doctor reports no desync`, () => {
        const home = tempDir("i-");
        const dataDir = tempDir("d-");
        const passPath = join(home, ".flair", "admin-pass");
        mkdirSync(join(home, ".flair"));
        symlinkSync(dataDir, join(home, ".flair", "data"));
        markInstalled(dataDir);
        expect(detectPersistedAdminUser(dataDir)).toBe(false);
        const result = runInit(home, dataDir, source, platform);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(existsSync(passPath)).toBe(true);
        expect(readFileSync(passPath, "utf8")).toBe(password + "\n");
        expect(statSync(passPath).mode & 0o777).toBe(0o600);
        mkdirSync(join(dataDir, "system"));
        writeFileSync(join(dataDir, "system", "hdb_user.mdb"), "fixture-user");
        expect(realpathSync(join(home, ".flair", "data"))).toBe(realpathSync(dataDir));
        expect(detectPersistedAdminUser(dataDir)).toBe(true);
        const doctor = offlineDoctor(home, null);
        const output = doctor();
        expect(output).not.toContain("admin-pass file missing");
        expect(output).not.toContain("not assessing the admin-pass desync");
        rmSync(passPath);
        expect(doctor()).toContain("admin-pass file missing; Harper still has a persisted admin user");
      }, 60_000);
    }
  }

  for (const source of sources) {
    for (const persisted of [false, true]) {
      test(`${source}: stopped skip-start reuses identical saved bytes, persisted=${persisted}`, () => {
        const home = tempDir("i-");
        const dataDir = tempDir("d-");
        const passPath = join(home, ".flair", "admin-pass");
        mkdirSync(join(home, ".flair"));
        markInstalled(dataDir);
        if (persisted) {
          mkdirSync(join(dataDir, "system"));
          writeFileSync(join(dataDir, "system", "hdb_user.mdb"), "fixture-user");
        }
        writeFileSync(passPath, password + "\n\n", { mode: 0o600 });
        const before = readFileSync(passPath);
        const beforeStat = statSync(passPath);
        const result = runInit(home, dataDir, source, "linux", false, { agent: "config-only" });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(readFileSync(passPath)).toEqual(before);
        expect(statSync(passPath).ino).toBe(beforeStat.ino);
        expect(statSync(passPath).mtimeMs).toBe(beforeStat.mtimeMs);
        expect(existsSync(join(home, "requests.jsonl"))).toBe(false);
        expect(existsSync(join(home, ".flair", "keys", "config-only.key"))).toBe(true);
        expect(result.stdout).toContain("Agent registration deferred");
        expect(result.stdout).not.toContain("verified");
      });
    }
  }

  for (const posture of ["symlink", "foreign-owner", "open-mode"] as const) {
    test(`identical supplied password refuses a saved ${posture} file`, () => {
      const home = tempDir("i-");
      const dataDir = tempDir("d-");
      const passPath = join(home, ".flair", "admin-pass");
      mkdirSync(join(home, ".flair"));
      const target = posture === "symlink" ? join(home, "target") : passPath;
      writeFileSync(target, password + "\n", { mode: posture === "open-mode" ? 0o644 : 0o600 });
      if (posture === "symlink") symlinkSync(target, passPath);
      const result = runInit(home, dataDir, "inline", "linux", posture === "foreign-owner");
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(posture === "open-mode" ? "too open" : "existing install is stopped");
      expect(readFileSync(target, "utf8")).toBe(password + "\n");
    });
  }

  for (const dangling of [false, true]) {
    test(`refuses a ${dangling ? "dangling " : ""}symlink destination`, () => {
      const home = tempDir("i-");
      const dataDir = tempDir("d-");
      const path = join(home, ".flair", "admin-pass");
      const target = join(home, "target");
      mkdirSync(join(home, ".flair"));
      if (!dangling) writeFileSync(target, "unchanged", { mode: 0o600 });
      symlinkSync(target, path);
      const result = runInit(home, dataDir, "inline", "linux");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(dangling ? "symbolic link" : "existing install is stopped");
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      if (!dangling) expect(readFileSync(target, "utf8")).toBe("unchanged");
      else expect(existsSync(target)).toBe(false);
    });
  }

  test("refuses a foreign-owned destination", () => {
    const home = tempDir("i-");
    const dataDir = tempDir("d-");
    const path = join(home, ".flair", "admin-pass");
    mkdirSync(join(home, ".flair"));
    writeFileSync(path, "unchanged", { mode: 0o600 });
    const result = runInit(home, dataDir, "inline", "linux", true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("existing install is stopped");
    expect(readFileSync(path, "utf8")).toBe("unchanged");
  });
});

describe("admin credential persistence refuses unassessed stores", () => {
  test("inaccessible parent directory refuses init without writing admin-pass", () => {
    expect(process.getuid?.()).not.toBe(0);
    const home = tempDir("i-");
    const dataDir = tempDir("d-");
    const parent = join(dataDir, "database");
    mkdirSync(join(parent, "system"), { recursive: true });
    chmodSync(parent, 0);
    try {
      const result = runInit(home, dataDir, "inline", "linux");
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("Refusing to initialize");
      expect(result.stderr).toContain("EACCES");
      expect(result.stderr).toContain(dataDir);
      expect(existsSync(join(home, ".flair", "admin-pass"))).toBe(false);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  for (const columns of ["undefined", "null", "{}", "'hdb_user/'", "[123]"]) {
    test(`invalid columns metadata ${columns} refuses init without writing admin-pass`, () => {
      const home = tempDir("i-");
      const dataDir = tempDir("d-");
      mkdirSync(join(dataDir, "database", "system"), { recursive: true });
      const result = runInit(home, dataDir, "inline", "linux", false, { columns });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("Refusing to initialize");
      expect(result.stderr).toContain("columns metadata");
      expect(existsSync(join(home, ".flair", "admin-pass"))).toBe(false);
    });
  }

  test("default-only columns refuse init without writing admin-pass", () => {
    const home = tempDir("i-");
    const dataDir = tempDir("d-");
    mkdirSync(join(dataDir, "database", "system"), { recursive: true });
    const result = runInit(home, dataDir, "inline", "linux", false, { columns: "['default']" });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("MISSING_HDB_USER_COLUMN");
    expect(result.stderr).toContain("Repair the system store");
    expect(existsSync(join(home, ".flair", "admin-pass"))).toBe(false);
  });

  test("default-only system store throws and doctor counts an unassessed check", () => {
    const home = tempDir("i-");
    const dataDir = tempDir("d-");
    mkdirSync(join(home, ".flair"));
    symlinkSync(dataDir, join(home, ".flair", "data"));
    const doctor = offlineDoctor(home, null);
    const baseline = doctor();
    const here = createRequire(import.meta.url);
    const rocksPath = createRequire(here.resolve("harper")).resolve("@harperfast/rocksdb-js");
    const { RocksDatabase } = here(rocksPath);
    const systemDir = join(dataDir, "database", "system");
    mkdirSync(systemDir, { recursive: true });
    const db = RocksDatabase.open(systemDir);
    try {
      expect(db.columns).toEqual(["default"]);
    } finally {
      db.close();
    }
    expect(() => detectPersistedAdminUser(dataDir)).toThrow("MISSING_HDB_USER_COLUMN");
    const observed: { status: number | null } = { status: null };
    const output = doctor([], result => { observed.status = result.status; });
    expect(output).toContain("not assessing the admin-pass desync");
    expect(observed.status).toBe(1);
    const issues = (text: string) => Number(/(\d+) issues? found/.exec(text)?.[1]);
    expect(issues(output)).toBe(issues(baseline) + 1);
  });

  test("dangling system-store link is not treated as absent", () => {
    const dataDir = tempDir("d-");
    mkdirSync(join(dataDir, "database"));
    symlinkSync(join(dataDir, "missing"), join(dataDir, "database", "system"));
    expect(() => detectPersistedAdminUser(dataDir)).toThrow();
  });

  test("explicit password has exact 0600 under restrictive umasks", () => {
    for (const umask of [0o077, 0o277]) {
      const home = tempDir("i-");
      const dataDir = tempDir("d-");
      mkdirSync(join(home, ".flair"));
      symlinkSync(dataDir, join(home, ".flair", "data"));
      markInstalled(dataDir);
      const result = runInit(home, dataDir, "inline", "linux", false, { umask });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const path = join(home, ".flair", "admin-pass");
      expect(readFileSync(path, "utf8")).toBe(password + "\n");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  test("doctor counts an unassessed admin-pass check and exits nonzero", () => {
    const home = tempDir("i-");
    const dataDir = tempDir("d-");
    mkdirSync(join(home, ".flair"));
    symlinkSync(dataDir, join(home, ".flair", "data"));
    const doctor = offlineDoctor(home, null);
    const baseline = doctor();
    mkdirSync(join(dataDir, "database", "system"), { recursive: true });
    writeFileSync(join(dataDir, "database", "system", "junk"), "invalid database");
    const observed: { status: number | null } = { status: null };
    const output = doctor([], result => { observed.status = result.status; });
    expect(output).toContain("not assessing the admin-pass desync");
    expect(output).not.toContain("No issues found");
    expect(observed.status).toBe(1);
    const issues = (text: string) => Number(/(\d+) issues? found/.exec(text)?.[1]);
    expect(issues(output)).toBe(issues(baseline) + 1);
  });
});


describe("supplied credentials on stopped installs", () => {
  for (const persisted of [false, true]) {
    for (const fileExists of [false, true]) {
      if (!persisted && !fileExists) continue;
      for (const source of sources) {
        test(`${source}: stopped install, persisted=${persisted}, file=${fileExists}`, () => {
          const home = tempDir("i-");
          const dataDir = tempDir("d-");
          const passPath = join(home, ".flair", "admin-pass");
          mkdirSync(join(home, ".flair"));
          markInstalled(dataDir);
          if (persisted) {
            mkdirSync(join(dataDir, "system"));
            writeFileSync(join(dataDir, "system", "hdb_user.mdb"), "fixture-user");
          }
          const before = Buffer.from([0x73, 0x61, 0x76, 0x65, 0x64, 0x0d, 0x0a, 0xff]);
          if (fileExists) writeFileSync(passPath, before, { mode: 0o600 });
          const result = runInit(home, dataDir, source, "linux");
          expect(result.error).toBeUndefined();
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("Start the instance and re-run");
          expect(result.stderr).toContain("flair init --reset-admin-pass");
          if (fileExists) expect(readFileSync(passPath)).toEqual(before);
          else expect(existsSync(passPath)).toBe(false);
        }, 60_000);
      }
    }
  }
});

test("the supplied-password probe pins admin despite FLAIR_ADMIN_USER", async () => {
  const { proveAdminPassAgainstInstance } = await import("../../src/cli.ts");
  const savedUser = process.env.FLAIR_ADMIN_USER;
  const savedFetch = globalThis.fetch;
  process.env.FLAIR_ADMIN_USER = "alternate-user";
  const seen: Array<{ path: string; user: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    const decoded = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString();
    const [user, pass] = decoded.split(":");
    const path = new URL(String(input)).pathname;
    seen.push({ path, user });
    const accepted = user === "alternate-user" && pass === "fixture-alternate-password"
      || user === "admin" && pass === "fixture-admin-password";
    return Response.json({}, { status: accepted ? 200 : 401 });
  }) as typeof fetch;
  try {
    expect(await proveAdminPassAgainstInstance(20991, "fixture-alternate-password")).not.toBeNull();
    expect(await proveAdminPassAgainstInstance(20991, "fixture-admin-password")).toBeNull();
    expect(seen).toEqual([
      { path: "/FederationPeers", user: "admin" },
      { path: "/FederationPeers", user: "admin" },
    ]);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedUser === undefined) delete process.env.FLAIR_ADMIN_USER;
    else process.env.FLAIR_ADMIN_USER = savedUser;
  }
});
