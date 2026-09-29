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
 *      written, the previous bytes are put back AND the manager is reloaded
 *      again, so the file and the manager agree on the previous unit. When that
 *      recovery itself fails, the result says exactly which state is left.
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
  /** After a successful reload: why the manager does not hold what was written, or null when it does. */
  verifyLoaded?: () => string | null;
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
  let firstReloadRan = false;
  try {
    opts.reload();
    firstReloadRan = true;
    failure = opts.verifyLoaded?.() ?? null;
  } catch (err) {
    failure = `the service manager could not reload it (${msg(err)})`;
  }
  if (failure === null) return { kind: "repointed", unitPath, detail: plan.detail };

  // Put the planned-from bytes back — only over the bytes flair itself wrote.
  try {
    const written = snapshotRegularFile(unitPath, { lstat: opts.atomic?.lstat, read: opts.atomic?.read });
    if (written.content !== plan.text) throw new Error(`${unitPath} was changed after flair wrote it`);
    writeFilesAtomically([{ path: unitPath, content: planned.content, mode: planned.mode, expect: written }], opts.atomic);
  } catch (err) {
    return {
      kind: "refused",
      unitPath,
      detail:
        `${unitPath} was re-pointed on disk, but ${failure}, and restoring its previous content failed (${msg(err)}). ` +
        `The file now holds the RE-POINTED unit; the service manager ${firstReloadRan ? "has loaded it" : "may still hold the previous definition"}. ` +
        "Check the file by hand, then run: systemctl --user daemon-reload",
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
        `service manager again failed (${msg(err)}): the file holds the previous unit, and the manager may still hold ` +
        "the re-pointed one. Run: systemctl --user daemon-reload",
    };
  }
  return {
    kind: "refused",
    unitPath,
    detail:
      `${unitPath} was not re-pointed: ${failure}. flair restored the file's previous content and reloaded the service ` +
      `manager, so both hold the previous unit again.${handEdit}`,
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
    planned = snapshotRegularFile(unitPath, { lstat: deps.atomic?.lstat, read: deps.atomic?.read });
  } catch (err) {
    return {
      kind: "refused",
      unitPath,
      detail: `${unitPath} is not re-pointed: ${msg(err)}; flair rewrites only a regular unit file in place. To move it, ${handEdit}`,
    };
  }
  const plan = planSystemdUnitRuntimeRepoint(planned.content, serving.unitTree ?? serving.dir, targets, deps.repoint, unitPath);
  return applyRepointPlan(plan, planned, {
    dryRun: opts.dryRun,
    atomic: deps.atomic,
    reload: deps.reload,
    handEdit: `To move it, ${handEdit}`,
    verifyLoaded: () => {
      const st = deps.unitState(serving.unitName);
      if (!st) return `systemd did not report ${serving.unitName} after the reload`;
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
