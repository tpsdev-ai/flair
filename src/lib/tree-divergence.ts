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
 *     its MainPID.
 *
 * The serving PID is the one the answering process reported about itself
 * (`/HealthDetail`'s `pid`) when available, else the process this data dir
 * records (Harper's `hdb.pid`, then the port's listener). The tree is read from
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
  /** The node binary the unit names now. */
  unitNodeBin: string | null;
  /** The install tree the unit names now (may differ from `dir` after a re-point that is not yet restarted). */
  unitTree: string | null;
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
  /** The PID serving `dataDir` locally (hdb.pid, then the port listener). Called only when needed. */
  localServingPid: () => number | null;
  /** macOS: this data dir's launchd label and plist path. */
  launchd?: { label: string; plistPath: string };
  /** macOS: the running PID of a launchd job, or null when it is not loaded / not running. */
  launchdJobPid?: (label: string) => number | null;
  /** Linux: systemd USER units that name `tree` in WorkingDirectory/ExecStart. */
  findUserUnitsForTree?: (tree: string) => Array<{ name: string; path: string }>;
  /** Linux: a user unit's MainPID, or null when it has none. */
  systemdUserMainPid?: (unitName: string) => number | null;
  /** The @tpsdev-ai/flair package a live PID runs from, or null. */
  servingPackage: (pid: number) => PackageLocation | null;
  exists: (p: string) => boolean;
  read: (p: string) => string;
}

function unknown(reason: string): UnknownServingTree {
  return { kind: "unknown", reason };
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

  const pickPid = (): number | null => {
    if (typeof p.respondingPid === "number" && p.respondingPid > 0) return p.respondingPid;
    try {
      return p.localServingPid();
    } catch {
      return null;
    }
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
    const pid = pickPid();
    if (pid === null) return unknown("the process serving this instance could not be identified");
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
    };
  }

  if (p.platform === "linux") {
    const pid = pickPid();
    if (pid === null) return unknown("the process serving this instance could not be identified");
    const pkg = p.servingPackage(pid);
    if (!pkg) return unknown(`the install tree of the serving process (pid ${pid}) could not be read`);
    const units = p.findUserUnitsForTree?.(pkg.dir) ?? [];
    for (const u of units) {
      const mainPid = p.systemdUserMainPid?.(u.name) ?? null;
      if (mainPid !== pid) continue;
      let refs: { nodeBin: string | null; workingDirectory: string | null } = { nodeBin: null, workingDirectory: null };
      try {
        refs = readSystemdServiceRefs(p.read(u.path));
      } catch { /* the proof is the MainPID; the refs are detail */ }
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
      };
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

/** Compare dotted versions numerically; <0, 0, >0 (missing parts are 0; a pre-release tag is ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
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
      compareVersions(a.cli.version, servingCodeVersion) < 0,
  };
}

export function describeUnit(s: ProvenServingTree): string {
  return s.manager === "launchd"
    ? `the launchd service ${s.unitName} (${s.unitPath})`
    : `the systemd user unit ${s.unitName} (${s.unitPath})`;
}

function v(version: string | null): string {
  return version ? `flair ${version}` : "flair version unknown";
}

function relation(version: string | null, latest: string): string {
  if (!version) return "unknown";
  const c = compareVersions(version, latest);
  return c === 0 ? "current" : c < 0 ? "behind" : "ahead";
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
  if (a.cliOlder) {
    lines.push(
      `   This CLI's tree has an OLDER flair than the instance runs, so re-pointing the service at it now would downgrade the`,
      "   instance — `flair init` will not do that. First update this CLI's tree from this same shell:",
      "     npm i -g @tpsdev-ai/flair",
      "   Then: flair init && flair restart",
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
  lines.push(
    "   Remedy: flair init && flair restart",
    `   \`flair init\` re-points ${unit} at this CLI's tree — its node, Harper entry${s.manager === "launchd" ? ", launcher" : ""} and working directory — and`,
    "   leaves the unit's other settings as they are (it also re-points the federation-sync shim when that runs another tree).",
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
      a.state !== "diverged"
        ? null
        : a.cliOlder
          ? ["npm i -g @tpsdev-ai/flair", "flair init", "flair restart"]
          : a.restartPending
            ? ["flair restart"]
            : ["flair init", "flair restart"],
  };
}
