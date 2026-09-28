/**
 * Exercises the real upgrade command and real snapshot/rename/extract I/O.
 * Only HTTP transport, package installation, and daemon lifecycle are mocked;
 * no listener or installed service is needed. Run in its own Bun process.
 */
import { describe, test, expect, mock, spyOn, afterAll, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DaemonEvidence } from "../../src/lib/daemon-liveness.ts";
import * as snapshotExtract from "../../src/lib/safe-snapshot-extract.ts";
import * as plainTree from "../../src/lib/upgrade-plain-tree.ts";

setDefaultTimeout(30_000);
const TEST_HOME = mkdtempSync(join(tmpdir(), "flair-rollback-retain-"));
const SAVED_ENV = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (/^(FLAIR_|HARPER_|HDB_|FABRIC_|npm_config_)/i.test(key) || key === "ROOTPATH") delete process.env[key];
}
process.env.HOME = TEST_HOME;
process.env.npm_config_registry = "https://registry.npmjs.org";
process.env.npm_config_userconfig = join(TEST_HOME, "user-npmrc");
process.env.npm_config_globalconfig = join(TEST_HOME, "global-npmrc");
writeFileSync(process.env.npm_config_userconfig, "");
writeFileSync(process.env.npm_config_globalconfig, "");
mock.module("node:os", () => {
  const actual = { ...require("node:os") };
  return { ...actual, homedir: () => TEST_HOME };
});
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === "/Health") return new Response("ok");
  if (url.hostname !== "registry.npmjs.org") throw new Error(`Unexpected request: ${url}`);
  return Response.json({ name: "@tpsdev-ai/flair", version: url.pathname.endsWith("/0.54.1") ? "0.54.1" : "0.54.2" });
}) as typeof fetch);

const { program } = await import("../../src/cli.ts");
const { rebindCli } = await import("../../src/commands/upgrade.ts");
const { clearNpmRegistryCache } = await import("../../src/lib/npm-registry.ts");
const START_ERROR = "test restart failure";
let restartCalls = 0;

function bindSeams(): void {
  restartCalls = 0;
  clearNpmRegistryCache();
  rebindCli({
    probeBinVersion: (_exec: unknown, bin: string) => bin === "flair" ? "0.54.1" : null,
    probeLibVersion: () => null,
    probeOpenclawPluginVersion: () => null,
    runPackageInstall: () => {},
    resolveHttpPort: () => 19926,
  });
}

async function runUpgrade(args: string[]): Promise<{ code: number; out: string; lines: string[] }> {
  const lines: string[] = [];
  let code = 0;
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.map((x) => String(x)).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    lines.push(a.map((x) => String(x)).join(" "));
  });
  const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
    code = c ?? 0;
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit);
  try {
    await program.parseAsync(["node", "flair", "upgrade", ...args]);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("process.exit(")) throw err;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { code, out: lines.join("\n"), lines };
}

/** Read every fixture file as bytes, including nested post-snapshot writes. */
function dataFiles(dir: string): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  function walk(relative: string): void {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) walk(name);
      else files[name] = readFileSync(join(dir, name));
    }
  }
  walk("");
  return files;
}

const STOPPED_EVIDENCE: DaemonEvidence = {
  dataDirUnsafe: null,
  pidfile: { kind: "absent" },
  pidLiveness: null,
  identity: { kind: "none" },
  health: { kind: "refused" },
};

async function prepareDataRollback() {
  bindSeams();
  const root = realpathSync(mkdtempSync(join(TEST_HOME, "rollback-data-")));
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "database"), { recursive: true });
  writeFileSync(join(dataDir, "config.yaml"), "original: config\n");
  writeFileSync(join(dataDir, "database", "wal.bin"), Buffer.from([1, 0, 2, 255]));
  const snapshotFiles = dataFiles(dataDir);
  let currentFiles = snapshotFiles;
  const events: string[] = [];
  rebindCli({
    defaultDataDir: () => dataDir,
    // No installed engine metadata: force the precautionary engine snapshot.
    flairPackageDir: () => join(root, "package"),
    stopFlairProcess: async (_port: number, target: string) => {
      expect(target).toBe(dataDir);
      events.push("stop");
    },
    gatherDaemonEvidence: async (_port: number, target: string) => {
      expect(target).toBe(dataDir);
      events.push("confirm-stopped");
      return STOPPED_EVIDENCE;
    },
    startFlairProcess: async () => {
      events.push("snapshot-restart");
      // The old server accepts these writes AFTER the real archive was made.
      writeFileSync(join(dataDir, "database", "wal.bin"), Buffer.from([0, 255, 7, 99, 0]));
      writeFileSync(join(dataDir, "database", "new-write.bin"), Buffer.from([128, 0, 255, 10]));
      currentFiles = dataFiles(dataDir);
    },
    restartAfterUpgrade: async () => {
      restartCalls += 1;
      events.push("restart");
      throw new Error(START_ERROR);
    },
  });
  return { root, dataDir, snapshotFiles, currentFiles: () => currentFiles, events };
}

describe("engine-change rollback data retention", () => {
  test("restores the snapshot and reports a timestamped sibling with every pre-restore byte intact", async () => {
    const fixture = await prepareDataRollback();
    const { code, out, lines } = await runUpgrade(["--no-verify"]);
    const retained = lines.find((line) => line.startsWith("  Current data retained at: "))?.slice("  Current data retained at: ".length);

    expect(code).toBe(1); // The rollback restart fails; retention must still survive.
    expect(out).toContain("snapshot restored");
    expect(out).toContain("KNOWN-BROKEN");
    expect(out).toContain("A pre-upgrade data snapshot was restored");
    expect(retained).toBeDefined();
    expect(dirname(retained!)).toBe(fixture.root);
    expect(basename(retained!)).toMatch(/^data\.pre-rollback-\d{4}-\d{2}-\d{2}T[\d-]+Z-.+$/);
    expect(existsSync(retained!)).toBe(true);
    expect(dataFiles(retained!)).toEqual(fixture.currentFiles());
    expect(dataFiles(fixture.dataDir)).toEqual(fixture.snapshotFiles);
    expect(out).toContain(`move ${retained} back to ${fixture.dataDir}`);
    expect(out).toContain("To recover writes made after the snapshot: stop Flair");
    expect(out).toContain("Harper engine version that wrote it");
    expect(fixture.events).toEqual(["stop", "snapshot-restart", "restart", "stop", "confirm-stopped", "restart"]);
    expect(restartCalls).toBe(2);
  });

  test("a failed move-aside leaves all current data unchanged and never extracts the snapshot", async () => {
    const fixture = await prepareDataRollback();
    const realRename = fs.renameSync;
    const renameSpy = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (source === fixture.dataDir) throw new Error("EACCES: move-aside denied");
      return realRename(source, destination);
    });
    const extractSpy = spyOn(snapshotExtract, "extractSnapshotSafely");
    try {
      const { code, out } = await runUpgrade(["--no-verify"]);
      expect(code).toBe(1);
      expect(renameSpy).toHaveBeenCalled();
      expect(extractSpy).not.toHaveBeenCalled();
      expect(dataFiles(fixture.dataDir)).toEqual(fixture.currentFiles());
      expect(out).toContain("refusing snapshot restore");
      expect(out).toContain("EACCES: move-aside denied");
      expect(out).toContain(`${fixture.dataDir} was not moved or replaced; no snapshot was restored`);
      expect(out).not.toContain("Current data retained at:");
      expect(out).not.toContain("✅ snapshot restored");
      expect(restartCalls).toBe(1);
    } finally {
      renameSpy.mockRestore();
      extractSpy.mockRestore();
    }
  });

  test("a failed stop refuses restoration without moving or replacing current data", async () => {
    const fixture = await prepareDataRollback();
    let stops = 0;
    rebindCli({
      stopFlairProcess: async () => {
        if (++stops > 1) throw new Error("stop denied");
      },
    });
    const { code, out } = await runUpgrade(["--no-verify"]);
    expect(code).toBe(1);
    expect(stops).toBe(2);
    expect(out).toContain("refusing snapshot restore");
    expect(out).toContain("stop denied");
    expect(dataFiles(fixture.dataDir)).toEqual(fixture.currentFiles());
    expect(readdirSync(fixture.root)).toEqual(["data"]);
    expect(restartCalls).toBe(1);
  });

  test.each([
    ["live pid despite refused /Health", {
      ...STOPPED_EVIDENCE,
      pidfile: { kind: "present", pid: 123 },
      pidLiveness: { kind: "alive" },
      identity: { kind: "verified", pid: 123 },
    }],
    ["listener still responding", { ...STOPPED_EVIDENCE, health: { kind: "ok" } }],
    ["unknown health", { ...STOPPED_EVIDENCE, health: { kind: "unreachable" } }],
  ] satisfies Array<[string, DaemonEvidence]>)("refuses restoration when stop returns but evidence shows %s", async (_label, evidence) => {
    const fixture = await prepareDataRollback();
    rebindCli({ gatherDaemonEvidence: async () => evidence });
    const { code, out } = await runUpgrade(["--no-verify"]);
    expect(code).toBe(1);
    expect(out).toContain("instance is not confirmed stopped");
    expect(out).toContain("no snapshot was restored");
    expect(dataFiles(fixture.dataDir)).toEqual(fixture.currentFiles());
    expect(readdirSync(fixture.root)).toEqual(["data"]);
    expect(restartCalls).toBe(1);
  });

  test("an extraction failure still reports and preserves every retained byte", async () => {
    const fixture = await prepareDataRollback();
    const extractSpy = spyOn(snapshotExtract, "extractSnapshotSafely").mockRejectedValue(new Error("extract failed"));
    try {
      const { code, out, lines } = await runUpgrade(["--no-verify"]);
      const retained = lines.find((line) => line.startsWith("  Current data retained at: "))?.slice("  Current data retained at: ".length);
      expect(code).toBe(1);
      expect(extractSpy).toHaveBeenCalledTimes(1);
      expect(out).toContain("snapshot restore failed: extract failed");
      expect(retained).toBeDefined();
      expect(dataFiles(retained!)).toEqual(fixture.currentFiles());
      expect(out).toContain(`Pre-restore data remains intact at ${retained}`);
      expect(out).toContain("To recover writes made after the snapshot");
      expect(restartCalls).toBe(1);
    } finally {
      extractSpy.mockRestore();
    }
  });

  test.each([false, true])("stops the plain-tree systemd unit before retention (stop failure: %s)", async (stopFails) => {
    const fixture = await prepareDataRollback();
    const tree = join(fixture.root, "package");
    const writeTree = (version: string) => {
      mkdirSync(join(tree, "dist"), { recursive: true });
      writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version }));
      writeFileSync(join(tree, "dist", "cli.js"), "#!/usr/bin/env node\n");
    };
    writeTree("0.54.1");
    const units = [{ name: "flair.service", path: "/fixture/flair.service", scope: "system" as const }];
    const findSpy = spyOn(plainTree, "findSystemdUnitsForTree").mockReturnValue(units);
    const restartSpy = spyOn(plainTree, "restartSystemdUnits").mockImplementation(() => {
      fixture.events.push("unit-restart");
      throw new Error(START_ERROR);
    });
    const stopSpy = spyOn(plainTree, "stopSystemdUnits").mockImplementation(() => {
      fixture.events.push("unit-stop");
      if (stopFails) throw new Error("systemd stop failed");
    });
    rebindCli({
      applyPlainTreeUpgrade: async (plan) => {
        fs.renameSync(plan.treeDir, plan.previousDir);
        writeTree("0.54.2");
      },
    });
    try {
      const { code, out, lines } = await runUpgrade(["--no-verify", "--tree", tree]);
      expect(code).toBe(1);
      expect(stopSpy).toHaveBeenCalledWith(units);
      if (stopFails) {
        expect(out).toContain("refusing snapshot restore");
        expect(out).toContain("systemd stop failed");
        expect(dataFiles(fixture.dataDir)).toEqual(fixture.currentFiles());
        expect(fixture.events).toEqual(["stop", "snapshot-restart", "unit-restart", "unit-stop"]);
      } else {
        const retained = lines.find((line) => line.startsWith("  Current data retained at: "))?.slice("  Current data retained at: ".length);
        expect(retained).toBeDefined();
        expect(dataFiles(retained!)).toEqual(fixture.currentFiles());
        expect(dataFiles(fixture.dataDir)).toEqual(fixture.snapshotFiles);
        expect(fixture.events).toEqual(["stop", "snapshot-restart", "unit-restart", "unit-stop", "stop", "confirm-stopped", "unit-restart"]);
      }
    } finally {
      findSpy.mockRestore();
      restartSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });
});

afterAll(() => {
  fetchSpy.mockRestore();
  for (const key of Object.keys(process.env)) if (!(key in SAVED_ENV)) delete process.env[key];
  Object.assign(process.env, SAVED_ENV);
  rmSync(TEST_HOME, { recursive: true, force: true });
});
