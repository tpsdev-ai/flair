/**
 * service-repoint-apply.ts — commit a re-point plan to an operator's unit file
 * (flair#2034 §2).
 *
 * The planners in service-repoint.ts are pure. This module is where a plan
 * meets the file and the service manager, and it holds three rules:
 *
 *   1. A plan is written only over the file it was PLANNED FROM: the file was
 *      read as a regular file (never through a symlink), and immediately before
 *      the rename it is re-checked — same file, same bytes — or nothing is
 *      written (atomic-write.ts, `expect`).
 *   2. systemd: after the write, the manager is reloaded and asked what it now
 *      holds for the unit (the file it loaded, its drop-ins, its working
 *      directory). When the reload fails or the manager does not hold what was
 *      written, the previous bytes are put back, the manager is reloaded again
 *      and ASKED AGAIN. That query compares three fields — FragmentPath,
 *      drop-ins, WorkingDirectory — with the values captured before the write;
 *      when they are back, the result says exactly that, and still calls full
 *      agreement between the restored file and the manager unverified (three
 *      fields are not the whole unit). Anything short of that — a failed
 *      restore, a failed second reload, a different or missing answer — is
 *      reported with the manager's state as UNVERIFIED.
 *   3. Linux: a unit with drop-ins — any the manager reports, from any
 *      location, or a `<unit>.d` directory beside the file — is refused, and
 *      so is one whose MainPID, asked again immediately before the write, is
 *      not the serving process the unit was proven to run.
 *   4. `flair restart` on Linux (restartOnLinux): a proven user unit is
 *      restarted through systemd and its new main process verified; a process
 *      that is the main process of any other systemd unit is never stopped and
 *      respawned outside it.
 *
 * Every filesystem and service-manager call is injectable, so each branch is
 * driven by a test with no real launchd, systemd or operator file.
 */
import { snapshotRegularFile, writeFilesAtomically, type AtomicWriteHooks, type FileSnapshot } from "./atomic-write.js";
import { planSystemdUnitRuntimeRepoint, type RepointDeps, type RepointPlan, type RepointTargets } from "./service-repoint.js";
import {
  planLinuxRestart,
  restartedUnitProblem,
  type ProvenServingTree,
  type ServingTree,
  type SystemdManager,
  type SystemdUnitManagerState,
} from "./tree-divergence.js";

export type MainServiceRepointResult =
  | { kind: "repointed" | "would-repoint" | "current" | "pinned-node"; unitPath: string; detail: string }
  | { kind: "not-applicable"; detail: string }
  | { kind: "refused"; unitPath?: string; detail: string };

export interface ApplyRepointOptions {
  dryRun?: boolean;
  /** Filesystem hooks for the write, the re-check and the restore (tests inject failures here). */
  atomic?: AtomicWriteHooks;
  /** systemd: reload the manager (`systemctl --user daemon-reload`). Throws on failure. */
  reload?: () => void;
  /**
   * After a reload, ask the manager: why it does not hold the `planned` unit
   * (after the write) or the `previous` one (after a restore, compared with the
   * state captured before the write) — or null when it does.
   */
  verifyLoaded?: (want: "planned" | "previous") => string | null;
  /** The hand-edit remedy appended to a refusal that leaves the previous unit in place. */
  handEdit?: string;
}

function msg(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

/** Apply `plan`, which was computed from `planned` (see the module header). */
export function applyRepointPlan(plan: RepointPlan, planned: FileSnapshot, opts: ApplyRepointOptions = {}): MainServiceRepointResult {
  const unitPath = planned.path;
  switch (plan.kind) {
    case "current":
    case "pinned-node":
      return { kind: plan.kind, unitPath, detail: plan.detail };
    case "refuse":
      return { kind: "refused", unitPath, detail: plan.detail };
    case "repoint":
      break;
  }
  if (opts.dryRun) return { kind: "would-repoint", unitPath, detail: plan.detail.replace(/^re-pointed/, "would re-point") };
  const handEdit = opts.handEdit ? ` ${opts.handEdit}` : "";

  try {
    writeFilesAtomically([{ path: unitPath, content: plan.text, mode: planned.mode, expect: planned }], opts.atomic);
  } catch (err) {
    return {
      kind: "refused",
      unitPath,
      detail: `${unitPath} was not re-pointed: ${msg(err)}. Re-run the command to plan again from the file as it is now.${handEdit}`,
    };
  }
  if (!opts.reload) return { kind: "repointed", unitPath, detail: plan.detail };

  let failure: string | null = null;
  try {
    opts.reload();
    failure = opts.verifyLoaded?.("planned") ?? null;
  } catch (err) {
    failure = `the service manager could not reload it (${msg(err)})`;
  }
  if (failure === null) return { kind: "repointed", unitPath, detail: plan.detail };
  const unverified = "Run: systemctl --user daemon-reload, then check the unit with systemctl --user show.";

  // Put the planned-from bytes back — only over the bytes flair itself wrote.
  try {
    const written = snapshotRegularFile(unitPath, { lstat: opts.atomic?.lstat, readBytes: opts.atomic?.readBytes });
    if (written.content !== plan.text) throw new Error(`${unitPath} was changed after flair wrote it`);
    writeFilesAtomically([{ path: unitPath, content: planned.content, mode: planned.mode, expect: written }], opts.atomic);
  } catch (err) {
    return {
      kind: "refused",
      unitPath,
      detail:
        `${unitPath} was re-pointed on disk, but ${failure}, and restoring its previous content failed (${msg(err)}). ` +
        "The file holds the RE-POINTED unit flair wrote (or, if it was changed after that write, the change); which " +
        `unit the service manager holds is UNVERIFIED. Check the file by hand. ${unverified}`,
    };
  }
  try {
    opts.reload();
  } catch (err) {
    return {
      kind: "refused",
      unitPath,
      detail:
        `${unitPath} was not re-pointed: ${failure}. flair restored the file's previous content, but reloading the ` +
        `service manager again failed (${msg(err)}): the file holds the previous unit; which unit the manager holds is ` +
        `UNVERIFIED. ${unverified}`,
    };
  }
  let back: string | null;
  try {
    back = opts.verifyLoaded ? opts.verifyLoaded("previous") : "flair cannot query this service manager";
  } catch (err) {
    back = `the service manager could not be queried (${msg(err)})`;
  }
  if (back !== null) {
    return {
      kind: "refused",
      unitPath,
      detail:
        `${unitPath} was not re-pointed: ${failure}. flair restored the file's previous content and reloaded the ` +
        "service manager, but the manager does not report the FragmentPath, drop-ins and WorkingDirectory captured " +
        `before the write (${back}): the file holds the previous unit; which unit the manager holds is UNVERIFIED. ${unverified}`,
    };
  }
  return {
    kind: "refused",
    unitPath,
    detail:
      `${unitPath} was not re-pointed: ${failure}. flair restored the file's previous content and reloaded the service ` +
      "manager; the manager's FragmentPath, drop-ins and WorkingDirectory are back at the values captured before the " +
      "write. Only those three fields were checked, so full agreement between the restored file and what the manager " +
      `loaded is unverified.${handEdit}`,
  };
}

export interface SystemdRepointDeps {
  /** Path facts for the planner. */
  repoint: RepointDeps;
  exists: (p: string) => boolean;
  /** `systemctl --user show` for a unit, parsed; null when it could not be read. */
  unitState: (unitName: string) => SystemdUnitManagerState | null;
  /** `systemctl --user daemon-reload`; throws on failure. */
  reload: () => void;
  atomic?: AtomicWriteHooks;
}

/**
 * Re-point the systemd USER unit proven to own the serving process (Linux).
 * Refuses drop-ins and anything that is not a regular unit file; plans from the
 * snapshot; after the reload, requires the manager to report the same file, no
 * drop-ins, and the new working directory — else restores (see applyRepointPlan).
 */
export function repointSystemdUserUnit(
  serving: ProvenServingTree,
  targets: RepointTargets,
  deps: SystemdRepointDeps,
  opts: { dryRun?: boolean } = {},
): MainServiceRepointResult {
  const unitPath = serving.unitPath;
  const handEdit =
    `point its node, Harper entry${targets.launcher ? ", launcher (if it runs one)" : ""} and WorkingDirectory at ` +
    `${targets.workingDirectory} by hand, then run: flair restart`;
  if (serving.dropInPaths.length > 0) {
    return {
      kind: "refused",
      unitPath,
      detail:
        `systemd applies drop-ins to ${serving.unitName} (${serving.dropInPaths.join(", ")}), and a drop-in can set ` +
        `ExecStart= or WorkingDirectory=, so flair does not re-point it. To move it, ${handEdit}`,
    };
  }
  if (deps.exists(`${unitPath}.d`)) {
    return {
      kind: "refused",
      unitPath,
      detail:
        `${unitPath}.d exists and can hold drop-ins that set ExecStart= or WorkingDirectory=, so flair does not ` +
        `re-point the unit. To move it, ${handEdit}`,
    };
  }
  let planned: FileSnapshot;
  try {
    planned = snapshotRegularFile(unitPath, { lstat: deps.atomic?.lstat, readBytes: deps.atomic?.readBytes });
  } catch (err) {
    return {
      kind: "refused",
      unitPath,
      detail: `${unitPath} is not re-pointed: ${msg(err)}; flair rewrites only a regular unit file in place. To move it, ${handEdit}`,
    };
  }
  const plan = planSystemdUnitRuntimeRepoint(planned.content, serving.unitTree ?? serving.dir, targets, deps.repoint, unitPath);
  // Capture what the manager holds BEFORE writing: a restore is confirmed
  // against it. When it cannot be read, a failed reload could never be
  // verified, so nothing is written. The same answer must still name the
  // serving process as the unit's MainPID.
  let before: SystemdUnitManagerState | null = null;
  if (plan.kind === "repoint" && !opts.dryRun) {
    before = deps.unitState(serving.unitName);
    if (!before || before.fragmentPath === null || !deps.repoint.samePath(before.fragmentPath, unitPath) || before.dropInPaths.length > 0) {
      return {
        kind: "refused",
        unitPath,
        detail:
          `${unitPath} is not re-pointed: systemd ${before ? `reports ${serving.unitName} from ${before.fragmentPath ?? "no file"} with drop-ins [${before.dropInPaths.join(", ")}]` : `did not report ${serving.unitName}`}, ` +
          `so the state to restore to cannot be captured. To move it, ${handEdit}`,
      };
    }
    // The write rests on the proof that this unit runs the serving process (its
    // MainPID). A fresh answer naming another main process, or none, contradicts
    // that proof, so nothing is written.
    if (before.mainPid !== serving.pid) {
      return {
        kind: "refused",
        unitPath,
        detail:
          `${unitPath} is not re-pointed: systemd now reports ` +
          `${before.mainPid === null ? "no main process" : `pid ${before.mainPid} as the main process`} ` +
          `of ${serving.unitName}, ` +
          `not the serving process (pid ${serving.pid}) it was proven to run, so the unit is not shown to run this ` +
          `instance. Run \`flair status\` to see which process serves it, then re-run the command. To move it, ${handEdit}`,
      };
    }
  }
  const same = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : deps.repoint.samePath(a, b));
  return applyRepointPlan(plan, planned, {
    dryRun: opts.dryRun,
    atomic: deps.atomic,
    reload: deps.reload,
    handEdit: `To move it, ${handEdit}`,
    verifyLoaded: (want) => {
      const st = deps.unitState(serving.unitName);
      if (!st) return `systemd did not report ${serving.unitName} after the reload`;
      if (want === "previous") {
        const was = before!;
        if (
          !same(st.fragmentPath, was.fragmentPath) ||
          st.dropInPaths.join("\n") !== was.dropInPaths.join("\n") ||
          !same(st.workingDirectory, was.workingDirectory)
        ) {
          return (
            `systemd reports ${serving.unitName} from ${st.fragmentPath ?? "no file"}, drop-ins [${st.dropInPaths.join(", ")}], ` +
            `WorkingDirectory ${st.workingDirectory ?? "(none)"}; before the write it was ${was.fragmentPath}, drop-ins [], ` +
            `WorkingDirectory ${was.workingDirectory ?? "(none)"}`
          );
        }
        return null;
      }
      if (st.fragmentPath === null || !deps.repoint.samePath(st.fragmentPath, unitPath)) {
        return `after the reload systemd loads ${serving.unitName} from ${st.fragmentPath ?? "no file"}, not ${unitPath}`;
      }
      if (st.dropInPaths.length > 0) {
        return `after the reload systemd applies drop-ins to ${serving.unitName} (${st.dropInPaths.join(", ")})`;
      }
      if (st.workingDirectory === null || !deps.repoint.samePath(st.workingDirectory, targets.workingDirectory)) {
        return `after the reload systemd reports WorkingDirectory ${st.workingDirectory ?? "(none)"}, not ${targets.workingDirectory}`;
      }
      return null;
    },
  });
}

export interface LinuxRestartDeps {
  serving: ServingTree;
  /** The processes the direct path could stop: the live PID-file PID and the port's listeners. */
  pids: number[];
  procCgroup: (pid: number) => string;
  uid: number;
  /** The MainPID a manager reports for a unit (0: no main process), or null when it could not be asked. */
  unitMainPid: (unitName: string, manager: SystemdManager) => number | null;
  /** Run `systemctl <args>`; throws on failure. */
  systemctl: (args: string[]) => void;
  /** Wait until the instance answers again. */
  waitHealthy: () => Promise<void>;
  unitState: (unitName: string) => SystemdUnitManagerState | null;
  /** The resolved working directory of a live process, or null. */
  cwdOf: (pid: number) => string | null;
  samePath: (a: string, b: string) => boolean;
  /** Checks to run before a systemd restart (the engine-version guard). */
  beforeRestart?: (serving: ProvenServingTree) => void;
  /** The direct path: stop by signal, spawn again. */
  direct: () => Promise<void>;
  log?: (line: string) => void;
}

/**
 * `flair restart` on Linux (see planLinuxRestart). A proven user unit is
 * restarted THROUGH systemd and its new main process must run from the unit's
 * WorkingDirectory; a process that is the main process (MainPID) of any other
 * systemd unit is refused, never stopped and respawned outside its manager, and
 * so is one whose cgroup or unit MainPID cannot be read. A process no unit
 * supervises — none in its cgroup, or one whose MainPID is another process —
 * takes the direct path.
 */
export async function restartOnLinux(d: LinuxRestartDeps): Promise<"systemd" | "direct"> {
  const plan = planLinuxRestart({
    serving: d.serving,
    pids: d.pids,
    procCgroup: d.procCgroup,
    uid: d.uid,
    unitMainPid: d.unitMainPid,
  });
  if (plan.kind === "refuse") throw new Error(plan.detail);
  if (plan.kind === "direct") {
    await d.direct();
    return "direct";
  }
  const s = d.serving as ProvenServingTree;
  d.beforeRestart?.(s);
  d.log?.(`  (restarting through the systemd user unit that runs this instance: ${plan.unit})`);
  d.systemctl(["--user", "daemon-reload"]);
  d.systemctl(["--user", "restart", plan.unit]);
  await d.waitHealthy();
  const problem = restartedUnitProblem(plan.unit, s.pid, d.unitState(plan.unit), d.cwdOf, d.samePath);
  if (problem) throw new Error(`restarted ${plan.unit} through systemd, but ${problem}`);
  return "systemd";
}
