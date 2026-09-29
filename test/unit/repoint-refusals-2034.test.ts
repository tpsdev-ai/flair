/**
 * repoint-refusals-2034.test.ts — flair#2034 §2, round 3.
 *
 * The install-tree proof and the writers of OPERATOR FILES (the launchd plist,
 * the systemd user unit, the federation-sync shim) refuse rather than guess.
 * One describe per control:
 *
 *   1. the proof binds the service manager's PID to the process that ANSWERED —
 *      a live PID file that disagrees with the listener is UNKNOWN, never proof;
 *   2. systemd: the unit file must be the one the manager loaded
 *      (FragmentPath), and drop-ins from ANY location block the re-point;
 *   3. systemd edit: only the runtime operands of the two supported ExecStart
 *      shapes move; operator arguments are never rewritten; a target path that
 *      would need quoting is refused; the shape is validated before "current";
 *      an unreadable old-tree version is refused;
 *   4. launchd: the plist must be THIS instance's (one Label, ROOTPATH, HOME,
 *      the instance's admin-pass file) with each argument in its role;
 *   5. the write lands only over the bytes it was planned from (symlinks,
 *      swapped files and edits in between refuse it), and a failed systemd
 *      reload restores the bytes AND reloads, or says exactly what is left;
 *   6. the federation shim must run exactly the generated commands, and the
 *      pin message offers only a remedy that exists.
 *
 * Every service manager is a fake; every file lives in a scratch directory.
 */
import { describe, test, expect } from "bun:test";
import {
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../helpers/temp-dir.ts";
import {
  assessTreeDivergence,
  formatTreeAssessmentLines,
  identifyAnsweringPid,
  proveServingTree,
  systemdUnitStateFromShow,
  treeAssessmentJson,
  type LocalPidEvidence,
  type ProvenServingTree,
  type ServingTreeProbe,
  type SystemdUnitManagerState,
} from "../../src/lib/tree-divergence.ts";
import {
  planPlistRuntimeRepoint,
  planSystemdUnitRuntimeRepoint,
  type PlistOwnership,
  type RepointDeps,
  type RepointTargets,
} from "../../src/lib/service-repoint.ts";
import { applyRepointPlan, repointSystemdUserUnit, type SystemdRepointDeps } from "../../src/lib/service-repoint-apply.ts";
import { snapshotRegularFile, writeFilesAtomically } from "../../src/lib/atomic-write.ts";
import { classifyServiceNodePin } from "../../src/lib/launchd-management.ts";
import { enableScheduler, rewriteFederationSchedulerRuntime } from "../../src/federation/scheduler.ts";
import { buildLaunchdPlist, writeInitLaunchdPlist, type LaunchdPlistOptions } from "../../src/cli.ts";
import { resolveHome } from "../../src/lib/home.ts";

const DATA = "/home/u/.flair/data";
const HARPER = "node_modules/harper/dist/bin/harper.js";
const LAUNCHER = "templates/launchd/start-flair-with-admin-pass.sh";
const OLD_PREFIX = "/home/u/.nvm/versions/node/v24.18.0";
const NEW_PREFIX = "/home/u/.nvm/versions/node/v24.19.0";
const OLD_TREE = `${OLD_PREFIX}/lib/node_modules/@tpsdev-ai/flair`;
const NEW_TREE = `${NEW_PREFIX}/lib/node_modules/@tpsdev-ai/flair`;
const OLD_NODE = `${OLD_PREFIX}/bin/node`;
const NEW_NODE = `${NEW_PREFIX}/bin/node`;
const UNIT = "/home/u/.config/systemd/user/flair.service";

const targets: RepointTargets = {
  launcher: `${NEW_TREE}/${LAUNCHER}`,
  nodeBin: NEW_NODE,
  harperBin: `${NEW_TREE}/${HARPER}`,
  workingDirectory: NEW_TREE,
  cliVersion: "0.57.0",
};

function repointDeps(over: { present?: string[]; versions?: Record<string, string> } = {}): RepointDeps {
  const present = new Set(over.present ?? [NEW_NODE, NEW_TREE, `${NEW_TREE}/${HARPER}`, `${NEW_TREE}/${LAUNCHER}`]);
  const versions = over.versions ?? { [OLD_TREE]: "0.57.0", [NEW_TREE]: "0.57.0" };
  return {
    exists: (p) => present.has(p),
    samePath: (a, b) => resolve(a) === resolve(b),
    canonical: (p) => resolve(p),
    treeVersion: (d) => versions[d] ?? null,
  };
}

const unitText = (execStart: string, wd = OLD_TREE): string =>
  [
    "[Unit]",
    "Description=Flair",
    "",
    "[Service]",
    `WorkingDirectory=${wd}`,
    `ExecStart=${execStart}`,
    "Environment=ROOTPATH=/home/u/.flair/data",
    "Restart=always",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
const DIRECT = `${OLD_NODE} ${OLD_TREE}/${HARPER} run .`;

// ─── 1. the proof binds to the process that answered ────────────────────────

describe("1 — the serving PID is the process that answered, never a PID file that disagrees", () => {
  function linuxProbe(evidence: LocalPidEvidence, over: Partial<ServingTreeProbe> = {}): ServingTreeProbe {
    return {
      platform: "linux",
      local: true,
      queryUrl: "http://127.0.0.1:9926",
      dataDir: DATA,
      respondingPid: null,
      localPids: () => evidence,
      findUserUnitsForTree: () => [{ name: "flair.service", path: UNIT }],
      systemdUserUnit: () => ({ mainPid: 77, fragmentPath: UNIT, dropInPaths: [], workingDirectory: OLD_TREE }),
      servingPackage: () => ({ dir: OLD_TREE, version: "0.57.0" }),
      exists: () => true,
      read: () => unitText(DIRECT),
      ...over,
    };
  }
  const PLIST = "/Users/u/Library/LaunchAgents/ai.tpsdev.flair.abcd1234.plist";
  const darwinPlist = `<plist version="1.0"><dict><key>ProgramArguments</key><array><string>/x</string></array>
<key>WorkingDirectory</key><string>${OLD_TREE}</string>
<key>EnvironmentVariables</key><dict><key>ROOTPATH</key><string>${DATA}</string></dict></dict></plist>`;
  function darwinProbe(evidence: LocalPidEvidence, over: Partial<ServingTreeProbe> = {}): ServingTreeProbe {
    return {
      platform: "darwin",
      local: true,
      queryUrl: "http://127.0.0.1:9926",
      dataDir: DATA,
      respondingPid: null,
      localPids: () => evidence,
      launchd: { label: "ai.tpsdev.flair.abcd1234", plistPath: PLIST },
      launchdJobPid: () => 77,
      servingPackage: () => ({ dir: OLD_TREE, version: "0.57.0" }),
      exists: (p) => p === PLIST,
      read: () => darwinPlist,
      ...over,
    };
  }

  test("Linux: a live PID file (77) and a different listener (88) is UNKNOWN, although 77 is the unit's MainPID", () => {
    const s = proveServingTree(linuxProbe({ pidFile: 77, listeners: [88] }));
    expect(s.kind).toBe("unknown");
    if (s.kind === "unknown") {
      expect(s.reason).toContain("pid 88");
      expect(s.reason).toContain("pid 77");
    }
  });

  test("macOS: the same conflict against launchd's job pid is UNKNOWN", () => {
    expect(proveServingTree(darwinProbe({ pidFile: 77, listeners: [88] })).kind).toBe("unknown");
  });

  test("a reported pid that disagrees with a live PID file, or with the listener, is UNKNOWN", () => {
    expect(proveServingTree(linuxProbe({ pidFile: 88, listeners: [77] }, { respondingPid: 77 })).kind).toBe("unknown");
    expect(proveServingTree(linuxProbe({ pidFile: null, listeners: [88] }, { respondingPid: 77 })).kind).toBe("unknown");
  });

  test("no listener could be read and no pid was reported: UNKNOWN — the PID file alone is never the answer", () => {
    expect(proveServingTree(linuxProbe({ pidFile: 77, listeners: null })).kind).toBe("unknown");
    expect(proveServingTree(darwinProbe({ pidFile: 77, listeners: null })).kind).toBe("unknown");
  });

  test("the one listener, agreeing with the PID file or with none, is proof", () => {
    for (const pidFile of [77, null]) {
      const s = proveServingTree(linuxProbe({ pidFile, listeners: [77] }));
      expect(s.kind).toBe("proven");
      if (s.kind === "proven") expect(s.pid).toBe(77);
    }
    expect(proveServingTree(darwinProbe({ pidFile: null, listeners: [77] })).kind).toBe("proven");
  });

  test("identifyAnsweringPid: every disagreement is a reason, never a pick", () => {
    expect(identifyAnsweringPid(null, { pidFile: 5, listeners: [5, 5] })).toEqual({ pid: 5 });
    expect(identifyAnsweringPid(9, { pidFile: 9, listeners: [9] })).toEqual({ pid: 9 });
    expect(identifyAnsweringPid(9, { pidFile: null, listeners: null })).toEqual({ pid: 9 });
    for (const [pid, ev] of [
      [null, { pidFile: 5, listeners: [6] }],
      [null, { pidFile: null, listeners: [5, 6] }],
      [null, { pidFile: null, listeners: [] }],
      [null, { pidFile: 5, listeners: null }],
      [9, { pidFile: 5, listeners: [9] }],
      [9, { pidFile: null, listeners: [5] }],
    ] as Array<[number | null, LocalPidEvidence]>) {
      expect("reason" in identifyAnsweringPid(pid, ev)).toBe(true);
    }
  });
});

// ─── 2. systemd: the loaded file, and drop-ins from any location ────────────

describe("2 — systemd: FragmentPath must be the selected file; drop-ins anywhere block the re-point", () => {
  function probe(state: SystemdUnitManagerState): ServingTreeProbe {
    return {
      platform: "linux",
      local: true,
      queryUrl: "http://127.0.0.1:9926",
      dataDir: DATA,
      respondingPid: 77,
      localPids: () => ({ pidFile: 77, listeners: [77] }),
      findUserUnitsForTree: () => [{ name: "flair.service", path: UNIT }],
      systemdUserUnit: () => state,
      servingPackage: () => ({ dir: OLD_TREE, version: "0.57.0" }),
      exists: () => true,
      read: () => unitText(DIRECT),
    };
  }

  test("the PID is the unit NAME's, but systemd loaded ANOTHER file of that name: UNKNOWN", () => {
    const s = proveServingTree(
      probe({ mainPid: 77, fragmentPath: "/etc/systemd/user/flair.service", dropInPaths: [], workingDirectory: OLD_TREE }),
    );
    expect(s.kind).toBe("unknown");
    if (s.kind === "unknown") expect(s.reason).toContain("/etc/systemd/user/flair.service");
  });

  test("drop-ins from another location: proven, but the remedy is a hand edit, never `flair init`", () => {
    const dropIn = "/etc/systemd/user/flair.service.d/override.conf";
    const s = proveServingTree(probe({ mainPid: 77, fragmentPath: UNIT, dropInPaths: [dropIn], workingDirectory: OLD_TREE }));
    expect(s.kind).toBe("proven");
    if (s.kind !== "proven") return;
    expect(s.dropInPaths).toEqual([dropIn]);
    // The unit file alone does not say what systemd runs: no node/tree is read from it.
    expect(s.unitTree).toBeNull();
    const a = assessTreeDivergence({ cli: { dir: NEW_TREE, version: "0.57.0" }, serving: s, runningVersion: "0.57.0", currentNodeBin: NEW_NODE });
    expect(a.state).toBe("diverged");
    const text = formatTreeAssessmentLines(a).join("\n");
    expect(text).toContain(dropIn);
    expect(text).not.toContain("flair init && flair restart");
    expect(text).toContain("by hand");
    expect(treeAssessmentJson(a).remedy).toBeNull();
  });

  test("the manager's answer is parsed, and an incomplete answer is not an empty one", () => {
    expect(
      systemdUnitStateFromShow(
        "MainPID=77\nFragmentPath=/u/flair.service\nDropInPaths=/a/x.conf /b/y.conf\nWorkingDirectory=!/srv/t\n",
      ),
    ).toEqual({ mainPid: 77, fragmentPath: "/u/flair.service", dropInPaths: ["/a/x.conf", "/b/y.conf"], workingDirectory: "/srv/t" });
    expect(systemdUnitStateFromShow("MainPID=0\nFragmentPath=\nDropInPaths=\nWorkingDirectory=\n")).toEqual({
      mainPid: null,
      fragmentPath: null,
      dropInPaths: [],
      workingDirectory: null,
    });
    expect(systemdUnitStateFromShow("MainPID=77\nFragmentPath=/u/flair.service\n")).toBeNull();
  });
});

// ─── 3. systemd edit: runtime operands only, supported shapes only ──────────

describe("3 — systemd planner: runtime operands only; the shape is validated first", () => {
  const d = repointDeps({ present: [NEW_NODE, NEW_TREE, `${NEW_TREE}/${HARPER}`, `${NEW_TREE}/${LAUNCHER}`, `${NEW_TREE}/operator.yaml`, `${NEW_TREE}/admin-pass`] });

  test("an operator argument inside the old tree (--config) is never rewritten: the unit is refused", () => {
    const text = unitText(`${DIRECT} --config ${OLD_TREE}/operator.yaml`);
    const plan = planSystemdUnitRuntimeRepoint(text, OLD_TREE, targets, d, UNIT);
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.detail).toContain("by hand");
  });

  test("the launcher's admin-pass argument is the operator's: kept even when it lies in the old tree", () => {
    const text = unitText(`-${OLD_TREE}/${LAUNCHER} ${OLD_TREE}/admin-pass ${OLD_NODE} ${OLD_TREE}/${HARPER}`);
    const plan = planSystemdUnitRuntimeRepoint(text, OLD_TREE, targets, d, UNIT);
    expect(plan.kind).toBe("repoint");
    if (plan.kind !== "repoint") return;
    expect(plan.text).toContain(`ExecStart=-${NEW_TREE}/${LAUNCHER} ${OLD_TREE}/admin-pass ${NEW_NODE} ${NEW_TREE}/${HARPER}`);
    expect(plan.changes.map((c) => c.field).sort()).toEqual(["Harper entry", "WorkingDirectory", "launcher", "node"]);
  });

  test("a target path that would need quoting (a space) is refused, never written unescaped", () => {
    const spaced = "/home/u/my nodes/lib/node_modules/@tpsdev-ai/flair";
    const t: RepointTargets = {
      launcher: `${spaced}/${LAUNCHER}`,
      nodeBin: "/home/u/my nodes/bin/node",
      harperBin: `${spaced}/${HARPER}`,
      workingDirectory: spaced,
      cliVersion: "0.57.0",
    };
    const dd = repointDeps({ present: [t.nodeBin, spaced, t.harperBin, t.launcher!], versions: { [OLD_TREE]: "0.57.0" } });
    const plan = planSystemdUnitRuntimeRepoint(unitText(DIRECT), OLD_TREE, t, dd, UNIT);
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") {
      expect(plan.detail).toContain("quoting");
      expect(plan.detail).toContain("by hand");
    }
  });

  test("a same-tree unit in an unsupported shape is refused — never reported as current", () => {
    const text = unitText(`${NEW_NODE} ${NEW_TREE}/${HARPER} run . --config ${NEW_TREE}/operator.yaml`, NEW_TREE);
    expect(planSystemdUnitRuntimeRepoint(text, NEW_TREE, targets, d, UNIT).kind).toBe("refuse");
  });

  test("the old tree's flair version cannot be read: refused (a downgrade cannot be ruled out)", () => {
    const dd = repointDeps({ versions: {} });
    const plan = planSystemdUnitRuntimeRepoint(unitText(DIRECT), OLD_TREE, targets, dd, UNIT);
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") {
      expect(plan.detail).toContain("cannot be read");
      expect(plan.detail).toContain("by hand");
    }
    const plist = planPlistRuntimeRepoint(adoptedPlist(), plistTargets(), plistDeps({ versions: {} }), "/p.plist", OWNER);
    expect(plist.kind).toBe("refuse");
  });

  for (const [name, exec] of [
    ["an ExecStart prefix other than '-' (@)", `@${OLD_NODE} ${OLD_TREE}/${HARPER} run .`],
    ["an ExecStart prefix other than '-' (+)", `+${OLD_NODE} ${OLD_TREE}/${HARPER} run .`],
    ["an ExecStart prefix other than '-' (-:)", `-:${OLD_NODE} ${OLD_TREE}/${HARPER} run .`],
    ["an extra node flag", `${OLD_NODE} --max-old-space-size=4096 ${OLD_TREE}/${HARPER} run .`],
    ["a Harper entry outside the served tree", `${OLD_NODE} /opt/harper/dist/bin/harper.js run .`],
    ["a launcher outside the served tree", `/usr/local/bin/start-flair-with-admin-pass.sh /p ${OLD_NODE} ${OLD_TREE}/${HARPER}`],
  ] as const) {
    test(`refused: ${name}`, () => {
      const plan = planSystemdUnitRuntimeRepoint(unitText(exec), OLD_TREE, targets, d, UNIT);
      expect(plan.kind).toBe("refuse");
      if (plan.kind === "refuse") expect(plan.detail).toContain("by hand");
    });
  }
});

// ─── 4. launchd: this instance's plist, every argument in its role ──────────

const MAC_OLD = "/Users/u/.local/share/mise/installs/node/24.18.0";
const MAC_NEW = "/Users/u/.local/share/mise/installs/node/24.19.0";
const MAC_OLD_TREE = `${MAC_OLD}/lib/node_modules/@tpsdev-ai/flair`;
const MAC_NEW_TREE = `${MAC_NEW}/lib/node_modules/@tpsdev-ai/flair`;
const OWNER: PlistOwnership = {
  label: "ai.tpsdev.flair.abcd1234",
  dataDir: "/Users/u/.flair/data",
  home: "/Users/u",
  adminPassFile: "/Users/u/.flair/admin-pass",
};
function plistTargets(): RepointTargets {
  return {
    launcher: `${MAC_NEW_TREE}/${LAUNCHER}`,
    nodeBin: `${MAC_NEW}/bin/node`,
    harperBin: `${MAC_NEW_TREE}/${HARPER}`,
    workingDirectory: MAC_NEW_TREE,
    cliVersion: "0.57.0",
  };
}
function plistDeps(over: { versions?: Record<string, string> } = {}): RepointDeps {
  const t = plistTargets();
  return repointDeps({
    present: [t.launcher!, t.nodeBin, t.harperBin, t.workingDirectory],
    versions: over.versions ?? { [MAC_OLD_TREE]: "0.57.0" },
  });
}
function adoptedPlist(over: Partial<LaunchdPlistOptions> & { home?: string; adminPassFile?: string; launcher?: string } = {}): string {
  return buildLaunchdPlist({
    label: OWNER.label,
    execPath: `${MAC_OLD}/bin/node`,
    harperBinPath: `${MAC_OLD_TREE}/${HARPER}`,
    workingDirectory: MAC_OLD_TREE,
    dataDir: OWNER.dataDir,
    modelsDir: "/Users/u/models",
    setConfig: "{}",
    adminUser: "admin",
    httpPort: 9926,
    opsNetworkPort: "127.0.0.1:9925",
    passFile: {
      launcher: over.launcher ?? `${MAC_OLD_TREE}/${LAUNCHER}`,
      adminPassFile: over.adminPassFile ?? OWNER.adminPassFile,
      home: over.home ?? OWNER.home,
      path: "/usr/bin:/bin",
    },
    ...over,
  });
}

describe("4 — launchd: only THIS instance's plist, with each argument in its role", () => {
  test("control: this instance's plist is re-pointed", () => {
    expect(planPlistRuntimeRepoint(adoptedPlist(), plistTargets(), plistDeps(), "/p.plist", OWNER).kind).toBe("repoint");
  });

  for (const [name, raw] of [
    ["a plist declaring another user's HOME", adoptedPlist({ home: "/Users/someone-else" })],
    ["a plist passing another admin-pass file", adoptedPlist({ adminPassFile: "/Users/u/other/admin-pass" })],
    ["a plist whose launcher is not the one in its tree", adoptedPlist({ launcher: "/usr/local/bin/start-flair-with-admin-pass.sh" })],
    ["a plist whose Harper argument is not a Harper entry", adoptedPlist({ harperBinPath: `${MAC_OLD_TREE}/dist/cli.js` })],
    ["a plist for another label", adoptedPlist({ label: "ai.tpsdev.flair.ffffffff" })],
    ["a plist with a second Label", adoptedPlist().replace("<key>RunAtLoad</key>", "<key>Label</key><string>x</string>\n  <key>RunAtLoad</key>")],
    ["a plist with a second HOME", adoptedPlist().replace("<key>LOCAL_STUDIO</key>", "<key>HOME</key><string>/Users/u</string><key>LOCAL_STUDIO</key>")],
    ["a plist with a second ROOTPATH", adoptedPlist().replace("<key>LOCAL_STUDIO</key>", `<key>ROOTPATH</key><string>${OWNER.dataDir}</string><key>LOCAL_STUDIO</key>`)],
    ["a plist with a Program key", adoptedPlist().replace("<key>RunAtLoad</key>", "<key>Program</key><string>/bin/sh</string>\n  <key>RunAtLoad</key>")],
  ] as const) {
    test(`refused: ${name}`, () => {
      const plan = planPlistRuntimeRepoint(raw, plistTargets(), plistDeps(), "/p.plist", OWNER);
      expect(plan.kind).toBe("refuse");
      if (plan.kind === "refuse") {
        expect(plan.detail).toContain("/p.plist");
        expect(plan.detail).toContain("by hand");
      }
    });
  }
});

// ─── 5. write only over the planned bytes; recover a failed reload ──────────

describe("5 — the write lands only over the bytes it was planned from", () => {
  function file(content = "OLD\n"): { dir: string; path: string } {
    const dir = tempDir("flair-2034-planned-");
    const path = join(dir, "unit.service");
    writeFileSync(path, content, { mode: 0o644 });
    return { dir, path };
  }

  test("an edit saved between the plan and the rename refuses the write and keeps the edit", () => {
    const { dir, path } = file();
    const planned = snapshotRegularFile(path);
    expect(() =>
      writeFilesAtomically([{ path, content: "NEW\n", mode: 0o644, expect: planned }], {
        fsync: (fd) => {
          fsyncSync(fd);
          writeFileSync(path, "OPERATOR EDIT\n");
        },
      }),
    ).toThrow(/changed since flair read it/);
    expect(readFileSync(path, "utf-8")).toBe("OPERATOR EDIT\n");
    expect(readdirSync(dir)).toEqual(["unit.service"]);
  });

  test("a file swapped for another with the SAME bytes is still refused (identity, not just content)", () => {
    const { dir, path } = file();
    const planned = snapshotRegularFile(path);
    expect(() =>
      writeFilesAtomically([{ path, content: "NEW\n", mode: 0o644, expect: planned }], {
        fsync: (fd) => {
          fsyncSync(fd);
          writeFileSync(join(dir, "copy"), "OLD\n");
          renameSync(join(dir, "copy"), path);
        },
      }),
    ).toThrow(/replaced/);
    expect(readFileSync(path, "utf-8")).toBe("OLD\n");
  });

  test("a symlink is refused at read, and a file swapped for a symlink is refused at the rename", () => {
    const { dir, path } = file();
    const link = join(dir, "link.service");
    symlinkSync(path, link);
    expect(() => snapshotRegularFile(link)).toThrow(/symbolic link/);

    const planned = snapshotRegularFile(path);
    const elsewhere = join(dir, "elsewhere");
    writeFileSync(elsewhere, "OLD\n");
    expect(() =>
      writeFilesAtomically([{ path, content: "NEW\n", mode: 0o644, expect: planned }], {
        fsync: (fd) => {
          fsyncSync(fd);
          renameSync(path, join(dir, "moved"));
          symlinkSync(elsewhere, path);
        },
      }),
    ).toThrow(/symbolic link/);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(elsewhere, "utf-8")).toBe("OLD\n");
  });

  test("init: a symlinked adopted plist is not re-pointed, and the link survives", async () => {
    const f = macFixture();
    const real = join(f.dir, "real.plist");
    renameSync(f.opts.plistPath, real);
    symlinkSync(real, f.opts.plistPath);
    const before = readFileSync(real, "utf-8");
    const r = await writeInitLaunchdPlist(f.opts);
    expect(r.kind).toBe("not-repointed");
    expect(lstatSync(f.opts.plistPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf-8")).toBe(before);
  });

  test("init: an operator edit saved while init plans is kept, and the re-point is refused", async () => {
    const f = macFixture();
    const edited = readFileSync(f.opts.plistPath, "utf-8").replace("<true/>", "<false/>");
    const r = await writeInitLaunchdPlist(f.opts, {
      atomic: {
        fsync: (fd) => {
          fsyncSync(fd);
          writeFileSync(f.opts.plistPath, edited);
        },
      },
    });
    expect(r.kind).toBe("not-repointed");
    if (r.kind === "not-repointed") expect(r.detail).toContain("changed since flair read it");
    expect(readFileSync(f.opts.plistPath, "utf-8")).toBe(edited);
  });

  test("init: a foreign-HOME adopted plist is not re-pointed and stays byte-identical", async () => {
    const f = macFixture({ home: "/Users/someone-else" });
    const before = readFileSync(f.opts.plistPath, "utf-8");
    const r = await writeInitLaunchdPlist(f.opts);
    expect(r.kind).toBe("not-repointed");
    if (r.kind === "not-repointed") expect(r.detail).toContain("HOME");
    expect(readFileSync(f.opts.plistPath, "utf-8")).toBe(before);
  });

  // ── systemd: the reload, and what a failed one leaves ──
  function systemdFixture(): { path: string; serving: ProvenServingTree; before: string } {
    const dir = tempDir("flair-2034-systemd-");
    const path = join(dir, "flair.service");
    const before = unitText(DIRECT);
    writeFileSync(path, before, { mode: 0o644 });
    return {
      path,
      before,
      serving: {
        kind: "proven",
        dir: OLD_TREE,
        version: "0.57.0",
        pid: 77,
        manager: "systemd-user",
        unitName: "flair.service",
        unitPath: path,
        unitNodeBin: OLD_NODE,
        unitTree: OLD_TREE,
        dropInPaths: [],
      },
    };
  }
  function fakes(
    path: string,
    over: Partial<SystemdRepointDeps> & { reloads?: Array<() => void> } = {},
  ): SystemdRepointDeps & { calls: string[] } {
    const calls: string[] = [];
    const reloads = over.reloads ?? [];
    let n = 0;
    return Object.assign(
      {
        repoint: repointDeps(),
        exists: existsSync,
        unitState: (): SystemdUnitManagerState => {
          calls.push("show");
          const wd = /^WorkingDirectory=(.*)$/m.exec(readFileSync(path, "utf-8"))?.[1] ?? null;
          return { mainPid: 77, fragmentPath: path, dropInPaths: [], workingDirectory: wd };
        },
        reload: () => {
          calls.push("reload");
          const r = reloads[n++];
          if (r) r();
        },
        ...over,
      },
      { calls },
    );
  }

  test("systemd: the re-point is reloaded and confirmed from the manager", () => {
    const f = systemdFixture();
    const d = fakes(f.path);
    const r = repointSystemdUserUnit(f.serving, targets, d);
    expect(r.kind).toBe("repointed");
    expect(d.calls).toEqual(["reload", "show"]);
    expect(readFileSync(f.path, "utf-8")).toContain(`WorkingDirectory=${NEW_TREE}`);
  });

  test("systemd: a failed reload restores the bytes AND reloads again, so disk and manager agree", () => {
    const f = systemdFixture();
    const d = fakes(f.path, { reloads: [() => { throw new Error("Failed to reload daemon"); }] });
    const r = repointSystemdUserUnit(f.serving, targets, d);
    expect(r.kind).toBe("refused");
    expect(readFileSync(f.path, "utf-8")).toBe(f.before);
    expect(d.calls).toEqual(["reload", "reload"]);
    if (r.kind === "refused") expect(r.detail).toContain("both hold the previous unit");
  });

  test("systemd: the manager not holding what was written (a drop-in appeared) is restored the same way", () => {
    const f = systemdFixture();
    const d = fakes(f.path, {
      unitState: () => ({ mainPid: 77, fragmentPath: f.path, dropInPaths: ["/run/user/1/systemd/transient/x.conf"], workingDirectory: NEW_TREE }),
    });
    const r = repointSystemdUserUnit(f.serving, targets, d);
    expect(r.kind).toBe("refused");
    expect(readFileSync(f.path, "utf-8")).toBe(f.before);
    expect(d.calls.filter((c) => c === "reload")).toHaveLength(2);
  });

  test("systemd: when the second reload fails too, the result names the state left behind", () => {
    const f = systemdFixture();
    const fail = () => { throw new Error("bus unavailable"); };
    const r = repointSystemdUserUnit(f.serving, targets, fakes(f.path, { reloads: [fail, fail] }));
    expect(r.kind).toBe("refused");
    expect(readFileSync(f.path, "utf-8")).toBe(f.before);
    if (r.kind === "refused") {
      expect(r.detail).toContain("the file holds the previous unit");
      expect(r.detail).toContain("systemctl --user daemon-reload");
    }
  });

  test("systemd: when the restore itself fails, the result says the file holds the RE-POINTED unit", () => {
    const f = systemdFixture();
    let renames = 0;
    const r = repointSystemdUserUnit(
      f.serving,
      targets,
      fakes(f.path, {
        reloads: [() => { throw new Error("Failed to reload daemon"); }],
        atomic: {
          rename: (from, to) => {
            renames++;
            if (renames === 2) throw new Error("EIO: simulated");
            renameSync(from, to);
          },
        },
      }),
    );
    expect(r.kind).toBe("refused");
    expect(readFileSync(f.path, "utf-8")).toContain(`WorkingDirectory=${NEW_TREE}`);
    if (r.kind === "refused") expect(r.detail).toContain("RE-POINTED");
  });

  test("systemd: drop-ins the manager reports, or a <unit>.d beside the file, refuse before any write", () => {
    const f = systemdFixture();
    const d = fakes(f.path);
    const r = repointSystemdUserUnit({ ...f.serving, dropInPaths: ["/etc/systemd/user/flair.service.d/o.conf"] }, targets, d);
    expect(r.kind).toBe("refused");
    mkdirSync(`${f.path}.d`);
    expect(repointSystemdUserUnit(f.serving, targets, d).kind).toBe("refused");
    expect(readFileSync(f.path, "utf-8")).toBe(f.before);
    expect(d.calls).toEqual([]);
  });

  test("systemd: a symlinked unit file is refused, and the link survives", () => {
    const f = systemdFixture();
    const real = join(dirname(f.path), "real.service");
    renameSync(f.path, real);
    symlinkSync(real, f.path);
    const d = fakes(real);
    expect(repointSystemdUserUnit(f.serving, targets, d).kind).toBe("refused");
    expect(lstatSync(f.path).isSymbolicLink()).toBe(true);
    expect(d.calls).toEqual([]);
  });

  test("a plan that is not a re-point never writes or reloads", () => {
    const f = systemdFixture();
    const calls: string[] = [];
    const r = applyRepointPlan({ kind: "refuse", detail: "no" }, snapshotRegularFile(f.path), { reload: () => calls.push("reload") });
    expect(r.kind).toBe("refused");
    expect(calls).toEqual([]);
  });
});

/** A macOS-shaped init fixture: an adopted plist for THIS instance serving an old npm-global tree. */
function macFixture(over: { home?: string } = {}) {
  const dir = tempDir("flair-2034-init-");
  const tree = (v: string) => {
    const prefix = join(dir, "node", v);
    const t = join(prefix, "lib", "node_modules", "@tpsdev-ai", "flair");
    mkdirSync(join(t, "node_modules", "harper", "dist", "bin"), { recursive: true });
    mkdirSync(join(t, "templates", "launchd"), { recursive: true });
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeFileSync(join(t, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.57.0" }));
    writeFileSync(join(t, HARPER), "// harper\n");
    writeFileSync(join(t, LAUNCHER), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(prefix, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
    return { tree: t, node: join(prefix, "bin", "node") };
  };
  const old = tree("24.18.0");
  const cur = tree("24.19.0");
  const dataDir = join(dir, "data");
  const adminPassPath = join(dir, "admin-pass");
  const label = "ai.tpsdev.flair.deadbeef";
  const plistPath = join(dir, `${label}.plist`);
  writeFileSync(
    plistPath,
    buildLaunchdPlist({
      label,
      execPath: old.node,
      harperBinPath: join(old.tree, HARPER),
      workingDirectory: old.tree,
      dataDir,
      modelsDir: join(dataDir, "models"),
      setConfig: "{}",
      adminUser: "admin",
      httpPort: 9926,
      opsNetworkPort: "9925",
      passFile: { launcher: join(old.tree, LAUNCHER), adminPassFile: adminPassPath, home: over.home ?? resolveHome(), path: "/usr/bin:/bin" },
    }),
    { mode: 0o644 },
  );
  return {
    dir,
    opts: {
      dataDir,
      plistPath,
      label,
      adminPass: "",
      adminUser: "admin",
      modelsDir: join(dataDir, "models"),
      execPath: cur.node,
      harperBinPath: join(cur.tree, HARPER),
      workingDirectory: cur.tree,
      httpPort: 9926,
      opsNetworkPort: "9925",
      setConfig: "{}",
      port: 9926,
      adminPassPath,
      liveInstance: false,
    },
  };
}

// ─── 6. the shim's commands, and a remedy that exists ────────────────────────

describe("6 — the federation shim must run exactly the generated commands", () => {
  const templateRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "templates");
  function shimFixture() {
    const root = tempDir("flair-2034-shim-");
    const home = join(root, "home");
    mkdirSync(join(home, ".flair", "bin"), { recursive: true });
    const rt = (v: string) => {
      const prefix = join(root, "rt", v);
      const t = join(prefix, "lib", "node_modules", "@tpsdev-ai", "flair");
      mkdirSync(join(t, "dist"), { recursive: true });
      mkdirSync(join(prefix, "bin"), { recursive: true });
      writeFileSync(join(t, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.57.0" }));
      writeFileSync(join(t, "dist", "cli.js"), "// flair\n");
      writeFileSync(join(prefix, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
      return { node: join(prefix, "bin", "node"), cli: join(t, "dist", "cli.js") };
    };
    const old = rt("24.18.0");
    const cur = rt("24.19.0");
    const shim = join(home, ".flair", "bin", "flair-federation-sync");
    const plist = join(home, "Library", "LaunchAgents", "dev.flair.federation.sync.plist");
    enableScheduler({
      intervalSeconds: 600,
      flairBin: old.cli,
      nodeBin: old.node,
      platformOverride: "darwin",
      shimPathOverride: shim,
      launchdPlistOverride: plist,
      homeOverride: home,
      templateRootOverride: templateRoot,
      skipLoad: true,
    });
    const rewrite = (over: Parameters<typeof rewriteFederationSchedulerRuntime>[0] = {}) =>
      rewriteFederationSchedulerRuntime({
        platformOverride: "darwin",
        shimPathOverride: shim,
        launchdPlistOverride: plist,
        nodeBin: cur.node,
        flairBin: cur.cli,
        templateRootOverride: templateRoot,
        ...over,
      });
    return { root, shim, rewrite };
  }

  test("a marked shim with an extra hand-written command is refused and left as it is", () => {
    const f = shimFixture();
    const edited = readFileSync(f.shim, "utf-8").replace("set -e\n", "set -e\necho custom-before-exec\n");
    writeFileSync(f.shim, edited);
    for (const dryRun of [true, false]) {
      const r = f.rewrite({ dryRun });
      expect(r.status).toBe("refused");
      expect(r.detail).toContain("hand-changed");
      // The refusal names a line number, never the line's content.
      expect(r.detail).not.toContain("custom-before-exec");
    }
    expect(readFileSync(f.shim, "utf-8")).toBe(edited);
  });

  test("comment lines are not compared: a shim whose comments were edited is still re-pointed", () => {
    const f = shimFixture();
    writeFileSync(f.shim, readFileSync(f.shim, "utf-8").replace("# One-shot by design", "# (edited) One-shot by design"));
    expect(f.rewrite().status).toBe("rewritten");
  });

  test("a symlinked shim is refused, and the link survives", () => {
    const f = shimFixture();
    const real = join(f.root, "real-shim");
    renameSync(f.shim, real);
    symlinkSync(real, f.shim);
    const before = readFileSync(real, "utf-8");
    expect(f.rewrite().status).toBe("refused");
    expect(lstatSync(f.shim).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf-8")).toBe(before);
  });

  test("an edit saved between the read and the rename is kept, and the rewrite is refused", () => {
    const f = shimFixture();
    const edited = readFileSync(f.shim, "utf-8").replace("set -e\n", "set -eu\n");
    const r = f.rewrite({
      atomic: {
        fsync: (fd) => {
          fsyncSync(fd);
          writeFileSync(f.shim, edited);
        },
      },
    });
    expect(r.status).toBe("refused");
    expect(readFileSync(f.shim, "utf-8")).toBe(edited);
  });
});

describe("6 — a deliberate pin's message offers only a remedy that exists", () => {
  test("init leaves a same-tree plist that pins another node, and reports the pin with its hand edit", async () => {
    const f = macFixture();
    const pinned = join(f.dir, "pinned", "bin", "node");
    mkdirSync(dirname(pinned), { recursive: true });
    writeFileSync(pinned, "#!/bin/sh\n", { mode: 0o755 });
    // The plist already serves this CLI's tree, under a different, existing node.
    const tree = f.opts.workingDirectory;
    writeFileSync(
      f.opts.plistPath,
      buildLaunchdPlist({
        label: f.opts.label,
        execPath: pinned,
        harperBinPath: join(tree, HARPER),
        workingDirectory: tree,
        dataDir: f.opts.dataDir,
        modelsDir: f.opts.modelsDir,
        setConfig: "{}",
        adminUser: "admin",
        httpPort: 9926,
        opsNetworkPort: "9925",
        passFile: { launcher: join(tree, LAUNCHER), adminPassFile: f.opts.adminPassPath, home: resolveHome(), path: "/usr/bin:/bin" },
      }),
    );
    const before = readFileSync(f.opts.plistPath, "utf-8");
    const r = await writeInitLaunchdPlist(f.opts);
    expect(r.kind).toBe("unchanged");
    if (r.kind === "unchanged") {
      expect(r.pinnedNode).toContain(pinned);
      expect(r.pinnedNode).toContain("by hand");
    }
    expect(readFileSync(f.opts.plistPath, "utf-8")).toBe(before);
  });

  test("no `flair init && flair restart` for a pin init will not change; the hand edit is named", () => {
    const pin = classifyServiceNodePin(
      { unitDescription: "the launchd plist at /x.plist", unitNodeBin: "/opt/pinned/bin/node", unitTree: NEW_TREE, currentNodeBin: NEW_NODE, cliTree: NEW_TREE },
      { exists: () => true, realpath: (p) => p },
    );
    expect(pin?.kind).toBe("pinned");
    expect(pin!.message).not.toContain("flair init && flair restart");
    expect(pin!.message).toContain("does not change it");
    expect(pin!.message).toContain(`to ${NEW_NODE} in the unit by hand`);
  });
});
