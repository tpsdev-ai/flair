/**
 * launchd-management.ts — "is this instance actually under launchd?", and
 * "why did launchd refuse to run it?" (flair#1022).
 *
 * `flair upgrade` on macOS restarts through launchd and falls back to a plain
 * detached spawn when a launchd operation fails. The fallback is the right
 * behaviour — a running instance beats a down one — but it changes a load
 * bearing property of the install that nothing was measuring: the process is no
 * longer owned by a service manager, so it does not come back after a reboot.
 * The reported incident ended in `verified: healthy, authenticated, running
 * <new version>`, every word of which was true, while the instance had just
 * been orphaned. **Healthy and managed are different claims** and only the
 * first was being made.
 *
 * Two things live here, and the split matters:
 *
 *   1. `assessLaunchdManagement()` — an OBSERVATION taken after the fact.
 *      Deliberately not a flag threaded down from whichever function did the
 *      falling back: `flair upgrade` hands its restart to the NEWLY INSTALLED
 *      CLI in a child process (flair#905), so no in-process bookkeeping
 *      survives the boundary. Asking launchd directly, at verification time,
 *      is the only form of this check that works on both the delegated and
 *      the in-process path — and it also catches a detachment this run did
 *      not cause.
 *
 *   2. `diagnoseLaunchdPlistPaths()` — a PRE-FLIGHT taken before the fact, and
 *      the reason the incident took two minutes to produce no information.
 *      **`launchctl load` and `launchctl start` both exit 0 for a job whose
 *      program does not exist.** Measured on macOS 15, not assumed: loading a
 *      plist whose ProgramArguments[0] points at a deleted path succeeds,
 *      `start` succeeds, and the only evidence of the failure is a nonzero
 *      `LastExitStatus` and a missing `PID` in `launchctl list <label>` after
 *      the fact. So the CLI's launchd path cannot learn anything from
 *      launchctl's exit codes; it waits the full startup budget for a port
 *      that was never going to open, and then falls back.
 *
 *      A plist records absolute paths — the node binary (`process.execPath` at
 *      `flair init` time), Harper's entrypoint under that same install's
 *      `node_modules`, and the package working directory. Switch Node runtimes
 *      with a version manager and every one of them can move. That is knowable
 *      from a `readFileSync` and an `existsSync`, in microseconds, and it names
 *      both the stale path and the fix.
 *
 * Never logs plist CONTENTS. The plist embeds HDB_ADMIN_PASSWORD; only
 * extracted program/working-directory paths ever reach a message, and the
 * extractor below reads exactly those keys rather than returning the document.
 */
import { existsSync, readFileSync } from "node:fs";
import { unescapeXml } from "./xml-escape.js";

/**
 * Ceiling on the `launchctl list` spawn. A status query answers instantly when
 * launchd is reachable; this only exists so an unreachable service manager
 * cannot turn a post-upgrade summary line into a hang. Same reasoning as
 * scheduler-platform's STATUS_CHECK_TIMEOUT_MS.
 */
export const LAUNCHCTL_QUERY_TIMEOUT_MS = 5_000;

// ─── plist path pre-flight ────────────────────────────────────────────────

/** The absolute paths a plist tells launchd to exec, and where from. */
export interface PlistProgramRefs {
  /** ProgramArguments, in order. Empty when the key is absent or malformed. */
  programArguments: string[];
  /** WorkingDirectory, or null when the key is absent. */
  workingDirectory: string | null;
}

/**
 * Extract ONLY the exec-related paths from a plist: ProgramArguments and
 * WorkingDirectory.
 *
 * Regex rather than a plist parser for the same reason `readPlistRootPath`
 * uses one — this reads documents `buildLaunchdPlist` wrote, the shape is
 * fixed, and a parser would pull the whole `EnvironmentVariables` dict
 * (including the admin password) into memory to answer a question about two
 * keys. Values are XML-escaped on the way in, so they are unescaped on the way
 * out; a path containing `&` is stored as `&amp;` and returned as `&`.
 *
 * Returns null when the file cannot be read at all. A readable plist with
 * neither key returns an empty/null refs object, which callers treat as "no
 * evidence" rather than "broken" — a hand-written plist that uses `Program`
 * instead of `ProgramArguments` is not ours to judge.
 */
export function readPlistProgramRefs(
  plistPath: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): PlistProgramRefs | null {
  let raw: string;
  try {
    raw = read(plistPath);
  } catch {
    return null;
  }
  const programArguments: string[] = [];
  const argsBlock = raw.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (argsBlock) {
    for (const m of argsBlock[1].matchAll(/<string>([^<]*)<\/string>/g)) {
      programArguments.push(unescapeXml(m[1]));
    }
  }
  const wd = raw.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
  return { programArguments, workingDirectory: wd ? unescapeXml(wd[1]) : null };
}

/**
 * A path a plist names that is no longer on disk.
 *
 * Modelled as `StalePlistPath | null` rather than a `{ ok: true } | { ok:
 * false }` union on purpose: `tsconfig.cli.json` compiles src/cli.ts with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * discriminated union keyed on a BOOLEAN literal — every `d.message` at a call
 * site becomes an error. A nullable object narrows under both configurations,
 * so the same helper is usable from cli.ts and from a strict-mode test.
 */
export interface StalePlistPath {
  /** Which plist key names the path that has gone missing. */
  kind: "ProgramArguments" | "WorkingDirectory";
  /** The path in the plist that no longer exists on disk. */
  stalePath: string;
  /** One line naming the stale path — safe to print, contains no plist content beyond this path. */
  message: string;
  /**
   * Commands that re-register the service against the current runtime.
   *
   * BARE commands, with no trailing `# explanation`: these are rendered joined
   * by ` && ` so an operator can paste the whole line, and a `#` anywhere in
   * that line comments out everything after it. Explanation belongs in
   * `message`, which is prose nobody will paste into a shell.
   */
  remedy: string[];
}

/**
 * Does this plist still point at things that exist?
 *
 * Only ABSOLUTE paths are checked. `ProgramArguments` for a Flair service is
 * `[<node>, <harper entrypoint>, "run", "."]` — the trailing literals are
 * arguments, not paths, and an install whose plist was hand-edited to use a
 * relative program is resolved by launchd against WorkingDirectory in a way
 * this check has no business second-guessing. A missing absolute path, by
 * contrast, is not ambiguous: launchd cannot exec it, and will not say so.
 *
 * The remedy is `flair init` because init unconditionally rewrites the plist
 * from `process.execPath` and the currently-resolved Harper entrypoint — it is
 * what re-points a service at the Node the operator is actually using now —
 * followed by a restart to bring the job up under the rewritten plist.
 */
export function diagnoseLaunchdPlistPaths(
  plistPath: string,
  deps: { read?: (p: string) => string; exists?: (p: string) => boolean } = {},
): StalePlistPath | null {
  const exists = deps.exists ?? existsSync;
  const refs = readPlistProgramRefs(plistPath, deps.read);
  if (!refs) return null;

  const remedy = ["flair init", "flair restart"];
  const rewriteNote =
    "`flair init` rewrites the plist against the Node runtime in use now, and `flair restart` " +
    "brings the job back up under it.";

  for (const arg of refs.programArguments) {
    if (!arg.startsWith("/")) continue;
    if (exists(arg)) continue;
    return {
      kind: "ProgramArguments",
      stalePath: arg,
      message:
        `the launchd plist at ${plistPath} runs ${arg}, which no longer exists. ` +
        `launchd cannot exec a missing program and reports no error for it — ` +
        `load and start both succeed and the service never comes up. ` +
        `A plist commonly goes stale like this after switching Node runtimes, ` +
        `which moves both the node binary and the globally installed package tree. ` +
        rewriteNote,
      remedy,
    };
  }

  const wd = refs.workingDirectory;
  if (wd && wd.startsWith("/") && !exists(wd)) {
    return {
      kind: "WorkingDirectory",
      stalePath: wd,
      message:
        `the launchd plist at ${plistPath} sets WorkingDirectory to ${wd}, which no longer exists. ` +
        `launchd refuses to spawn a job whose working directory is missing, and reports no error for it — ` +
        `load and start both succeed and the service never comes up. ` +
        rewriteNote,
      remedy,
    };
  }

  return null;
}

// ─── launchctl job state ──────────────────────────────────────────────────

export interface LaunchctlJobState {
  /** launchd knows this label. False when `launchctl list <label>` could not find it. */
  registered: boolean;
  /** The job's running process, or null when launchd reports no PID (job not running). */
  pid: number | null;
  /** The job's last exit status, or null when launchd reported none. */
  lastExitStatus: number | null;
}

/**
 * Parse `launchctl list <label>` output.
 *
 * The output is a plist-ish dict of `"Key" = value;` lines. The two that
 * matter: `"PID"` is present ONLY while the job is running, and
 * `"LastExitStatus"` records how the last run ended. A job whose program is
 * missing has no PID and a nonzero LastExitStatus — that combination is the
 * signature of the failure this module exists to name.
 */
export function parseLaunchctlList(output: string): { pid: number | null; lastExitStatus: number | null } {
  const pidMatch = output.match(/"PID"\s*=\s*(\d+)\s*;/);
  const exitMatch = output.match(/"LastExitStatus"\s*=\s*(-?\d+)\s*;/);
  return {
    pid: pidMatch ? Number(pidMatch[1]) : null,
    lastExitStatus: exitMatch ? Number(exitMatch[1]) : null,
  };
}

/** Runs `launchctl list <label>`; injected so tests never touch real launchd. */
export type LaunchctlLister = (label: string) => { code: number | null; stdout: string };

export function readLaunchctlJobState(label: string, list: LaunchctlLister): LaunchctlJobState {
  let res: { code: number | null; stdout: string };
  try {
    res = list(label);
  } catch {
    return { registered: false, pid: null, lastExitStatus: null };
  }
  if (res.code !== 0) return { registered: false, pid: null, lastExitStatus: null };
  const { pid, lastExitStatus } = parseLaunchctlList(res.stdout);
  return { registered: true, pid, lastExitStatus };
}

/**
 * Which PID to treat as "the process serving this instance".
 *
 * Harper's own `hdb.pid` is preferred — it is written by the serving process on
 * every boot regardless of who spawned it, so it is the same number on the
 * launchd path and on the direct-spawn fallback, which is what makes comparing
 * it against launchd's reported PID a real comparison.
 *
 * The liveness check is the part that is easy to leave out and expensive to
 * omit. A `hdb.pid` left behind by a process that is gone names a PID that
 * matches nothing, and a mismatch is what this module reports as DETACHED — so
 * a stale file would produce a loud, wrong warning on a perfectly healthy
 * launchd install. A check that cries wolf on healthy installs is worse than no
 * check at all, because it is the reason the real warning gets skipped. A dead
 * PID is no evidence, so it is discarded and the port listener answers instead.
 */
export function pickInstancePid(input: {
  pidFilePid: number | null;
  isAlive: (pid: number) => boolean;
  listeningPids: number[];
}): number | null {
  const { pidFilePid, isAlive, listeningPids } = input;
  if (pidFilePid !== null && isAlive(pidFilePid)) return pidFilePid;
  return listeningPids.length > 0 ? listeningPids[0] : null;
}

// ─── the verdict ──────────────────────────────────────────────────────────

export type LaunchdManagementState =
  /** Not macOS — launchd is not the process manager here and nothing is claimed. */
  | "not-applicable"
  /** macOS, but no service is registered for this instance. Never was managed; not a degradation. */
  | "no-service"
  /** A service is registered AND launchd is running this instance's process. */
  | "managed"
  /** A service is registered and launchd is NOT running this instance's process. */
  | "detached";

export interface LaunchdManagement {
  state: LaunchdManagementState;
  /** The label examined, when there was one. */
  label?: string;
  /** One line of evidence for the verdict. Present for every state. */
  detail: string;
  /** Commands that restore management. Present iff state === "detached". */
  remedy?: string[];
}

/** True when the instance is running outside the service manager that is registered to own it. */
export function isDetached(m: LaunchdManagement): boolean {
  return m.state === "detached";
}

export interface AssessLaunchdManagementInput {
  /** process.platform. */
  platform: string;
  /** The instance's launchd label, from resolveLaunchdLabel(dataDir). */
  label: string;
  /** That label's plist path. */
  plistPath: string;
  /**
   * The PID actually serving this instance — Harper's own `hdb.pid`, or the
   * process listening on the instance's port. null when neither is readable.
   */
  instancePid: number | null;
  plistExists: (p: string) => boolean;
  list: LaunchctlLister;
  /** Injected so the stale-path explanation can be attached to a detached verdict. */
  diagnose?: (plistPath: string) => StalePlistPath | null;
}

/**
 * Is this instance under launchd right now?
 *
 * The evidence, in the order it is weighed:
 *
 *   - Not darwin, or no plist for this data dir ⇒ nothing claims to manage it,
 *     and there is no degradation to report. `no-service` is deliberately NOT
 *     an alarm: an instance that was never registered has not lost anything,
 *     and warning about it on every run is how a real warning gets ignored.
 *   - `launchctl list <label>` cannot find the label, although the plist is on
 *     disk ⇒ **detached**. The service exists but is not loaded.
 *   - launchd reports no PID for the label ⇒ **detached**. The registered job
 *     is not running, so whatever is serving the port is not launchd's.
 *     `LastExitStatus` is carried into the detail because it is the difference
 *     between "never started" and "started and died".
 *   - launchd reports a PID that is not the instance's PID ⇒ **detached**, and
 *     this is the exact shape the incident produced: launchd holds a job that
 *     is failing, while a directly-spawned process answers on the port.
 *   - launchd reports a PID and we cannot read the instance's own ⇒ **managed**.
 *     A live job under this instance's label is positive evidence; refusing to
 *     believe it because `hdb.pid` was unreadable would warn on healthy
 *     installs, which is its own defect.
 *
 * A parent-process check is NOT used, and that is worth stating because it is
 * the obvious first idea: the direct-start fallback spawns `detached: true` and
 * `unref()`s, so once the CLI exits its child is reparented to PID 1 — exactly
 * like a launchd-managed job. Both paths look identical from the parent PID,
 * so the parent PID cannot distinguish them.
 */
export function assessLaunchdManagement(input: AssessLaunchdManagementInput): LaunchdManagement {
  const { platform, label, plistPath, instancePid, plistExists, list } = input;
  if (platform !== "darwin") {
    return { state: "not-applicable", detail: `${platform} does not use launchd` };
  }
  if (!plistExists(plistPath)) {
    return { state: "no-service", detail: `no launchd service is registered for this instance (${plistPath})` };
  }

  const job = readLaunchctlJobState(label, list);
  const diagnose = input.diagnose ?? ((p: string) => diagnoseLaunchdPlistPaths(p));
  const detachedRemedy = (): { remedy: string[]; because: string } => {
    const stale = diagnose(plistPath);
    if (!stale) {
      return {
        remedy: ["flair restart"],
        because: "",
      };
    }
    return { remedy: stale.remedy, because: ` Cause: ${stale.message}` };
  };

  if (!job.registered) {
    const { remedy, because } = detachedRemedy();
    return {
      state: "detached",
      label,
      detail: `the launchd service ${label} is registered on disk but not loaded, so launchd is not managing this instance.${because}`,
      remedy,
    };
  }

  if (job.pid === null) {
    const { remedy, because } = detachedRemedy();
    const exit = job.lastExitStatus === null
      ? ""
      : ` launchd's last run of it exited ${job.lastExitStatus}.`;
    return {
      state: "detached",
      label,
      detail: `the launchd job ${label} is loaded but not running, so whatever is serving this instance was not started by launchd.${exit}${because}`,
      remedy,
    };
  }

  if (instancePid !== null && instancePid !== job.pid) {
    const { remedy, because } = detachedRemedy();
    return {
      state: "detached",
      label,
      detail:
        `this instance is served by process ${instancePid}, but launchd's job ${label} is process ${job.pid} — ` +
        `the running instance is not the one launchd manages.${because}`,
      remedy,
    };
  }

  return { state: "managed", label, detail: `launchd job ${label} is running as process ${job.pid}` };
}

/**
 * The lines to print for a degraded (detached) outcome.
 *
 * Kept here rather than at the two call sites so `flair restart` and `flair
 * upgrade` cannot drift into saying different things about the same condition,
 * and so the wording is assertable in a unit test without running either
 * command. Deliberately says what is WRONG (not managed), what it COSTS (no
 * restart after reboot), and what to DO — an operator who reads only the first
 * line still knows they have to act.
 */
export function renderDetachedWarning(m: LaunchdManagement, headline: string): string[] {
  const lines = [`⚠️  ${headline}`, `   ${m.detail}`];
  lines.push("   This instance will NOT come back after a reboot until launchd manages it again.");
  // One paste-able line, not one command per line: an operator copying a fix
  // out of a warning copies a line, and a two-step fix pasted as one step is
  // how half a remedy gets applied.
  if (m.remedy?.length) lines.push(`   Fix: ${m.remedy.join(" && ")}`);
  return lines;
}

/** What `flair upgrade` prints once its post-restart probe has PASSED. */
export interface VerifiedSummary {
  /** True when the run finished outside launchd — no unqualified success marker is emitted. */
  degraded: boolean;
  /** Exactly what to print. Written to stderr when degraded, stdout otherwise. */
  lines: string[];
}

/**
 * The final status line of a successful `flair upgrade`, given what the probe
 * found AND what launchd is doing.
 *
 * This is the reported defect reduced to a function, on purpose. The bug was
 * never in the probe — `healthy, authenticated, running <version>` was true —
 * it was that those three facts were rendered as an unqualified ✅ while a
 * fourth, unmeasured fact (the instance had been dropped out of its process
 * manager) was the one that mattered. Deciding it here rather than inline in
 * the command means the decision is testable without performing an upgrade,
 * which on the darwin path nothing else can do: no CI lane runs it.
 *
 * The verified facts are still reported in the degraded case. The upgrade DID
 * land, and hiding that would swap one misleading summary for another; what
 * changes is the marker and the sentence around it.
 */
export function renderVerifiedSummary(version: string | null, m: LaunchdManagement): VerifiedSummary {
  const facts = `healthy, authenticated${version ? `, running ${version}` : ""}`;
  if (!isDetached(m)) {
    return { degraded: false, lines: [`✅ verified: ${facts}`] };
  }
  return {
    degraded: true,
    lines: renderDetachedWarning(m, `upgrade landed (${facts}) but the instance is NOT running under launchd.`),
  };
}
