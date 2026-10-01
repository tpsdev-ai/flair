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
 *   - Linux: the serving process's own cgroup (/proc/<pid>/cgroup) places it
 *     in a systemd USER unit of this user; systemd reports that PID as the
 *     unit's MainPID, and the unit's FragmentPath is a file of that name in
 *     this user's unit directory. The unit is found FROM THE PROCESS, never
 *     from a tree path in a unit file, so it is still found after `flair init`
 *     re-pointed the file at another tree (the restart-pending state).
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
 * the tree is UNKNOWN, and no remedy is derived from it. A systemd unit runs a
 * process only as its MainPID: a process that merely sits in a unit's cgroup
 * (a descendant of a CI runner agent, a terminal multiplexer, an ssh session
 * service) was started directly (see unitSupervision). A cgroup path that names
 * its users or units inconsistently is contradictory evidence: no manager is
 * asked about it, and it never leads to a restart (see cgroupOwner).
 *
 * Everything here is pure: the probe hands in every filesystem, process and
 * service-manager read, so the whole decision is unit-testable without a real
 * launchd, systemd or running instance.
 */
import { basename, dirname, resolve } from "node:path";
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
  /** Linux: the text of /proc/<pid>/cgroup (throws when it cannot be read). */
  procCgroup?: (pid: number) => string;
  /** Linux: this user's uid (its user manager is user@<uid>.service). */
  uid?: number;
  /** Linux: this user's systemd unit directory (~/.config/systemd/user). */
  userUnitDir?: string;
  /** Linux: a user unit as the manager reports it, or null when it could not be read. */
  systemdUserUnit?: (unitName: string) => SystemdUnitManagerState | null;
  /** Linux: the MainPID a manager reports for a unit (0: no main process), or null when it could not be asked. */
  unitMainPid?: (unitName: string, manager: SystemdManager) => number | null;
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

/** Which systemd unit a process's cgroup places it in (see cgroupOwner). */
export type CgroupOwner =
  /** Exactly `/user.slice/user-<uid>.slice/user@<uid>.service/[<x>.slice/…]<unit>.service`. */
  | { kind: "user-service"; unit: string; path: string }
  /**
   * Any other `.service` in the path: a system unit, another user's, a sub-cgroup of a unit.
   * `managerUid` is the uid of the user manager (`user@<uid>.service`) the path is under, exactly as the path spells
   * it; null for the system manager.
   */
  | { kind: "service"; unit: string; path: string; user: boolean; managerUid: string | null }
  /** No service in the path (a login-session scope, for example): no manager owns it. */
  | { kind: "none"; path: string }
  /**
   * The path names its users or units inconsistently — a user slice and a user manager of different uids, a user
   * manager not directly under `user.slice/user-<uid>.slice` at the top of the hierarchy, more than one user manager,
   * or one service's cgroup nested in another's. It does not say which manager supervises the process, so no manager
   * is asked about it and nothing is restarted from it.
   */
  | { kind: "contradictory"; path: string; reason: string }
  /** No cgroup v2 (`0::`) entry to read. */
  | { kind: "unreadable"; reason: string };

/** `/user.slice/user-<uid>.slice/user@<uid>.service/[<x>.slice/…]<unit>.service` — the two uids captured (1, 2), the unit (3). */
const USER_UNIT_CGROUP =
  /^\/user\.slice\/user-(\d+)\.slice\/user@(\d+)\.service\/(?:[A-Za-z0-9:_.\\-]+\.slice\/)*([A-Za-z0-9:_.@\\-]+\.service)$/;
/** A user manager's own unit, `user@<uid>.service` — the uid captured. */
const USER_MANAGER_UNIT = /^user@(\d+)\.service$/;

/**
 * Why a cgroup path's components contradict each other, or null. systemd runs
 * a user's manager as `user@<uid>.service` at `/user.slice/user-<uid>.slice/`
 * (the same uid, nothing above `user.slice`), and it nests no service inside
 * another service's cgroup: a path that says otherwise does not establish which
 * manager supervises the process, whichever manager is asked.
 */
function cgroupContradiction(components: string[]): string | null {
  const services = components.filter((c) => c.endsWith(".service") && !USER_MANAGER_UNIT.test(c));
  if (services.length > 1) {
    return (
      `it nests one service's cgroup in another's (${services.join(", ")}), so which unit supervises the process ` +
      "is ambiguous"
    );
  }
  const managers = components.flatMap((c, at) => {
    const m = USER_MANAGER_UNIT.exec(c);
    return m ? [{ at, name: c, uid: m[1]! }] : [];
  });
  if (managers.length > 1) {
    return (
      `it names more than one user manager (${managers.map((m) => m.name).join(", ")}), so which manager ` +
      "supervises the process is ambiguous"
    );
  }
  const m = managers[0];
  if (m === undefined) return null;
  const slice = components[m.at - 1] ?? "";
  const sliceUid = /^user-(\d+)\.slice$/.exec(slice)?.[1];
  if (sliceUid !== undefined && sliceUid !== m.uid) {
    return `its user slice ${slice} and its user manager ${m.name} name different users`;
  }
  // Nothing but the root above user.slice: a user manager inside another unit's
  // cgroup (a service's, a container's) is not where systemd runs it.
  if (sliceUid === undefined || components[m.at - 2] !== "user.slice" || components.slice(0, m.at - 2).some((c) => c !== "")) {
    return (
      `its user manager ${m.name} is not directly under user.slice/user-${m.uid}.slice at the top of the ` +
      "hierarchy, where systemd runs it"
    );
  }
  return null;
}

/**
 * Read /proc/<pid>/cgroup text: the unified (`0::`) entry names the cgroup,
 * and a systemd unit's processes live in a cgroup named after the unit. This
 * is the service manager's own placement of the process, so it identifies the
 * unit without reading any unit file. A path whose components contradict each
 * other is `contradictory` — decided here, before any manager is asked about a
 * unit in it (see cgroupContradiction).
 */
export function cgroupOwner(text: string, uid: number): CgroupOwner {
  const line = text.split(/\r?\n/).find((l) => l.startsWith("0::"));
  if (line === undefined) return { kind: "unreadable", reason: "it has no cgroup v2 (0::) entry" };
  const path = line.slice(3);
  const components = path.split("/");
  const contradiction = cgroupContradiction(components);
  if (contradiction !== null) return { kind: "contradictory", path, reason: contradiction };
  // A fixed pattern: both uids in the path are captured and compared with this
  // user's uid here, never built into the expression.
  const exact = USER_UNIT_CGROUP.exec(path);
  if (exact && exact[1] === String(uid) && exact[2] === String(uid)) return { kind: "user-service", unit: exact[3]!, path };
  const services = components.filter((c) => c.endsWith(".service") && !USER_MANAGER_UNIT.test(c));
  if (services.length > 0) {
    // A user manager component with a `/` on both sides: the path is under that user's manager.
    const manager = components.slice(1, -1).map((c) => USER_MANAGER_UNIT.exec(c)).find((m) => m !== null) ?? null;
    return {
      kind: "service",
      unit: services[services.length - 1]!,
      path,
      user: manager !== null,
      managerUid: manager === null ? null : manager[1]!,
    };
  }
  return { kind: "none", path };
}

/** Which systemd manager to ask about a unit: this user's (`systemctl --user`) or the system's. */
export type SystemdManager = "user" | "system";

/**
 * Whether the unit a process's cgroup names SUPERVISES that process.
 *
 * A unit runs a process only as its main process — the MainPID systemd
 * reports. A process that merely sits in a unit's cgroup (a descendant of an
 * unrelated service such as a CI runner agent, a terminal multiplexer or an
 * ssh session service) was started directly: that unit's MainPID is another
 * process (`other`). When the manager cannot be asked (another user's manager,
 * no answer) or reports no main process, it is not known (`unknown`) — never
 * guessed either way.
 */
export type UnitSupervision =
  | { kind: "main"; unit: string; manager: SystemdManager }
  | { kind: "other"; unit: string; mainPid: number }
  | { kind: "unknown"; unit: string; reason: string };

export function unitSupervision(
  pid: number,
  owner: Extract<CgroupOwner, { kind: "user-service" | "service" }>,
  uid: number,
  mainPidOf: ((unitName: string, manager: SystemdManager) => number | null) | undefined,
): UnitSupervision {
  const unit = owner.unit;
  const manager: SystemdManager | null =
    owner.kind === "user-service" ? "user" : !owner.user ? "system" : owner.managerUid === String(uid) ? "user" : null;
  if (manager === null) {
    return { kind: "unknown", unit, reason: `${unit} is under another user's systemd manager, which flair does not ask` };
  }
  let mainPid: number | null;
  try {
    mainPid = mainPidOf ? mainPidOf(unit, manager) : null;
  } catch {
    mainPid = null;
  }
  if (mainPid === null) return { kind: "unknown", unit, reason: `systemd did not report the MainPID of ${unit}` };
  if (mainPid <= 0) return { kind: "unknown", unit, reason: `systemd reports no main process for ${unit}` };
  return mainPid === pid ? { kind: "main", unit, manager } : { kind: "other", unit, mainPid };
}

/** Why the unit a serving process's cgroup names is not shown to run it (see unitSupervision). */
function notRunByUnitReason(pid: number, path: string, sup: Exclude<UnitSupervision, { kind: "main" }>): string {
  return sup.kind === "other"
    ? `no systemd unit runs the serving process (pid ${pid}): it is in the cgroup of ${sup.unit} (${path}), whose ` +
        `main process is pid ${sup.mainPid} — it was started directly`
    : `the serving process (pid ${pid}) is in the cgroup of ${sup.unit} (${path}), and ${sup.reason}, so whether ` +
        "that unit runs it is not known";
}

/**
 * The Linux probe from raw reads — /proc/<pid>/cgroup and `systemctl [--user]
 * show` output — so the adapter in src/cli.ts and the tests run the same
 * parsing and lookup.
 */
export function linuxUnitProbe(io: {
  readFile: (p: string) => string;
  /**
   * `systemctl [--user] show <unit> -p MainPID -p FragmentPath -p DropInPaths -p WorkingDirectory` stdout (`--user`
   * for the user manager), or null.
   */
  systemctlShow: (unit: string, manager: SystemdManager) => string | null;
  uid: number;
  userUnitDir: string;
}): Pick<ServingTreeProbe, "procCgroup" | "uid" | "userUnitDir" | "systemdUserUnit" | "unitMainPid"> {
  return {
    procCgroup: (pid) => io.readFile(`/proc/${pid}/cgroup`),
    uid: io.uid,
    userUnitDir: io.userUnitDir,
    systemdUserUnit: (unit) => {
      const out = io.systemctlShow(unit, "user");
      return out === null ? null : systemdUnitStateFromShow(out);
    },
    unitMainPid: (unit, manager) => {
      const out = io.systemctlShow(unit, manager);
      return out === null ? null : mainPidFromShow(out);
    },
  };
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

/**
 * MainPID from `systemctl show -p MainPID …` output: the pid, 0 when the unit
 * has no main process, or null when it is missing or not a number.
 */
export function mainPidFromShow(text: string): number | null {
  const raw = parseSystemctlShow(text).MainPID?.trim();
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
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
    if (!p.procCgroup || p.uid === undefined || !p.userUnitDir) {
      return unknown("this host's process cgroups cannot be read, so no systemd unit can be proven to own the serving process");
    }
    // The unit comes from the process (its cgroup), never from a tree path in a
    // unit file: after a re-point the file names this CLI's tree while the
    // process still runs the old one, and it must still be found.
    let owner: CgroupOwner;
    try {
      owner = cgroupOwner(p.procCgroup(pid), p.uid);
    } catch (err) {
      return unknown(`the cgroup of the serving process (pid ${pid}) could not be read (${(err as Error)?.message ?? err})`);
    }
    if (owner.kind === "unreadable") return unknown(`the cgroup of the serving process (pid ${pid}) cannot be read: ${owner.reason}`);
    if (owner.kind === "contradictory") {
      return unknown(
        `the cgroup of the serving process (pid ${pid}) is contradictory (${owner.path}): ${owner.reason}, so which ` +
          "service manager supervises it is not known",
      );
    }
    if (owner.kind === "none") {
      return unknown(`no systemd unit owns the serving process (pid ${pid}, cgroup ${owner.path}) — it was started directly`);
    }
    // A unit runs the process only as its MainPID (see unitSupervision) — the
    // same rule `flair restart` applies (planLinuxRestart).
    if (owner.kind === "service") {
      const sup = unitSupervision(pid, owner, p.uid, p.unitMainPid);
      if (sup.kind !== "main") return unknown(notRunByUnitReason(pid, owner.path, sup));
      return unknown(
        `the serving process (pid ${pid}) is the main process of the systemd unit ${owner.unit} (cgroup ${owner.path}), ` +
          "which is not a user unit of this user that flair re-points (a system-level unit, or a sub-cgroup of a unit)",
      );
    }
    const unit = owner.unit;
    const state = p.systemdUserUnit?.(unit) ?? null;
    if (!state) {
      return unknown(
        notRunByUnitReason(pid, owner.path, { kind: "unknown", unit, reason: `systemd did not report the user unit ${unit}` }),
      );
    }
    if (state.mainPid !== pid) {
      return unknown(
        notRunByUnitReason(
          pid,
          owner.path,
          state.mainPid === null
            ? { kind: "unknown", unit, reason: `systemd reports no main process for ${unit}` }
            : { kind: "other", unit, mainPid: state.mainPid },
        ),
      );
    }
    // Only a file of that name in this user's unit directory is a file flair reads and re-points.
    const fragment = state.fragmentPath;
    if (fragment === null || basename(fragment) !== unit || !samePath(dirname(fragment), p.userUnitDir)) {
      return unknown(
        `systemd loads ${unit} from ${fragment ?? "no file"}, not from ${unit} in this user's unit directory ${p.userUnitDir}`,
      );
    }
    let refs: { nodeBin: string | null; workingDirectory: string | null } = { nodeBin: null, workingDirectory: null };
    // With drop-ins, the unit file alone does not say what systemd runs.
    if (state.dropInPaths.length === 0) {
      try {
        refs = readSystemdServiceRefs(p.read(fragment));
      } catch { /* the proof is the cgroup + MainPID + FragmentPath; the refs are detail */ }
    }
    return {
      kind: "proven",
      dir: pkg.dir,
      version: pkg.version,
      pid,
      manager: "systemd-user",
      unitName: unit,
      unitPath: fragment,
      unitNodeBin: refs.nodeBin,
      unitTree: refs.workingDirectory,
      dropInPaths: state.dropInPaths,
    };
  }

  return unknown(`${p.platform} has no service manager flair can check`);
}

export type LinuxRestartPlan = { kind: "systemd"; unit: string } | { kind: "direct" } | { kind: "refuse"; detail: string };

/**
 * How `flair restart` may restart the instance on Linux. A proven user unit is
 * restarted THROUGH systemd. Otherwise the direct path (stop by signal, spawn
 * again) is allowed only when no process it could stop is SUPERVISED by a
 * systemd unit — is that unit's MainPID (see unitSupervision). A supervised
 * process is never stopped and respawned outside its manager: it is refused,
 * with the systemctl command to use. A process that merely sits in some
 * service's cgroup (that unit's MainPID is another process) was started
 * directly and takes the direct path. When the cgroup cannot be read, or the
 * unit's MainPID cannot be learned, it is refused: unknown never licenses a stop.
 * A contradictory cgroup is refused before any manager is asked about it.
 */
export function planLinuxRestart(input: {
  serving: ServingTree;
  /** The processes the direct path could stop: the live PID-file PID and the port's listeners. */
  pids: number[];
  procCgroup: (pid: number) => string;
  uid: number;
  /** The MainPID a manager reports for a unit (0: no main process), or null when it could not be asked. */
  unitMainPid: (unitName: string, manager: SystemdManager) => number | null;
}): LinuxRestartPlan {
  const s = input.serving;
  if (s.kind === "proven" && s.manager === "systemd-user") return { kind: "systemd", unit: s.unitName };
  const why = s.kind === "unknown" ? s.reason : `it is served by ${describeUnit(s)}`;
  for (const pid of new Set(input.pids)) {
    let owner: CgroupOwner;
    try {
      owner = cgroupOwner(input.procCgroup(pid), input.uid);
    } catch (err) {
      owner = { kind: "unreadable", reason: (err as Error)?.message ?? String(err) };
    }
    if (owner.kind === "none") continue;
    if (owner.kind === "unreadable") {
      return {
        kind: "refuse",
        detail:
          `refusing to restart: the cgroup of pid ${pid} cannot be read (${owner.reason}), so flair cannot tell whether a ` +
          "service manager supervises it, and it does not stop a process it cannot place. Restart it through whatever runs it.",
      };
    }
    // Contradictory evidence is refused BEFORE any manager is asked: no MainPID
    // answer about a unit in such a path shows who supervises the process.
    if (owner.kind === "contradictory") {
      return {
        kind: "refuse",
        detail:
          `refusing to restart: the cgroup of pid ${pid} is contradictory (${owner.path}): ${owner.reason}. flair cannot ` +
          "tell which service manager supervises it, and it does not stop a process it cannot place. Restart it through " +
          "whatever runs it.",
      };
    }
    const sup = unitSupervision(pid, owner, input.uid, input.unitMainPid);
    // In the unit's cgroup but not its main process: started directly (a CI runner agent's child, for example).
    if (sup.kind === "other") continue;
    const cmd =
      owner.kind === "user-service" || owner.user ? `systemctl --user restart ${owner.unit}` : `systemctl restart ${owner.unit} (as root)`;
    if (sup.kind === "unknown") {
      return {
        kind: "refuse",
        detail:
          `refusing to restart: pid ${pid} is in the cgroup of the systemd unit ${owner.unit} (cgroup ${owner.path}), and ` +
          `${sup.reason}, so flair cannot tell whether that unit runs it, and it does not stop a process a service manager ` +
          `may supervise. If ${owner.unit} runs this instance, restart it through systemd: ${cmd}`,
      };
    }
    return {
      kind: "refuse",
      detail:
        `refusing to restart: pid ${pid} is the main process of the systemd unit ${owner.unit} (cgroup ${owner.path}), and ` +
        `flair restarts only a user unit it proved runs this instance (${why}). flair does not stop a process a service ` +
        `manager supervises and start it again outside that manager. Restart it through systemd: ${cmd}`,
    };
  }
  return { kind: "direct" };
}

/**
 * After `systemctl --user restart <unit>`: why the unit's new main process is
 * not a restarted process running from the unit's WorkingDirectory, or null.
 */
export function restartedUnitProblem(
  unit: string,
  oldPid: number | null,
  state: SystemdUnitManagerState | null,
  cwdOf: (pid: number) => string | null,
  samePath: (a: string, b: string) => boolean,
): string | null {
  if (!state) return `systemd did not report ${unit} after the restart`;
  if (state.mainPid === null) return `${unit} has no main process after the restart`;
  if (oldPid !== null && state.mainPid === oldPid) return `${unit}'s main process is still pid ${oldPid}`;
  const cwd = cwdOf(state.mainPid);
  if (cwd === null) return `the working directory of ${unit}'s new main process (pid ${state.mainPid}) could not be read`;
  if (state.workingDirectory === null || !samePath(cwd, state.workingDirectory)) {
    return `${unit}'s new main process (pid ${state.mainPid}) runs in ${cwd}, not the unit's WorkingDirectory ${state.workingDirectory ?? "(none)"}`;
  }
  return null;
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
