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
 *      location, or a `<unit>.d` directory beside the file — is refused.
 *
 * Every filesystem and service-manager call is injectable, so each branch is
 * driven by a test with no real launchd, systemd or operator file.
 */
import { snapshotRegularFile, writeFilesAtomically, type AtomicWriteHooks, type FileSnapshot } from "./atomic-write.js";
import { planSystemdUnitRuntimeRepoint, type RepointDeps, type RepointPlan, type RepointTargets } from "./service-repoint.js";
import type { ProvenServingTree, SystemdUnitManagerState } from "./tree-divergence.js";

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
  // verified, so nothing is written.
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
