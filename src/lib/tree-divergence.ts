/**
 * tree-divergence.ts — "the CLI you ran and the instance you are talking to do
 * not live in the same install tree" (flair#2034 §2).
 *
 * After a Node bump a service unit can keep serving the install tree of the
 * runtime it was baked at, while the CLI on PATH comes from the tree of the
 * runtime in use now. `flair status` then printed two hints that pointed at
 * each other, and `flair upgrade` reported about a tree that was not the one
 * serving. This module is the one shared answer to "which tree serves this
 * instance, and does it match this CLI".
 *
 * PROOF, NOT INFERENCE. A unit file on disk says what a service manager WOULD
 * run; it does not say what is serving. The serving tree is only reported when
 * a service manager is shown to own the very process that answers:
 *
 *   - macOS: the launchd plist for THIS data directory (its ROOTPATH is this
 *     data dir) has a running job whose PID is the serving PID;
 *   - Linux: a systemd USER unit that names the serving tree has that PID as
 *     its MainPID, and systemd reports that very file as the unit's
 *     FragmentPath (the file it loaded, not another file of the same name).
 *
 * The serving PID is the process that ANSWERED (see identifyAnsweringPid): the
 * one process listening on the instance's port, which must also be the PID the
 * answering process reported about itself (`/HealthDetail`'s `pid`) when there
 * is one. Harper's `hdb.pid` is never the answer on its own — it is a
 * cross-check. Any disagreement, more than one listener, or nobody listening is
 * UNKNOWN (a stale or reused PID file, a second instance on the port), never a
 * guess. The tree is read from
 * that process (its working directory / command line), never from the unit.
 *
 * Without that proof — a remote target, a directly started server, a
 * system-level or unrelated supervisor, a server run under a different HOME —
 * the tree is UNKNOWN, and no remedy is derived from it.
 *
 * Everything here is pure: the probe hands in every filesystem, process and
 * service-manager read, so the whole decision is unit-testable without a real
 * launchd, systemd or running instance.
 */
import { resolve } from "node:path";
import semver from "semver";
import { classifyServiceNodePin, readPlistProgramRefs, type NodePinDeps, type ServiceNodePin } from "./launchd-management.js";
import { unescapeXml } from "./xml-escape.js";

export interface PackageLocation {
  dir: string;
  version: string | null;
}

export type ServiceManagerKind = "launchd" | "systemd-user";

export interface ProvenServingTree {
  kind: "proven";
  /** The install tree the serving process runs from (read from the process). */
  dir: string;
  /** The version declared by that tree's package.json (what is on disk there). */
  version: string | null;
  pid: number;
  manager: ServiceManagerKind;
  unitName: string;
  unitPath: string;
  /** The node binary the unit names now (null when drop-ins make the unit file alone not authoritative). */
  unitNodeBin: string | null;
  /** The install tree the unit names now (may differ from `dir` after a re-point that is not yet restarted). */
  unitTree: string | null;
  /** systemd: the drop-in files the manager applies to the unit (never re-pointed while any exist). [] for launchd. */
  dropInPaths: string[];
}

/** What this host knows locally about which process serves the data dir. */
export interface LocalPidEvidence {
  /** The PID in the data dir's Harper PID file, when that process is alive; null otherwise. */
  pidFile: number | null;
  /** The distinct PIDs listening on the instance's port; null when they could not be read. */
  listeners: number[] | null;
}

/** A systemd user unit as its manager reports it (`systemctl --user show`). */
export interface SystemdUnitManagerState {
  mainPid: number | null;
  /** The unit file systemd loaded. */
  fragmentPath: string | null;
  /** Every drop-in systemd applies to the unit, from any location. */
  dropInPaths: string[];
  /** The WorkingDirectory systemd holds for the unit (a leading `!` removed), or null. */
  workingDirectory: string | null;
}

export interface UnknownServingTree {
  kind: "unknown";
  reason: string;
}

export type ServingTree = ProvenServingTree | UnknownServingTree;

export interface ServingTreeProbe {
  platform: NodeJS.Platform;
  /** False when the queried instance is not this host's local instance for `dataDir`. */
  local: boolean;
  /** What was queried, for messages. */
  queryUrl: string;
  dataDir: string;
  /** The PID the answering process reported about itself, when known. */
  respondingPid?: number | null;
  /** This data dir's live PID-file PID and the port's listeners (see identifyAnsweringPid). */
  localPids: () => LocalPidEvidence;
  /** macOS: this data dir's launchd label and plist path. */
  launchd?: { label: string; plistPath: string };
  /** macOS: the running PID of a launchd job, or null when it is not loaded / not running. */
  launchdJobPid?: (label: string) => number | null;
  /** Linux: systemd USER units that name `tree` in WorkingDirectory/ExecStart. */
  findUserUnitsForTree?: (tree: string) => Array<{ name: string; path: string }>;
  /** Linux: a user unit as the manager reports it, or null when it could not be read. */
  systemdUserUnit?: (unitName: string) => SystemdUnitManagerState | null;
  /** The @tpsdev-ai/flair package a live PID runs from, or null. */
  servingPackage: (pid: number) => PackageLocation | null;
  exists: (p: string) => boolean;
  read: (p: string) => string;
  /** Path equality for the FragmentPath check — callers pass a realpath-based comparison. */
  samePath?: (a: string, b: string) => boolean;
}

function unknown(reason: string): UnknownServingTree {
  return { kind: "unknown", reason };
}

/**
 * The process that answered for this instance — or why it cannot be named.
 *
 * The listener result decides first, and the reported PID (what the answering
 * process said about itself) must agree with it:
 *
 *   - exactly one listening PID: the answer — and a reported PID must equal it;
 *   - more than one listening PID, or NONE (an empty result means nobody is
 *     listening, never "could not read"): unknown, whatever was reported;
 *   - the listeners could not be read at all (lsof missing or failing): the
 *     reported PID stands on its own — it is the answering process's own
 *     report — and without one the answer is unknown.
 *
 * A live PID-file PID that is not the answer — a stale file whose PID was
 * reused, a second instance — makes it unknown too: a conflict is never
 * resolved by picking a side.
 */
export function identifyAnsweringPid(
  respondingPid: number | null | undefined,
  evidence: LocalPidEvidence,
): { pid: number } | { reason: string } {
  const listeners = evidence.listeners === null ? null : [...new Set(evidence.listeners)];
  const pidFile = evidence.pidFile;
  const reported =
    typeof respondingPid === "number" && Number.isInteger(respondingPid) && respondingPid > 0 ? respondingPid : null;
  if (listeners !== null && listeners.length === 0) return { reason: "no process is listening on the instance's port" };
  if (listeners !== null && listeners.length > 1) {
    return { reason: `more than one process listens on the instance's port (pids ${listeners.join(", ")})` };
  }
  const listener = listeners === null ? null : listeners[0]!;
  if (reported !== null && listener !== null && reported !== listener) {
    return {
      reason:
        `the process that answered (pid ${reported}) is not the one listening on the instance's port (pid ${listener})`,
    };
  }
  const pid = listener ?? reported;
  if (pid === null) {
    return { reason: "the process listening on the instance's port could not be read, and the instance reported no pid" };
  }
  if (pidFile !== null && pidFile !== pid) {
    return {
      reason:
        `the process ${listener !== null ? "listening on the instance's port" : "that answered"} (pid ${pid}) is not ` +
        `the one this data directory's PID file names (pid ${pidFile}), so which one serves this data directory is not proven`,
    };
  }
  return { pid };
}

/** Parse `systemctl show -p A -p B …` output (`Key=value` lines) into a map. */
export function parseSystemctlShow(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/**
 * A user unit's manager state from `systemctl --user show <unit> -p MainPID
 * -p FragmentPath -p DropInPaths -p WorkingDirectory`. null when a property is
 * missing — an unreadable answer is not an empty one.
 */
export function systemdUnitStateFromShow(text: string): SystemdUnitManagerState | null {
  const kv = parseSystemctlShow(text);
  for (const key of ["MainPID", "FragmentPath", "DropInPaths", "WorkingDirectory"]) {
    if (!(key in kv)) return null;
  }
  const pid = Number(kv.MainPID);
  const wd = kv.WorkingDirectory!.trim().replace(/^!/, "");
  return {
    mainPid: Number.isInteger(pid) && pid > 0 ? pid : null,
    fragmentPath: kv.FragmentPath!.trim() === "" ? null : kv.FragmentPath!.trim(),
    dropInPaths: kv.DropInPaths!.trim() === "" ? [] : kv.DropInPaths!.trim().split(/\s+/),
    workingDirectory: wd === "" ? null : wd,
  };
}

/** The node binary and working directory an active systemd `[Service]` section names. */
export function readSystemdServiceRefs(text: string): { nodeBin: string | null; workingDirectory: string | null } {
  let section = "";
  let workingDirectory: string | null = null;
  let nodeBin: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      section = line.slice(1).replace(/\].*$/, "").trim().toLowerCase();
      continue;
    }
    if (section !== "service") continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "WorkingDirectory") {
      workingDirectory = value === "" ? null : value.replace(/^-/, "");
    } else if (key === "ExecStart") {
      if (value === "") { nodeBin = null; continue; }
      for (const word of value.replace(/^[-@:+!]+/, "").split(/\s+/)) {
        if (word.startsWith("/") && /(^|\/)node$/.test(word)) { nodeBin = word; break; }
      }
    }
  }
  return { nodeBin, workingDirectory };
}

function plistRootPath(raw: string): string | null {
  const m = /<key>ROOTPATH<\/key>\s*<string>([^<]*)<\/string>/.exec(raw);
  return m ? unescapeXml(m[1]!) : null;
}

/**
 * Which install tree serves the queried instance — or UNKNOWN, with the reason,
 * when no service manager is shown to own the answering process.
 */
export function proveServingTree(p: ServingTreeProbe): ServingTree {
  if (!p.local) {
    return unknown(
      `${p.queryUrl} is not this data directory's local instance (a remote target, or another port), so its install ` +
        "tree cannot be proven from here",
    );
  }

  const samePath = p.samePath ?? ((a: string, b: string) => resolve(a) === resolve(b));
  const answering = (): { pid: number } | { reason: string } => {
    let evidence: LocalPidEvidence;
    try {
      evidence = p.localPids();
    } catch {
      evidence = { pidFile: null, listeners: null };
    }
    return identifyAnsweringPid(p.respondingPid, evidence);
  };

  if (p.platform === "darwin") {
    const ld = p.launchd;
    if (!ld || !p.exists(ld.plistPath)) {
      return unknown(
        `no launchd service is registered for this data directory${ld ? ` (${ld.plistPath})` : ""}, so nothing proves ` +
          "which install tree serves this instance (it was started directly, by another supervisor, or is not running)",
      );
    }
    let raw: string;
    try {
      raw = p.read(ld.plistPath);
    } catch (err) {
      return unknown(`the launchd plist ${ld.plistPath} could not be read (${(err as Error)?.message ?? err})`);
    }
    const root = plistRootPath(raw);
    if (root === null || resolve(root) !== resolve(p.dataDir)) {
      return unknown(`the launchd plist ${ld.plistPath} is not registered to this data directory (${resolve(p.dataDir)})`);
    }
    const jobPid = p.launchdJobPid?.(ld.label) ?? null;
    if (jobPid === null) {
      return unknown(`launchd is not running the job ${ld.label}, so the instance answering was not started by it`);
    }
    const who = answering();
    if ("reason" in who) return unknown(`the process serving this instance could not be identified: ${who.reason}`);
    const pid = who.pid;
    if (pid !== jobPid) {
      return unknown(
        `the process serving this instance (pid ${pid}) is not launchd's job ${ld.label} (pid ${jobPid}) — it was started ` +
          "directly, by another supervisor, or under a different HOME",
      );
    }
    const pkg = p.servingPackage(pid);
    if (!pkg) return unknown(`the install tree of the serving process (pid ${pid}) could not be read`);
    const refs = readPlistProgramRefs(ld.plistPath, () => raw);
    const unitNodeBin = refs?.programArguments.find((a) => a.startsWith("/") && /(^|[/\\])node$/.test(a)) ?? null;
    return {
      kind: "proven",
      dir: pkg.dir,
      version: pkg.version,
      pid,
      manager: "launchd",
      unitName: ld.label,
      unitPath: ld.plistPath,
      unitNodeBin,
      unitTree: refs?.workingDirectory ?? null,
      dropInPaths: [],
    };
  }

  if (p.platform === "linux") {
    const who = answering();
    if ("reason" in who) return unknown(`the process serving this instance could not be identified: ${who.reason}`);
    const pid = who.pid;
    const pkg = p.servingPackage(pid);
    if (!pkg) return unknown(`the install tree of the serving process (pid ${pid}) could not be read`);
    const units = p.findUserUnitsForTree?.(pkg.dir) ?? [];
    const notLoaded: string[] = [];
    for (const u of units) {
      const state = p.systemdUserUnit?.(u.name) ?? null;
      if (!state || state.mainPid !== pid) continue;
      // The PID belongs to the unit NAME; only the file systemd actually loaded
      // for that name is proof about this file.
      if (state.fragmentPath === null || !samePath(state.fragmentPath, u.path)) {
        notLoaded.push(`systemd loads ${u.name} from ${state.fragmentPath ?? "no file"}, not ${u.path}`);
        continue;
      }
      let refs: { nodeBin: string | null; workingDirectory: string | null } = { nodeBin: null, workingDirectory: null };
      // With drop-ins, the unit file alone does not say what systemd runs.
      if (state.dropInPaths.length === 0) {
        try {
          refs = readSystemdServiceRefs(p.read(u.path));
        } catch { /* the proof is the MainPID + FragmentPath; the refs are detail */ }
      }
      return {
        kind: "proven",
        dir: pkg.dir,
        version: pkg.version,
        pid,
        manager: "systemd-user",
        unitName: u.name,
        unitPath: u.path,
        unitNodeBin: refs.nodeBin,
        unitTree: refs.workingDirectory,
        dropInPaths: state.dropInPaths,
      };
    }
    if (notLoaded.length > 0) {
      return unknown(`the serving process (pid ${pid}) belongs to a systemd user unit, but ${notLoaded.join("; ")}`);
    }
    return unknown(
      `no systemd user unit that names ${pkg.dir} owns the serving process (pid ${pid}) — it was started directly, ` +
        "by a system-level unit, or by another supervisor",
    );
  }

  return unknown(`${p.platform} has no service manager flair can check`);
}

/**
 * True for a tree `npm i -g` installed under some Node runtime's global prefix
 * (`<prefix>/lib/node_modules/@tpsdev-ai/flair`) — the tree a Node bump leaves
 * behind. A plain extracted tree or a checkout is a deliberate deployment and
 * is never re-pointed.
 */
export function isNpmGlobalFlairTree(dir: string): boolean {
  return /[/\\]lib[/\\]node_modules[/\\]@tpsdev-ai[/\\]flair[/\\]?$/.test(dir);
}

/** True for a strict semver version exactly as written (no leading "v", no spaces, no build metadata). */
export function isExactSemver(v: string | null): v is string {
  return typeof v === "string" && semver.valid(v) === v;
}

/**
 * Semver ordering (prereleases included: 0.57.0-beta.1 < 0.57.0): <0, 0, >0 —
 * or null when either side is not an exact semver version. Callers that guard
 * a downgrade treat null as "cannot rule it out" and refuse.
 */
export function compareVersions(a: string, b: string): number | null {
  if (!isExactSemver(a) || !isExactSemver(b)) return null;
  return semver.compare(a, b);
}

/**
 * - `same`      — proven, and the serving tree IS this CLI's tree.
 * - `diverged`  — proven, a different npm-global tree serves: the Node-bump
 *                 case. `flair init && flair restart` re-points it.
 * - `separate`  — proven, a different tree serves that is NOT an npm-global
 *                 install (a plain tree, a checkout): deliberate, never re-pointed.
 * - `unknown`   — no proof; nothing is advised from it.
 */
export type TreeState = "same" | "diverged" | "separate" | "unknown";

export interface TreeAssessment {
  state: TreeState;
  cli: PackageLocation;
  serving: ServingTree;
  /** The version the running process reports, when it could be read. */
  runningVersion: string | null;
  /** Diverged only: the unit already names this CLI's tree (re-pointed, not yet restarted). */
  restartPending: boolean;
  /** Diverged only: this CLI's tree carries an OLDER flair than the instance runs. */
  cliOlder: boolean;
  /** The unit's node pin, when it names a different runtime than this CLI's. */
  nodePin: ServiceNodePin | null;
}

function defaultSamePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

export function assessTreeDivergence(input: {
  cli: PackageLocation;
  serving: ServingTree;
  runningVersion?: string | null;
  currentNodeBin: string;
  /** Path equality; callers pass a realpath-based comparison. */
  samePath?: (a: string, b: string) => boolean;
  nodePinDeps?: NodePinDeps;
}): TreeAssessment {
  const samePath = input.samePath ?? defaultSamePath;
  const runningVersion = input.runningVersion ?? null;
  const base = { cli: input.cli, serving: input.serving, runningVersion, restartPending: false, cliOlder: false, nodePin: null };
  const s = input.serving;
  if (s.kind === "unknown") return { ...base, state: "unknown" };

  const nodePin = classifyServiceNodePin(
    {
      unitDescription: describeUnit(s),
      unitNodeBin: s.unitNodeBin,
      unitTree: s.unitTree,
      currentNodeBin: input.currentNodeBin,
      cliTree: input.cli.dir,
    },
    input.nodePinDeps,
  );
  if (samePath(input.cli.dir, s.dir)) return { ...base, state: "same", nodePin };
  if (!isNpmGlobalFlairTree(s.dir)) return { ...base, state: "separate", nodePin };

  return withRunningVersion(
    {
      ...base,
      state: "diverged",
      nodePin,
      restartPending: s.unitTree !== null && samePath(s.unitTree, input.cli.dir),
    },
    runningVersion,
  );
}

/**
 * The assessment with the running process's version filled in (read after the
 * proof, so a version probe is only spent when a tree was proven). `cliOlder`
 * compares this CLI with the code the instance RUNS, falling back to the
 * version on disk in the serving tree when the running one is unknown.
 */
export function withRunningVersion(a: TreeAssessment, runningVersion: string | null): TreeAssessment {
  const servingCodeVersion = runningVersion ?? (a.serving.kind === "proven" ? a.serving.version : null);
  return {
    ...a,
    runningVersion,
    cliOlder:
      a.state === "diverged" &&
      a.cli.version !== null &&
      servingCodeVersion !== null &&
      (compareVersions(a.cli.version, servingCodeVersion) ?? 0) < 0,
  };
}

export function describeUnit(s: ProvenServingTree): string {
  return s.manager === "launchd"
    ? `the launchd service ${s.unitName} (${s.unitPath})`
    : `the systemd user unit ${s.unitName} (${s.unitPath})`;
}

/**
 * Diverged, but `flair init` will not re-point this unit: systemd applies
 * drop-ins to it, and a drop-in can set ExecStart= / WorkingDirectory= that the
 * unit file does not show. The remedy is then a hand edit, never `flair init`.
 */
export function manualRepointReason(a: TreeAssessment): string | null {
  const s = a.serving;
  if (a.state !== "diverged" || s.kind !== "proven" || s.manager !== "systemd-user" || s.dropInPaths.length === 0) return null;
  return `systemd applies drop-ins to ${s.unitName} (${s.dropInPaths.join(", ")}), so flair does not re-point it`;
}

function v(version: string | null): string {
  return version ? `flair ${version}` : "flair version unknown";
}

function relation(version: string | null, latest: string): string {
  if (!version) return "unknown";
  const c = compareVersions(version, latest);
  return c === null ? "unknown" : c === 0 ? "current" : c < 0 ? "behind" : "ahead";
}

export interface TreeLinesOptions {
  /** Latest published version, when known — adds the currency line. */
  latest?: string | null;
  /** `upgrade` adds what `flair upgrade` does and does not change. */
  context?: "status" | "doctor" | "upgrade" | "restart";
}

/**
 * The operator-facing block for a `diverged` or `separate` assessment. Names the
 * ACTOR (the CLI, the instance and the unit that owns it), the STATE (both
 * trees, both versions, "unknown" where a version could not be read) and the
 * REMEDY. Returns [] for `same` and `unknown` — see formatServingTreeLine.
 */
export function formatTreeAssessmentLines(a: TreeAssessment, opts: TreeLinesOptions = {}): string[] {
  if (a.serving.kind !== "proven") return [];
  const s = a.serving;
  if (a.state === "separate") {
    return [
      `ℹ  The instance serves from ${s.dir} (running ${v(a.runningVersion)}; pid ${s.pid}, ${describeUnit(s)}),`,
      `   not from this CLI's tree ${a.cli.dir} (${v(a.cli.version)}). It is not an npm-global install, so flair treats it`,
      "   as a separately managed deployment and never re-points it. If it is a packed tree, `flair upgrade --tree " + `${s.dir}\` upgrades it.`,
    ];
  }
  if (a.state !== "diverged") return [];

  const unit = describeUnit(s);
  const lines = [
    "⚠️  This CLI and the running instance are in DIFFERENT install trees.",
    `   CLI:      ${a.cli.dir}  (${v(a.cli.version)})`,
    `   instance: ${s.dir}  (running ${v(a.runningVersion)}; pid ${s.pid}, ${unit})`,
  ];
  if (a.nodePin?.kind === "erroneous") lines.push(`   Cause: ${a.nodePin.message}`);
  if (opts.latest) {
    lines.push(
      `   Versions: latest published is ${opts.latest}; this CLI is ${relation(a.cli.version, opts.latest)}, ` +
        `the instance is ${relation(a.runningVersion, opts.latest)}.`,
    );
  }
  if (opts.context === "upgrade") {
    lines.push(
      `   \`flair upgrade\` changes this CLI's tree only; the instance keeps serving ${s.dir} until its service is re-pointed.`,
    );
  }
  const manual = manualRepointReason(a);
  if (a.cliOlder) {
    lines.push(
      `   This CLI's tree has an OLDER flair than the instance runs, so re-pointing the service at it now would downgrade the`,
      "   instance — `flair init` will not do that. First update this CLI's tree from this same shell:",
      "     npm i -g @tpsdev-ai/flair",
      manual
        ? `   Then (${manual}) point the unit at ${a.cli.dir} by hand, then: flair restart`
        : "   Then: flair init && flair restart",
    );
    return lines;
  }
  if (a.restartPending) {
    lines.push(
      `   ${unit} already names this CLI's tree; the running process started before it was re-pointed.`,
      "   Remedy: flair restart  (restarts the instance under the unit and reports which tree then serves)",
    );
    return lines;
  }
  if (manual) {
    lines.push(
      `   ${manual}.`,
      `   Remedy: point the unit's node, Harper entry and WorkingDirectory at ${a.cli.dir} by hand (where the drop-ins`,
      "   set them, edit the drop-ins), then: flair restart",
    );
    return lines;
  }
  lines.push(
    "   Remedy: flair init && flair restart",
    `   \`flair init\` re-points ${unit} at this CLI's tree.`,
    `   It changes only the unit's node, Harper entry, ${s.manager === "launchd" ? "launcher" : "launcher (if it runs one)"} and working directory,`,
    "   and leaves the unit's other settings as they are. It writes only a unit it can prove is this instance's and in a shape",
    "   it supports; otherwise it changes nothing and names the file, what did not match, and the remedy. It also",
    "   re-points the federation-sync shim when that runs another tree.",
    "   init is Flair's full setup command, so it also re-runs its idempotent setup for this data directory: it reuses the existing",
    "   Harper install and admin password, saves the instance's recorded configuration again, and in an interactive shell can",
    "   offer agent and MCP-client setup. `flair restart` then restarts the instance under the re-pointed unit and reports which",
    "   tree serves it.",
  );
  return lines;
}

/** One line naming the serving tree — or why it is unknown. */
export function formatServingTreeLine(a: TreeAssessment): string {
  if (a.serving.kind === "unknown") return `serving install tree: unknown — ${a.serving.reason}`;
  const s = a.serving;
  const where = a.state === "same" ? "this CLI's tree" : `this CLI is ${a.cli.dir}`;
  return `serving install tree: ${s.dir} (running ${v(a.runningVersion)}; pid ${s.pid}, ${describeUnit(s)}) — ${where}`;
}

/** The assessment as plain JSON for `flair status --json`. */
export function treeAssessmentJson(a: TreeAssessment): Record<string, unknown> {
  const s = a.serving;
  return {
    state: a.state,
    cli: { dir: a.cli.dir, version: a.cli.version },
    serving:
      s.kind === "proven"
        ? {
            dir: s.dir,
            treeVersion: s.version,
            runningVersion: a.runningVersion,
            pid: s.pid,
            manager: s.manager,
            unit: s.unitName,
            unitPath: s.unitPath,
          }
        : null,
    unknownReason: s.kind === "unknown" ? s.reason : null,
    restartPending: a.restartPending,
    cliOlder: a.cliOlder,
    nodePin: a.nodePin ? { kind: a.nodePin.kind, unitNodeBin: a.nodePin.unitNodeBin, currentNodeBin: a.nodePin.currentNodeBin } : null,
    remedy:
      a.state !== "diverged" || manualRepointReason(a) !== null
        ? null
        : a.cliOlder
          ? ["npm i -g @tpsdev-ai/flair", "flair init", "flair restart"]
          : a.restartPending
            ? ["flair restart"]
            : ["flair init", "flair restart"],
    // Set when flair init will not re-point the unit: the remedy is a hand edit, then `flair restart`.
    manualRemedy: manualRepointReason(a),
  };
}
