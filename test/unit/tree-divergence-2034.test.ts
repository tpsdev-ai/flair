/**
 * tree-divergence-2034.test.ts — flair#2034 §2: which install tree serves the
 * instance, from PROOF (the service manager owns the answering process), and
 * the one operator message that follows from it.
 *
 * Every probe is injected: no real launchd, systemd, process table or HOME.
 */
import { describe, test, expect } from "bun:test";
import {
  assessTreeDivergence,
  formatServingTreeLine,
  formatTreeAssessmentLines,
  isNpmGlobalFlairTree,
  proveServingTree,
  treeAssessmentJson,
  withRunningVersion,
  type ServingTreeProbe,
} from "../../src/lib/tree-divergence.ts";

const DATA = "/home/u/.flair/data";
const OLD_TREE = "/home/u/.local/share/mise/installs/node/24.18.0/lib/node_modules/@tpsdev-ai/flair";
const NEW_TREE = "/home/u/.local/share/mise/installs/node/24.19.0/lib/node_modules/@tpsdev-ai/flair";
const OLD_NODE = "/home/u/.local/share/mise/installs/node/24.18.0/bin/node";
const NEW_NODE = "/home/u/.local/share/mise/installs/node/24.19.0/bin/node";
const PLIST_PATH = "/home/u/Library/LaunchAgents/ai.tpsdev.flair.abcd1234.plist";
const LABEL = "ai.tpsdev.flair.abcd1234";

function plist(rootPath = DATA, tree = OLD_TREE, node = OLD_NODE): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${tree}/templates/launchd/start-flair-with-admin-pass.sh</string>
    <string>/home/u/.flair/admin-pass</string>
    <string>${node}</string>
    <string>${tree}/node_modules/harper/dist/bin/harper.js</string>
  </array>
  <key>WorkingDirectory</key><string>${tree}</string>
  <key>EnvironmentVariables</key><dict><key>ROOTPATH</key><string>${rootPath}</string></dict>
</dict></plist>`;
}

/** A darwin probe where launchd's job IS the answering process unless overridden. */
function darwinProbe(over: Partial<ServingTreeProbe> = {}): ServingTreeProbe & { calls: string[] } {
  const calls: string[] = [];
  const files: Record<string, string> = { [PLIST_PATH]: plist() };
  const probe: ServingTreeProbe = {
    platform: "darwin",
    local: true,
    queryUrl: "http://127.0.0.1:9926",
    dataDir: DATA,
    respondingPid: 4242,
    localPids: () => { calls.push("localPids"); return { pidFile: 4242, listeners: [4242] }; },
    launchd: { label: LABEL, plistPath: PLIST_PATH },
    launchdJobPid: () => { calls.push("launchdJobPid"); return 4242; },
    servingPackage: (pid) => { calls.push(`servingPackage:${pid}`); return { dir: OLD_TREE, version: "0.57.0" }; },
    exists: (p) => p in files,
    read: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p]!;
    },
    ...over,
  };
  return Object.assign(probe, { calls });
}

describe("proveServingTree — macOS", () => {
  test("proven: this data dir's launchd job IS the answering process; the tree comes from the process", () => {
    const s = proveServingTree(darwinProbe());
    expect(s.kind).toBe("proven");
    if (s.kind !== "proven") return;
    expect(s.dir).toBe(OLD_TREE);
    expect(s.version).toBe("0.57.0");
    expect(s.pid).toBe(4242);
    expect(s.manager).toBe("launchd");
    expect(s.unitName).toBe(LABEL);
    expect(s.unitNodeBin).toBe(OLD_NODE);
    expect(s.unitTree).toBe(OLD_TREE);
  });

  test("no plist for this data dir (a direct start, or a server under a different HOME): unknown", () => {
    const s = proveServingTree(darwinProbe({ exists: () => false }));
    expect(s.kind).toBe("unknown");
    if (s.kind === "unknown") expect(s.reason).toContain("started directly");
  });

  test("a plist registered to another data dir is not proof about this one", () => {
    const s = proveServingTree(darwinProbe({ read: () => plist("/other/home/.flair/data") }));
    expect(s.kind).toBe("unknown");
    if (s.kind === "unknown") expect(s.reason).toContain("not registered to this data directory");
  });

  test("launchd job not running: unknown", () => {
    const s = proveServingTree(darwinProbe({ launchdJobPid: () => null }));
    expect(s.kind).toBe("unknown");
  });

  test("the answering process is NOT launchd's job (direct start beside a loaded job): unknown", () => {
    const s = proveServingTree(darwinProbe({ respondingPid: 999 }));
    expect(s.kind).toBe("unknown");
    if (s.kind === "unknown") {
      expect(s.reason).toContain("pid 999");
      expect(s.reason).toContain("pid 4242");
    }
  });

  test("without a reported pid, the one process listening on the port is the answer", () => {
    const without = darwinProbe({ respondingPid: null });
    const s = proveServingTree(without);
    expect(s.kind).toBe("proven");
    if (s.kind === "proven") expect(s.pid).toBe(4242);
    expect(without.calls).toContain("localPids");
  });

  test("the process's tree cannot be read: unknown (never falls back to the unit's WorkingDirectory)", () => {
    const s = proveServingTree(darwinProbe({ servingPackage: () => null }));
    expect(s.kind).toBe("unknown");
  });

  test("a remote / --target query is unknown and probes nothing local", () => {
    const p = darwinProbe({ local: false, queryUrl: "https://hub.example" });
    const s = proveServingTree(p);
    expect(s.kind).toBe("unknown");
    if (s.kind === "unknown") expect(s.reason).toContain("https://hub.example");
    expect(p.calls).toEqual([]);
  });
});

describe("proveServingTree — Linux", () => {
  const UNIT = "/home/u/.config/systemd/user/my-flair.service";
  const unitText = `[Service]\nWorkingDirectory=${OLD_TREE}\nExecStart=${OLD_NODE} ${OLD_TREE}/node_modules/harper/dist/bin/harper.js run .\n`;
  function linuxProbe(over: Partial<ServingTreeProbe> = {}): ServingTreeProbe {
    return {
      platform: "linux",
      local: true,
      queryUrl: "http://127.0.0.1:9926",
      dataDir: DATA,
      respondingPid: 77,
      localPids: () => ({ pidFile: 77, listeners: [77] }),
      procCgroup: (pid) => (pid === 77 ? "0::/user.slice/user-1000.slice/user@1000.service/app.slice/my-flair.service\n" : ""),
      uid: 1000,
      userUnitDir: "/home/u/.config/systemd/user",
      systemdUserUnit: (name) =>
        name === "my-flair.service" ? { mainPid: 77, fragmentPath: UNIT, dropInPaths: [], workingDirectory: OLD_TREE } : null,
      servingPackage: () => ({ dir: OLD_TREE, version: "0.57.0" }),
      exists: (p) => p === UNIT,
      read: () => unitText,
      ...over,
    };
  }

  test("proven: the serving process's cgroup names a user unit (any name) whose MainPID it is", () => {
    const s = proveServingTree(linuxProbe());
    expect(s.kind).toBe("proven");
    if (s.kind !== "proven") return;
    expect(s.manager).toBe("systemd-user");
    expect(s.unitName).toBe("my-flair.service");
    expect(s.unitNodeBin).toBe(OLD_NODE);
    expect(s.unitTree).toBe(OLD_TREE);
  });

  test("a system-level unit owns the serving process (it is the unit's MainPID): unknown", () => {
    const s = proveServingTree(
      linuxProbe({
        procCgroup: () => "0::/system.slice/flair.service\n",
        unitMainPid: (unit, manager) => (unit === "flair.service" && manager === "system" ? 77 : null),
      }),
    );
    expect(s.kind).toBe("unknown");
    if (s.kind === "unknown") expect(s.reason).toContain("system-level");
  });

  test("a user unit whose MainPID is another process (direct start): unknown", () => {
    expect(
      proveServingTree(
        linuxProbe({ systemdUserUnit: () => ({ mainPid: 12, fragmentPath: UNIT, dropInPaths: [], workingDirectory: OLD_TREE }) }),
      ).kind,
    ).toBe("unknown");
  });

  test("an unsupported platform is unknown", () => {
    expect(proveServingTree(linuxProbe({ platform: "win32" })).kind).toBe("unknown");
  });
});

const cli = { dir: NEW_TREE, version: "0.57.0" };
function proven(over: Record<string, unknown> = {}) {
  return {
    kind: "proven" as const,
    dir: OLD_TREE,
    version: "0.57.0",
    pid: 4242,
    manager: "launchd" as const,
    unitName: LABEL,
    unitPath: PLIST_PATH,
    unitNodeBin: OLD_NODE,
    unitTree: OLD_TREE,
    dropInPaths: [] as string[],
    ...over,
  };
}
const exists = () => true;
const realpath = (p: string) => p;

describe("assessTreeDivergence", () => {
  test("a different npm-global tree serving is a divergence, with the node pin named as the cause", () => {
    const a = assessTreeDivergence({ cli, serving: proven(), runningVersion: "0.57.0", currentNodeBin: NEW_NODE, nodePinDeps: { exists, realpath } });
    expect(a.state).toBe("diverged");
    expect(a.nodePin?.kind).toBe("erroneous");
    expect(a.restartPending).toBe(false);
  });

  test("the same tree is not a divergence", () => {
    const a = assessTreeDivergence({ cli, serving: proven({ dir: NEW_TREE, unitTree: NEW_TREE, unitNodeBin: NEW_NODE }), currentNodeBin: NEW_NODE });
    expect(a.state).toBe("same");
  });

  test("a plain tree or checkout serving is SEPARATE, never a divergence to re-point", () => {
    const a = assessTreeDivergence({ cli, serving: proven({ dir: "/opt/flair", unitTree: "/opt/flair" }), currentNodeBin: NEW_NODE });
    expect(a.state).toBe("separate");
    expect(formatTreeAssessmentLines(a).join("\n")).not.toContain("flair init");
  });

  test("unknown stays unknown and yields no block", () => {
    const a = assessTreeDivergence({ cli, serving: { kind: "unknown", reason: "because" }, currentNodeBin: NEW_NODE });
    expect(a.state).toBe("unknown");
    expect(formatTreeAssessmentLines(a)).toEqual([]);
    expect(formatServingTreeLine(a)).toBe("serving install tree: unknown — because");
  });

  test("a unit already re-pointed at this CLI's tree, not yet restarted, is restart-pending", () => {
    const a = assessTreeDivergence({ cli, serving: proven({ unitTree: NEW_TREE, unitNodeBin: NEW_NODE }), currentNodeBin: NEW_NODE });
    expect(a.state).toBe("diverged");
    expect(a.restartPending).toBe(true);
  });

  test("cliOlder compares this CLI with the version the instance RUNS", () => {
    const base = assessTreeDivergence({ cli: { dir: NEW_TREE, version: "0.55.2" }, serving: proven({ version: "0.55.2" }), currentNodeBin: NEW_NODE });
    expect(base.cliOlder).toBe(false);
    expect(withRunningVersion(base, "0.57.0").cliOlder).toBe(true);
  });
});

describe("formatTreeAssessmentLines", () => {
  const a = assessTreeDivergence({
    cli: { dir: NEW_TREE, version: "0.57.0" },
    serving: proven(),
    runningVersion: "0.55.2",
    currentNodeBin: NEW_NODE,
    nodePinDeps: { exists, realpath },
  });

  test("names both trees, both versions, the owning unit and the remedy", () => {
    const text = formatTreeAssessmentLines(a).join("\n");
    expect(text).toContain(NEW_TREE);
    expect(text).toContain(OLD_TREE);
    expect(text).toContain("flair 0.57.0");
    expect(text).toContain("running flair 0.55.2");
    expect(text).toContain(LABEL);
    expect(text).toContain("Remedy: flair init && flair restart");
  });

  test("describes what init really does — no 'rewrites the unit' / 'data is not touched' claim", () => {
    const text = formatTreeAssessmentLines(a).join("\n");
    expect(text).toContain("full setup command");
    expect(text).toContain("leaves the unit's other settings as they are");
    expect(text).not.toContain("Your data is not touched");
    expect(text).not.toContain("rewrites the unit against the runtime");
  });

  test("an unreadable version is shown as unknown, never omitted", () => {
    const b = withRunningVersion({ ...a, cli: { dir: NEW_TREE, version: null } }, null);
    const text = formatTreeAssessmentLines(b).join("\n");
    expect(text).toContain("CLI:      " + NEW_TREE + "  (flair version unknown)");
    expect(text).toContain("running flair version unknown");
  });

  test("CLI tree older: update it first, and the re-point is not offered as the first step", () => {
    const older = withRunningVersion({ ...a, cli: { dir: NEW_TREE, version: "0.55.2" } }, "0.57.0");
    const text = formatTreeAssessmentLines(older).join("\n");
    expect(text).toContain("npm i -g @tpsdev-ai/flair");
    expect(text.indexOf("npm i -g")).toBeLessThan(text.indexOf("flair init && flair restart"));
    expect(text).not.toContain("Remedy: flair init && flair restart");
  });

  test("restart-pending: the remedy is flair restart alone", () => {
    const pending = assessTreeDivergence({ cli, serving: proven({ unitTree: NEW_TREE }), currentNodeBin: NEW_NODE });
    const text = formatTreeAssessmentLines(pending).join("\n");
    expect(text).toContain("Remedy: flair restart");
    expect(text).not.toContain("flair init");
  });

  test("the currency line separates the CLI from the instance", () => {
    const text = formatTreeAssessmentLines(a, { latest: "0.57.0" }).join("\n");
    expect(text).toContain("this CLI is current, the instance is behind");
  });

  test("the upgrade context says what upgrade does not change", () => {
    expect(formatTreeAssessmentLines(a, { context: "upgrade" }).join("\n")).toContain("changes this CLI's tree only");
  });

  test("JSON carries the same state and remedy", () => {
    const j = treeAssessmentJson(a);
    expect(j.state).toBe("diverged");
    expect((j.serving as any).dir).toBe(OLD_TREE);
    expect((j.serving as any).runningVersion).toBe("0.55.2");
    expect(j.remedy).toEqual(["flair init", "flair restart"]);
    const u = treeAssessmentJson(assessTreeDivergence({ cli, serving: { kind: "unknown", reason: "r" }, currentNodeBin: NEW_NODE }));
    expect(u.serving).toBeNull();
    expect(u.unknownReason).toBe("r");
    expect(u.remedy).toBeNull();
  });
});

describe("isNpmGlobalFlairTree", () => {
  test("the global-prefix layout only", () => {
    expect(isNpmGlobalFlairTree(OLD_TREE)).toBe(true);
    expect(isNpmGlobalFlairTree("/opt/homebrew/lib/node_modules/@tpsdev-ai/flair")).toBe(true);
    expect(isNpmGlobalFlairTree("/opt/flair")).toBe(false);
    expect(isNpmGlobalFlairTree("/home/u/work/flair")).toBe(false);
    expect(isNpmGlobalFlairTree("/srv/app/node_modules/@tpsdev-ai/flair")).toBe(false);
  });
});
