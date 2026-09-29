/**
 * linux-unit-from-process-2034.test.ts — flair#2034 §2, round 6.
 *
 * The live Linux smoke found that the proof looked for the owning systemd unit
 * by searching unit files for the tree the serving process runs. After
 * `flair init` re-points the file at this CLI's tree, no file names the old
 * tree, so the state fell to "unknown" and `flair restart` stopped the unit's
 * process and respawned it OUTSIDE systemd.
 *
 * These tests run the REAL lookup: `linuxUnitProbe` parses fake
 * /proc/<pid>/cgroup text and fake `systemctl --user show` output — the same
 * code path src/cli.ts uses — for the states before the re-point, after it
 * (restart pending) and after the restart. `restartOnLinux` is driven with a
 * fake systemctl: a proven unit is restarted through systemd and verified; a
 * process any other systemd service owns is refused, never respawned directly.
 */
import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import {
  assessTreeDivergence,
  cgroupOwner,
  formatTreeAssessmentLines,
  linuxUnitProbe,
  planLinuxRestart,
  proveServingTree,
  treeAssessmentJson,
  type ServingTree,
  type ServingTreeProbe,
  type SystemdUnitManagerState,
} from "../../src/lib/tree-divergence.ts";
import { restartOnLinux, type LinuxRestartDeps } from "../../src/lib/service-repoint-apply.ts";

const UID = 1001;
const HOME = "/home/fs";
const UNIT_DIR = `${HOME}/.config/systemd/user`;
const UNIT = "flair-smoke.service";
const FRAG = `${UNIT_DIR}/${UNIT}`;
const OLD = `${HOME}/old/lib/node_modules/@tpsdev-ai/flair`;
const NEW = `${HOME}/new/lib/node_modules/@tpsdev-ai/flair`;
const NODE = `${HOME}/.local/node/bin/node`;
const PID = 897724;
const NEW_PID = 903400;
const IN_UNIT = `0::/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/${UNIT}\n`;
const IN_SESSION = `0::/user.slice/user-${UID}.slice/session-c7.scope\n`;

const unitFile = (tree: string) =>
  [
    "[Unit]",
    "Description=Flair smoke instance",
    "",
    "[Service]",
    "Type=simple",
    `EnvironmentFile=${HOME}/.config/flair-smoke/env`,
    `WorkingDirectory=${tree}`,
    `ExecStart=${tree}/templates/launchd/start-flair-with-admin-pass.sh ${HOME}/.flair/admin-pass ${NODE} ${tree}/node_modules/harper/dist/bin/harper.js`,
    "Restart=on-failure",
    "",
  ].join("\n");

const show = (mainPid: number, wd: string, over: { fragment?: string; dropIns?: string } = {}) =>
  `MainPID=${mainPid}\nWorkingDirectory=${wd}\nActiveState=active\nFragmentPath=${over.fragment ?? FRAG}\nDropInPaths=${over.dropIns ?? ""}\n`;

/** A host: which process serves, from which tree, in which cgroup, and what systemd says. */
function host(o: { pid: number; runs: string; fileNames: string; showText: string | null; cgroup?: string }) {
  const files: Record<string, string> = { [`/proc/${o.pid}/cgroup`]: o.cgroup ?? IN_UNIT, [FRAG]: unitFile(o.fileNames) };
  const calls: string[] = [];
  const probe: ServingTreeProbe = {
    platform: "linux",
    local: true,
    queryUrl: "http://127.0.0.1:19926",
    dataDir: `${HOME}/.flair/data`,
    respondingPid: o.pid,
    localPids: () => ({ pidFile: o.pid, listeners: [o.pid] }),
    servingPackage: () => ({ dir: o.runs, version: "0.57.0" }),
    exists: (p) => p in files,
    read: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p]!;
    },
    samePath: (a, b) => resolve(a) === resolve(b),
    ...linuxUnitProbe({
      readFile: (p) => {
        calls.push(`read ${p}`);
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return files[p]!;
      },
      systemctlShow: (unit) => {
        calls.push(`show ${unit}`);
        return unit === UNIT ? o.showText : null;
      },
      uid: UID,
      userUnitDir: UNIT_DIR,
    }),
  };
  return { probe, calls };
}

const cli = { dir: NEW, version: "0.57.0" };
const assess = (s: ServingTree) => assessTreeDivergence({ cli, serving: s, runningVersion: "0.57.0", currentNodeBin: NODE, samePath: (a, b) => a === b });

describe("the Linux unit is found from the running process, before and after the re-point", () => {
  test("before the re-point: proven from the cgroup; diverged; remedy init + restart", () => {
    const h = host({ pid: PID, runs: OLD, fileNames: OLD, showText: show(PID, OLD) });
    const s = proveServingTree(h.probe);
    expect(s.kind).toBe("proven");
    if (s.kind !== "proven") return;
    expect(s.unitName).toBe(UNIT);
    expect(s.unitPath).toBe(FRAG);
    expect(s.unitTree).toBe(OLD);
    expect(h.calls).toContain(`read /proc/${PID}/cgroup`);
    expect(h.calls).toContain(`show ${UNIT}`);
    const a = assess(s);
    expect(a.state).toBe("diverged");
    expect(a.restartPending).toBe(false);
    expect(treeAssessmentJson(a).remedy).toEqual(["flair init", "flair restart"]);
  });

  test("AFTER the re-point (file names NEW, the process still runs OLD): proven, diverged, restart pending — never unknown", () => {
    const h = host({ pid: PID, runs: OLD, fileNames: NEW, showText: show(PID, NEW) });
    const s = proveServingTree(h.probe);
    expect(s.kind).toBe("proven");
    if (s.kind !== "proven") return;
    expect(s.unitTree).toBe(NEW);
    const a = assess(s);
    expect(a.state).toBe("diverged");
    expect(a.restartPending).toBe(true);
    expect(treeAssessmentJson(a).remedy).toEqual(["flair restart"]);
    expect(formatTreeAssessmentLines(a).join("\n")).toContain("Remedy: flair restart");
  });

  test("after the restart through the unit: the new main process serves NEW — same", () => {
    const h = host({ pid: NEW_PID, runs: NEW, fileNames: NEW, showText: show(NEW_PID, NEW) });
    const s = proveServingTree(h.probe);
    expect(s.kind).toBe("proven");
    expect(assess(s).state).toBe("same");
  });

  test("a directly started process (a login-session scope) is unknown — no unit owns it", () => {
    const s = proveServingTree(host({ pid: PID, runs: OLD, fileNames: OLD, showText: show(PID, OLD), cgroup: IN_SESSION }).probe);
    expect(s.kind).toBe("unknown");
    if (s.kind === "unknown") expect(s.reason).toContain("started directly");
  });

  for (const [name, cgroup] of [
    ["another user's manager", `0::/user.slice/user-1002.slice/user@1002.service/app.slice/${UNIT}\n`],
    ["a system-level unit", "0::/system.slice/flair.service\n"],
    ["a sub-cgroup inside the unit", `0::/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/${UNIT}/payload\n`],
    ["a cgroup v1-only host", `1:name=systemd:/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/${UNIT}\n`],
  ] as const) {
    test(`unknown when the process is in ${name}`, () => {
      expect(proveServingTree(host({ pid: PID, runs: OLD, fileNames: OLD, showText: show(PID, OLD), cgroup }).probe).kind).toBe("unknown");
    });
  }

  test("the unit's MainPID must be the serving process; its file must be that name in this user's unit directory", () => {
    expect(proveServingTree(host({ pid: PID, runs: OLD, fileNames: OLD, showText: show(12, OLD) }).probe).kind).toBe("unknown");
    for (const fragment of [`/etc/systemd/user/${UNIT}`, `${UNIT_DIR}/other.service`]) {
      const s = proveServingTree(host({ pid: PID, runs: OLD, fileNames: OLD, showText: show(PID, OLD, { fragment }) }).probe);
      expect(s.kind).toBe("unknown");
      if (s.kind === "unknown") expect(s.reason).toContain(fragment);
    }
    expect(proveServingTree(host({ pid: PID, runs: OLD, fileNames: OLD, showText: null }).probe).kind).toBe("unknown");
  });

  test("cgroupOwner reads the unified entry only", () => {
    expect(cgroupOwner(IN_UNIT, UID)).toMatchObject({ kind: "user-service", unit: UNIT });
    expect(cgroupOwner(`0::/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/app-x.slice/${UNIT}`, UID)).toMatchObject({
      kind: "user-service",
      unit: UNIT,
    });
    expect(cgroupOwner(IN_SESSION, UID).kind).toBe("none");
    expect(cgroupOwner(`0::/user.slice/user-${UID}.slice/user@${UID}.service/init.scope`, UID).kind).toBe("none");
    expect(cgroupOwner("0::/system.slice/flair.service", UID)).toMatchObject({ kind: "service", unit: "flair.service", user: false });
    expect(cgroupOwner("", UID).kind).toBe("unreadable");
  });
});

describe("flair restart on Linux: through systemd for a proven unit, never around a manager", () => {
  function deps(o: {
    serving: ServingTree;
    cgroups?: Record<number, string>;
    after?: SystemdUnitManagerState | null;
    cwd?: string | null;
  }): LinuxRestartDeps & { calls: string[] } {
    const calls: string[] = [];
    const d: LinuxRestartDeps = {
      serving: o.serving,
      pids: [PID],
      procCgroup: (pid) => {
        const t = o.cgroups?.[pid];
        if (t === undefined) throw new Error(`ENOENT /proc/${pid}/cgroup`);
        return t;
      },
      uid: UID,
      systemctl: (args) => {
        calls.push(`systemctl ${args.join(" ")}`);
      },
      waitHealthy: async () => {
        calls.push("wait");
      },
      unitState: () => (o.after === undefined ? { mainPid: NEW_PID, fragmentPath: FRAG, dropInPaths: [], workingDirectory: NEW } : o.after),
      cwdOf: () => (o.cwd === undefined ? NEW : o.cwd),
      samePath: (a, b) => a === b,
      direct: async () => {
        calls.push("DIRECT stop+spawn");
      },
    };
    return Object.assign(d, { calls });
  }
  const afterRepoint = () => proveServingTree(host({ pid: PID, runs: OLD, fileNames: NEW, showText: show(PID, NEW) }).probe);

  test("after the re-point the proven unit is restarted THROUGH systemd and verified; nothing is respawned directly", async () => {
    const d = deps({ serving: afterRepoint(), cgroups: { [PID]: IN_UNIT } });
    expect(await restartOnLinux(d)).toBe("systemd");
    expect(d.calls).toEqual(["systemctl --user daemon-reload", `systemctl --user restart ${UNIT}`, "wait"]);
  });

  test("the unit's new main process must be a new pid running from the unit's WorkingDirectory", async () => {
    await expect(restartOnLinux(deps({ serving: afterRepoint(), cwd: OLD }))).rejects.toThrow(/runs in .*old.* not the unit's WorkingDirectory/);
    await expect(
      restartOnLinux(deps({ serving: afterRepoint(), after: { mainPid: PID, fragmentPath: FRAG, dropInPaths: [], workingDirectory: NEW } })),
    ).rejects.toThrow(/still pid/);
    await expect(restartOnLinux(deps({ serving: afterRepoint(), after: null }))).rejects.toThrow(/did not report/);
  });

  test("a process in a user unit that could not be proven is REFUSED with the systemctl command — never stopped and respawned", async () => {
    const serving: ServingTree = { kind: "unknown", reason: `systemd loads ${UNIT} from /etc/systemd/user/${UNIT}` };
    const d = deps({ serving, cgroups: { [PID]: IN_UNIT } });
    await expect(restartOnLinux(d)).rejects.toThrow(`systemctl --user restart ${UNIT}`);
    expect(d.calls).toEqual([]);
  });

  test("a process in a system-level service is refused with the root systemctl command", async () => {
    const d = deps({ serving: { kind: "unknown", reason: "system-level" }, cgroups: { [PID]: "0::/system.slice/flair.service\n" } });
    await expect(restartOnLinux(d)).rejects.toThrow("systemctl restart flair.service (as root)");
    expect(d.calls).toEqual([]);
  });

  test("a process whose cgroup cannot be read is refused, not stopped", async () => {
    const d = deps({ serving: { kind: "unknown", reason: "r" }, cgroups: {} });
    await expect(restartOnLinux(d)).rejects.toThrow(/cannot be read/);
    expect(d.calls).toEqual([]);
  });

  test("a directly started process (session scope) takes the direct path", async () => {
    const d = deps({ serving: { kind: "unknown", reason: "no systemd unit owns the serving process" }, cgroups: { [PID]: IN_SESSION } });
    expect(await restartOnLinux(d)).toBe("direct");
    expect(d.calls).toEqual(["DIRECT stop+spawn"]);
  });

  test("planLinuxRestart: nothing running is the direct path (there is no process to stop)", () => {
    expect(planLinuxRestart({ serving: { kind: "unknown", reason: "r" }, pids: [], procCgroup: () => IN_UNIT, uid: UID }).kind).toBe("direct");
  });
});
