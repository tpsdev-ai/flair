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
 * process that is the main process of any other systemd unit is refused, never
 * respawned directly.
 *
 * Round 7: a unit supervises a process only as its MainPID. A process that
 * merely sits in some service's cgroup — a CI runner agent's child, the case
 * that turned CI red — was started directly: restarted directly, and reported
 * as started directly by status/doctor. A MainPID that cannot be read is
 * refused with the command. The cgroup pattern is a fixed expression; the uids
 * it captures are compared in code.
 *
 * Round 8: a cgroup path that contradicts itself — a user slice and a user
 * manager naming different uids, a user manager outside its own slice, or one
 * unit's cgroup nested in another's — is refused before any manager is asked,
 * so no MainPID answer about it can license a direct restart.
 */
import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import {
  assessTreeDivergence,
  cgroupOwner,
  formatTreeAssessmentLines,
  linuxUnitProbe,
  mainPidFromShow,
  planLinuxRestart,
  proveServingTree,
  treeAssessmentJson,
  unitSupervision,
  type CgroupOwner,
  type ServingTree,
  type ServingTreeProbe,
  type SystemdManager,
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
/** A directly started Harper on a hosted CI runner: inside the runner agent's service, not its main process. */
const RUNNER_UNIT = "hosted-compute-agent.service";
const IN_RUNNER = `0::/system.slice/${RUNNER_UNIT}\n`;
const RUNNER_PID = 812;
/** Another process: what a manager answers as a unit's MainPID when the serving process is not it. */
const OTHER_PID = 4242;
/**
 * Round 8: cgroups that contradict themselves. Without the check each reaches a manager's MainPID answer, and an
 * answer naming another process would license the direct stop-and-spawn path.
 */
const CONTRADICTORY_CGROUPS: Record<string, string> = {
  // the user slice names uid 1002, the user manager this user's uid
  "slice and manager uids disagree": `0::/user.slice/user-1002.slice/user@${UID}.service/app.slice/${UNIT}\n`,
  // one service's cgroup nested in another's
  "a service nested in a service": `0::/system.slice/${RUNNER_UNIT}/flair.service\n`,
  "a user service nested in a user service": `0::/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/tmux.service/${UNIT}\n`,
  // this user's manager nested in a service's cgroup — with a service below it, and without one
  "a user manager nested in a service": `0::/system.slice/container.service/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/${UNIT}\n`,
  "a user manager nested in a service, no service below it": `0::/system.slice/container.service/user.slice/user-${UID}.slice/user@${UID}.service/init.scope\n`,
};
/** Every manager a check could ask, answering OTHER_PID as the MainPID. */
const OTHER_MAIN_PIDS: Record<string, number> = {
  [`user:${UNIT}`]: OTHER_PID,
  "user:tmux.service": OTHER_PID,
  "system:flair.service": OTHER_PID,
  [`system:${RUNNER_UNIT}`]: OTHER_PID,
  "system:container.service": OTHER_PID,
  "user:container.service": OTHER_PID,
  [`system:${UNIT}`]: OTHER_PID,
};

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

/**
 * A host: which process serves, from which tree, in which cgroup, and what systemd says. `showText` is the user
 * manager's answer for UNIT; `shows` answers any other unit, keyed `<manager>:<unit>` (absent: no answer).
 */
function host(o: {
  pid: number;
  runs: string;
  fileNames: string;
  showText: string | null;
  cgroup?: string;
  shows?: Record<string, string | null>;
}) {
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
      systemctlShow: (unit, manager) => {
        calls.push(manager === "user" ? `show ${unit}` : `show --${manager} ${unit}`);
        if (manager === "user" && unit === UNIT) return o.showText;
        return o.shows?.[`${manager}:${unit}`] ?? null;
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

  // The fixed pattern captures both uids and compares them with this user's in code. The table is literal, and its
  // "user-service" column is what the round-6 expression (built from the uid) accepted for uid 1001: the same set.
  // Round 8: a path whose user slice and user manager disagree, or that nests one unit in another, is "contradictory".
  const CGROUP_TABLE: ReadonlyArray<readonly [string, "user-service" | "service" | "none" | "contradictory", string | null]> = [
    ["/user.slice/user-1001.slice/user@1001.service/app.slice/flair-smoke.service", "user-service", "flair-smoke.service"],
    ["/user.slice/user-1001.slice/user@1001.service/flair-smoke.service", "user-service", "flair-smoke.service"],
    ["/user.slice/user-1001.slice/user@1001.service/app.slice/app-x.slice/flair-smoke.service", "user-service", "flair-smoke.service"],
    ["/user.slice/user-1001.slice/user@1001.service/app.slice/flair@inst.service", "user-service", "flair@inst.service"],
    ["/user.slice/user-1001.slice/user@1001.service/app.slice/app-flair\\x2dsmoke.service", "user-service", "app-flair\\x2dsmoke.service"],
    ["/user.slice/user-1001.slice/user@1001.service/a:b_c.slice/x-1.service", "user-service", "x-1.service"],
    // uid mismatch: another user's manager, or the two uids disagreeing (contradictory, round 8)
    ["/user.slice/user-1002.slice/user@1002.service/app.slice/flair-smoke.service", "service", "flair-smoke.service"],
    ["/user.slice/user-1001.slice/user@1002.service/app.slice/flair-smoke.service", "contradictory", null],
    ["/user.slice/user-1002.slice/user@1001.service/app.slice/flair-smoke.service", "contradictory", null],
    ["/user.slice/user-10011.slice/user@10011.service/app.slice/flair-smoke.service", "service", "flair-smoke.service"],
    ["/user.slice/user-01001.slice/user@01001.service/app.slice/flair-smoke.service", "service", "flair-smoke.service"],
    ["/user.slice/user-100.slice/user@100.service/app.slice/flair-smoke.service", "service", "flair-smoke.service"],
    // not exactly a unit of this user's manager
    ["/user.slice/user-1001.slice/user@1001.service/app.slice/flair-smoke.service/payload", "service", "flair-smoke.service"],
    ["/user.slice/user-1001.slice/user@1001.service/app slice.slice/flair-smoke.service", "service", "flair-smoke.service"],
    ["/user.slice/user-1001.slice/user@1001.service/app.slice/flair smoke.service", "service", "flair smoke.service"],
    ["/user.slice/user-1001.slice/user@1001.service/app.scope/flair-smoke.service", "service", "flair-smoke.service"],
    ["/user.slice/user-1001.slice/user@1001.service/app.slice/flair-smoke.service/", "service", "flair-smoke.service"],
    ["user.slice/user-1001.slice/user@1001.service/app.slice/flair-smoke.service", "service", "flair-smoke.service"],
    ["/system.slice/hosted-compute-agent.service", "service", "hosted-compute-agent.service"],
    ["/system.slice/flair.service", "service", "flair.service"],
    // no service
    ["/user.slice/user-1001.slice/user@1001.service/app.slice/app-foo.scope", "none", null],
    ["/user.slice/user-1001.slice/user@1001.service/init.scope", "none", null],
    ["/user.slice/user-1001.slice/user@1001.service", "none", null],
    ["/user.slice/user-1001.slice/session-c7.scope", "none", null],
    ["/", "none", null],
    // contradictory (round 8): the user slice and the user manager disagree, the manager is outside its own slice,
    // or one unit's cgroup is nested in another's
    ["/user.slice/user-1002.slice/user@1001.service/flair-smoke.service", "contradictory", null],
    ["/user.slice/user-1002.slice/user@1001.service/app.slice/flair-smoke.service/payload", "contradictory", null],
    ["/user.slice/user-1002.slice/user@1001.service", "contradictory", null],
    ["/system.slice/user@1001.service/app.slice/flair-smoke.service", "contradictory", null],
    ["/user.slice/user-1002.slice/user.slice/user-1001.slice/user@1001.service/app.slice/flair-smoke.service", "contradictory", null],
    ["/user.slice/user-1001.slice/user@1001.service/app.slice/user@1001.service/flair-smoke.service", "contradictory", null],
    ["/system.slice/hosted-compute-agent.service/flair.service", "contradictory", null],
    ["/user.slice/user-1001.slice/user@1001.service/app.slice/tmux.service/flair-smoke.service", "contradictory", null],
    ["/system.slice/container.service/user.slice/user-1001.slice/user@1001.service/app.slice/flair-smoke.service", "contradictory", null],
    ["/system.slice/container.service/user.slice/user-1001.slice/user@1001.service/init.scope", "contradictory", null],
  ];
  test("the fixed cgroup pattern accepts exactly the round-6 set (literal table, uid mismatches included)", () => {
    for (const [path, kind, unit] of CGROUP_TABLE) {
      const got = cgroupOwner(`0::${path}\n`, UID);
      expect({ path, kind: got.kind, unit: "unit" in got ? got.unit : null }).toEqual({ path, kind, unit });
    }
    // The uids are compared, not merely present: the same path is another user's for another uid.
    expect(cgroupOwner(`0::/user.slice/user-1002.slice/user@1002.service/app.slice/${UNIT}`, 1002).kind).toBe("user-service");
    expect(cgroupOwner(IN_UNIT, 1002).kind).toBe("service");
  });

  test("status/doctor report a process that merely sits in a service's cgroup as started directly — the rule restart uses", () => {
    const at = (show: string | null) =>
      proveServingTree(
        host({ pid: PID, runs: OLD, fileNames: OLD, showText: null, cgroup: IN_RUNNER, shows: { [`system:${RUNNER_UNIT}`]: show } }).probe,
      );
    const other = at(`MainPID=${RUNNER_PID}\nFragmentPath=/usr/lib/systemd/system/${RUNNER_UNIT}\nDropInPaths=\nWorkingDirectory=/\n`);
    expect(other.kind).toBe("unknown");
    if (other.kind === "unknown") {
      expect(other.reason).toContain("started directly");
      expect(other.reason).toContain(`main process is pid ${RUNNER_PID}`);
    }
    const main = at(`MainPID=${PID}\nFragmentPath=/usr/lib/systemd/system/${RUNNER_UNIT}\nDropInPaths=\nWorkingDirectory=/\n`);
    expect(main.kind === "unknown" && main.reason).toContain(`is the main process of the systemd unit ${RUNNER_UNIT}`);
    const unreadable = at(null);
    expect(unreadable.kind === "unknown" && unreadable.reason).toContain("is not known");
    // A user unit whose MainPID is another process: started directly too (not "owned").
    const userOther = proveServingTree(host({ pid: PID, runs: OLD, fileNames: OLD, showText: show(12, OLD) }).probe);
    expect(userOther.kind === "unknown" && userOther.reason).toContain("started directly");
  });

  test("status/doctor: a CONTRADICTORY cgroup is unknown, and no manager is asked about it (round 8)", () => {
    for (const [name, cgroup] of Object.entries(CONTRADICTORY_CGROUPS)) {
      const shows = Object.fromEntries(Object.keys(OTHER_MAIN_PIDS).map((k) => [k, show(PID, OLD)]));
      const h = host({ pid: PID, runs: OLD, fileNames: OLD, showText: show(PID, OLD), cgroup, shows });
      const s = proveServingTree(h.probe);
      expect({ name, kind: s.kind, contradictory: s.kind === "unknown" && s.reason.includes("is contradictory") }).toEqual({
        name,
        kind: "unknown",
        contradictory: true,
      });
      expect({ name, asked: h.calls.filter((c) => c.startsWith("show")) }).toEqual({ name, asked: [] });
    }
  });
});

describe("flair restart on Linux: through systemd for a proven unit, never around a manager", () => {
  function deps(o: {
    serving: ServingTree;
    cgroups?: Record<number, string>;
    /** The MainPID each manager reports, keyed `<manager>:<unit>`; absent or null: it could not be asked. */
    mainPids?: Record<string, number | null>;
    after?: SystemdUnitManagerState | null;
    cwd?: string | null;
  }): LinuxRestartDeps & { calls: string[]; asked: string[] } {
    const calls: string[] = [];
    const asked: string[] = [];
    const d: LinuxRestartDeps = {
      serving: o.serving,
      pids: [PID],
      procCgroup: (pid) => {
        const t = o.cgroups?.[pid];
        if (t === undefined) throw new Error(`ENOENT /proc/${pid}/cgroup`);
        return t;
      },
      uid: UID,
      unitMainPid: (unit: string, manager: SystemdManager) => {
        asked.push(`${manager}:${unit}`);
        return o.mainPids?.[`${manager}:${unit}`] ?? null;
      },
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
    return Object.assign(d, { calls, asked });
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

  test("the MAIN process of a user unit that could not be proven is REFUSED with the systemctl command — never stopped and respawned", async () => {
    const serving: ServingTree = { kind: "unknown", reason: `systemd loads ${UNIT} from /etc/systemd/user/${UNIT}` };
    const d = deps({ serving, cgroups: { [PID]: IN_UNIT }, mainPids: { [`user:${UNIT}`]: PID } });
    await expect(restartOnLinux(d)).rejects.toThrow(`systemctl --user restart ${UNIT}`);
    await expect(restartOnLinux(d)).rejects.toThrow(`pid ${PID} is the main process of the systemd unit ${UNIT}`);
    expect(d.calls).toEqual([]);
  });

  test("the main process of a system-level service is refused with the root systemctl command", async () => {
    const d = deps({
      serving: { kind: "unknown", reason: "system-level" },
      cgroups: { [PID]: "0::/system.slice/flair.service\n" },
      mainPids: { "system:flair.service": PID },
    });
    await expect(restartOnLinux(d)).rejects.toThrow("systemctl restart flair.service (as root)");
    expect(d.calls).toEqual([]);
    expect(d.asked).toContain("system:flair.service");
  });

  test("a process INSIDE an unrelated service whose MainPID is another process (a CI runner agent's child) is restarted directly", async () => {
    const h = host({
      pid: PID,
      runs: OLD,
      fileNames: OLD,
      showText: null,
      cgroup: IN_RUNNER,
      shows: { [`system:${RUNNER_UNIT}`]: `MainPID=${RUNNER_PID}\nFragmentPath=/usr/lib/systemd/system/${RUNNER_UNIT}\nDropInPaths=\nWorkingDirectory=/\n` },
    });
    const serving = proveServingTree(h.probe);
    const d = deps({ serving, cgroups: { [PID]: IN_RUNNER }, mainPids: { [`system:${RUNNER_UNIT}`]: RUNNER_PID } });
    expect(await restartOnLinux(d)).toBe("direct");
    expect(d.calls).toEqual(["DIRECT stop+spawn"]);
    expect(d.asked).toEqual([`system:${RUNNER_UNIT}`]);
    // The same answer through the probe's own reader (the composition src/cli.ts uses).
    expect(
      planLinuxRestart({ serving, pids: [PID], procCgroup: () => IN_RUNNER, uid: UID, unitMainPid: h.probe.unitMainPid! }).kind,
    ).toBe("direct");
    // In this user's manager too: inside a user service (a multiplexer, a terminal) that is not its main process.
    for (const cgroup of [
      `0::/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/tmux.service\n`,
      `0::/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/${UNIT}/payload\n`,
    ]) {
      const unit = cgroup.includes("tmux") ? "tmux.service" : UNIT;
      const u = deps({ serving: { kind: "unknown", reason: "r" }, cgroups: { [PID]: cgroup }, mainPids: { [`user:${unit}`]: 4242 } });
      expect(await restartOnLinux(u)).toBe("direct");
      expect(u.asked).toEqual([`user:${unit}`]);
    }
  });

  test("a unit whose MainPID cannot be learned is REFUSED with the named command — never guessed either way", async () => {
    // systemd could not be asked
    const sys = deps({ serving: { kind: "unknown", reason: "r" }, cgroups: { [PID]: IN_RUNNER } });
    await expect(restartOnLinux(sys)).rejects.toThrow(`systemd did not report the MainPID of ${RUNNER_UNIT}`);
    await expect(restartOnLinux(sys)).rejects.toThrow(`systemctl restart ${RUNNER_UNIT} (as root)`);
    expect(sys.calls).toEqual([]);
    // systemd reports no main process
    const none = deps({ serving: { kind: "unknown", reason: "r" }, cgroups: { [PID]: IN_RUNNER }, mainPids: { [`system:${RUNNER_UNIT}`]: 0 } });
    await expect(restartOnLinux(none)).rejects.toThrow(`systemd reports no main process for ${RUNNER_UNIT}`);
    expect(none.calls).toEqual([]);
    // a user unit whose MainPID could not be read
    const user = deps({ serving: { kind: "unknown", reason: "r" }, cgroups: { [PID]: IN_UNIT } });
    await expect(restartOnLinux(user)).rejects.toThrow(`systemctl --user restart ${UNIT}`);
    expect(user.calls).toEqual([]);
    // another user's manager is never asked
    const other = deps({
      serving: { kind: "unknown", reason: "r" },
      cgroups: { [PID]: `0::/user.slice/user-1002.slice/user@1002.service/app.slice/${UNIT}\n` },
      mainPids: { [`user:${UNIT}`]: 4242 },
    });
    await expect(restartOnLinux(other)).rejects.toThrow("another user's systemd manager");
    expect(other.asked).toEqual([]);
    expect(other.calls).toEqual([]);
  });

  test("a CONTRADICTORY cgroup is REFUSED before any manager is asked — the direct path is never called (round 8)", async () => {
    for (const [name, cgroup] of Object.entries(CONTRADICTORY_CGROUPS)) {
      // Every manager answers another MainPID: for a consistent cgroup, the answer that licenses the direct path.
      const d = deps({ serving: { kind: "unknown", reason: "r" }, cgroups: { [PID]: cgroup }, mainPids: OTHER_MAIN_PIDS });
      let how: string | null = null;
      let message = "";
      try {
        how = await restartOnLinux(d);
      } catch (err) {
        message = (err as Error).message;
      }
      expect({ name, how, refused: message.includes("is contradictory"), calls: d.calls, asked: d.asked }).toEqual({
        name,
        how: null,
        refused: true,
        calls: [],
        asked: [],
      });
      // The same through the probe's own reader (the composition src/cli.ts uses).
      const shows = Object.fromEntries(Object.keys(OTHER_MAIN_PIDS).map((k) => [k, show(OTHER_PID, OLD)]));
      const h = host({ pid: PID, runs: OLD, fileNames: OLD, showText: show(OTHER_PID, OLD), cgroup, shows });
      const plan = planLinuxRestart({ serving: { kind: "unknown", reason: "r" }, pids: [PID], procCgroup: () => cgroup, uid: UID, unitMainPid: h.probe.unitMainPid! });
      expect({ name, plan: plan.kind, asked: h.calls.filter((c) => c.startsWith("show")) }).toEqual({ name, plan: "refuse", asked: [] });
    }
    // Control: the consistent path of the first case, with the same answer, is started directly — the contradiction
    // alone decides the refusal.
    const consistent = deps({ serving: { kind: "unknown", reason: "r" }, cgroups: { [PID]: IN_UNIT }, mainPids: OTHER_MAIN_PIDS });
    expect(await restartOnLinux(consistent)).toBe("direct");
    expect(consistent.calls).toEqual(["DIRECT stop+spawn"]);
  });

  test("a user manager whose uid is spelled differently from this user's (a leading zero) is another user's — never asked", async () => {
    const d = deps({
      serving: { kind: "unknown", reason: "r" },
      cgroups: { [PID]: `0::/user.slice/user-0${UID}.slice/user@0${UID}.service/app.slice/${UNIT}\n` },
      mainPids: OTHER_MAIN_PIDS,
    });
    await expect(restartOnLinux(d)).rejects.toThrow("another user's systemd manager");
    expect(d.asked).toEqual([]);
    expect(d.calls).toEqual([]);
  });

  test("unitSupervision and the MainPID parser", () => {
    const sysOwner = cgroupOwner(IN_RUNNER, UID) as Extract<CgroupOwner, { kind: "service" }>;
    expect(unitSupervision(PID, sysOwner, UID, () => PID)).toEqual({ kind: "main", unit: RUNNER_UNIT, manager: "system" });
    expect(unitSupervision(PID, sysOwner, UID, () => RUNNER_PID)).toEqual({ kind: "other", unit: RUNNER_UNIT, mainPid: RUNNER_PID });
    expect(unitSupervision(PID, sysOwner, UID, () => { throw new Error("no bus"); }).kind).toBe("unknown");
    expect(unitSupervision(PID, sysOwner, UID, undefined).kind).toBe("unknown");
    expect(mainPidFromShow("MainPID=812\nFragmentPath=/x\n")).toBe(812);
    expect(mainPidFromShow("MainPID=0\n")).toBe(0);
    for (const bad of ["", "FragmentPath=/x\n", "MainPID=\n", "MainPID=-1\n", "MainPID=12abc\n"]) expect(mainPidFromShow(bad)).toBeNull();
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
    expect(
      planLinuxRestart({ serving: { kind: "unknown", reason: "r" }, pids: [], procCgroup: () => IN_UNIT, uid: UID, unitMainPid: () => null }).kind,
    ).toBe("direct");
  });
});
