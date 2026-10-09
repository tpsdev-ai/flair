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
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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
 * Does this plist embed the admin password inline?
 *
 * The flair#1573 pass-file shape never contains this key: the launcher reads the
 * password from a 0600 file at start time. A plist with the key
 * `<key>HDB_ADMIN_PASSWORD</key>` is the pre-#1573 inline shape — a secret
 * written into a config file (world-readable), and a downgrade of an adopted
 * instance (flair#1693).
 *
 * Deliberately key-presence only: the pass-file launcher's argv names the file
 * but never the key, so there is no legitimate plist shape this misfires on. It
 * never returns plist contents — only the boolean.
 */
export function plistCarriesInlineAdminPassword(raw: string): boolean {
  return /<key>HDB_ADMIN_PASSWORD<\/key>/.test(raw);
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

/**
 * Validate a plist's CONTENT before it is written or loaded (flair#2040) —
 * the check that must pass before any command stops the running instance to
 * put this plist in its place.
 *
 * `diagnoseLaunchdPlistPaths` reads a plist that is already on disk and words
 * its finding as drift ("no longer exists"). This reads the document the caller
 * is ABOUT to install and answers a stricter question: can launchd run it?
 *
 *   - every absolute ProgramArguments entry exists;
 *   - ProgramArguments[0] — what launchd execs — is executable;
 *   - for the pass-file shape (`<launcher> <admin-pass-file> <node> <harper>`),
 *     the node binary the launcher execs is executable;
 *   - WorkingDirectory is an existing directory;
 *   - ROOTPATH (the data directory) is an existing directory.
 *
 * Returns one line naming the offending key and path, or null. Never returns
 * plist content — only the extracted paths (the plist may name the pass file).
 */
export function checkLaunchdPlistBeforeLoad(
  content: string,
  deps: {
    exists?: (p: string) => boolean;
    isExecutable?: (p: string) => boolean;
    isDirectory?: (p: string) => boolean;
  } = {},
): string | null {
  const exists = deps.exists ?? existsSync;
  const isExecutable = deps.isExecutable ?? ((p: string) => {
    try { accessSync(p, constants.X_OK); return true; } catch { return false; }
  });
  const isDirectory = deps.isDirectory ?? ((p: string) => {
    try { return statSync(p).isDirectory(); } catch { return false; }
  });
  const refs = readPlistProgramRefs("<content>", () => content);
  if (!refs || refs.programArguments.length === 0) return "the plist has no ProgramArguments";
  for (const arg of refs.programArguments) {
    if (arg.startsWith("/") && !exists(arg)) return `ProgramArguments names ${arg}, which does not exist`;
  }
  const program = refs.programArguments[0];
  if (!program.startsWith("/")) return `ProgramArguments[0] (${program}) is not an absolute path`;
  if (!isExecutable(program)) return `ProgramArguments[0] (${program}) is not executable, so launchd cannot exec it`;
  if (refs.programArguments.length >= 4 && refs.programArguments[0].endsWith(".sh")) {
    const node = refs.programArguments[2];
    if (node.startsWith("/") && !isExecutable(node)) return `the node binary the launcher execs (${node}) is not executable`;
  }
  const wd = refs.workingDirectory;
  if (wd === null) return "the plist has no WorkingDirectory";
  if (!isDirectory(wd)) return `WorkingDirectory ${wd} is not an existing directory`;
  const root = content.match(/<key>ROOTPATH<\/key>\s*<string>([^<]*)<\/string>/);
  if (!root) return "the plist has no ROOTPATH";
  const rootPath = unescapeXml(root[1]);
  if (!isDirectory(rootPath)) return `ROOTPATH ${rootPath} (the data directory) is not an existing directory`;
  return null;
}

/**
 * A service unit (launchd plist, systemd unit) whose node binary is not the
 * runtime this CLI runs under, classified as DELIBERATE or ERRONEOUS
 * (flair#2034 §2).
 *
 * A different node path is not by itself a defect: an operator can pin a
 * service to a runtime on purpose. What makes the pin a problem is what it
 * serves. The rule:
 *
 *   - `pinned` — the pinned node exists and the unit serves THIS CLI's own
 *     install tree. The service runs the same flair code under a runtime the
 *     operator chose; that is reported, never rewritten.
 *   - `erroneous` — the unit serves a DIFFERENT install tree than this CLI
 *     (the node-bump divergence: the unit's node and tree were both baked at an
 *     earlier runtime). Both are re-pointed together by `flair init`.
 *
 * Same runtime by realpath (a version-manager alias that resolves to the
 * current binary) is no pin at all → null. A MISSING pinned path is left to
 * `diagnoseLaunchdPlistPaths`, which names the missing file more precisely →
 * null. A unit with no node argument or no working directory is not ours to
 * judge → null.
 */
export interface ServiceNodePin {
  kind: "pinned" | "erroneous";
  unitNodeBin: string;
  currentNodeBin: string;
  message: string;
  /** Commands that re-point the unit. Empty for a deliberate pin. */
  remedy: string[];
}

export interface NodePinDeps {
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
}

function realpathOr(p: string, realpath: (p: string) => string): string {
  try {
    return realpath(p);
  } catch {
    return p;
  }
}

export function classifyServiceNodePin(
  input: {
    /** How to name the unit in a message, e.g. "the launchd plist at /x.plist". */
    unitDescription: string;
    unitNodeBin: string | null;
    unitTree: string | null;
    currentNodeBin: string;
    cliTree: string;
  },
  deps: NodePinDeps = {},
): ServiceNodePin | null {
  const exists = deps.exists ?? existsSync;
  const realpath = deps.realpath ?? ((p: string) => realpathSync(p));
  const { unitNodeBin, unitTree, currentNodeBin, cliTree, unitDescription } = input;
  if (!unitNodeBin || !unitTree) return null;
  if (!exists(unitNodeBin)) return null; // the missing path is diagnoseLaunchdPlistPaths's
  if (realpathOr(unitNodeBin, realpath) === realpathOr(currentNodeBin, realpath)) return null;

  if (realpathOr(unitTree, realpath) === realpathOr(cliTree, realpath)) {
    return {
      kind: "pinned",
      unitNodeBin,
      currentNodeBin,
      // `flair init` never rewrites a pin (it reports `pinned-node` and writes
      // nothing), so the only way to move it is by hand — said as such.
      message:
        `${unitDescription} pins node ${unitNodeBin} while this CLI runs ${currentNodeBin}, and it serves this ` +
        `CLI's own install tree (${unitTree}). That is treated as a deliberate runtime pin and left as it is; ` +
        "`flair init` does not change it. To move the service to this CLI's runtime, change that node path to " +
        `${currentNodeBin} in the unit by hand, then run: flair restart`,
      remedy: [],
    };
  }
  return {
    kind: "erroneous",
    unitNodeBin,
    currentNodeBin,
    message:
      `${unitDescription} runs node ${unitNodeBin} from the install tree ${unitTree}, but this CLI runs node ` +
      `${currentNodeBin} from ${cliTree}. Both were baked at an earlier runtime, so the service keeps serving ` +
      "the old tree while the CLI runs from the current one.",
    remedy: ["flair init", "flair restart"],
  };
}

/**
 * `classifyServiceNodePin` for a launchd plist: reads the node argument and the
 * WorkingDirectory out of the plist and classifies them against this CLI.
 */
export function diagnoseLaunchdNodePath(
  plistPath: string,
  currentNodeBin: string,
  cliTree: string,
  deps: NodePinDeps & { read?: (p: string) => string } = {},
): ServiceNodePin | null {
  const refs = readPlistProgramRefs(plistPath, deps.read);
  if (!refs) return null;
  const unitNodeBin = refs.programArguments.find((a) => a.startsWith("/") && /(^|[/\\])node$/.test(a)) ?? null;
  return classifyServiceNodePin(
    {
      unitDescription: `the launchd plist at ${plistPath}`,
      unitNodeBin,
      unitTree: refs.workingDirectory,
      currentNodeBin,
      cliTree,
    },
    deps,
  );
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
  /**
   * flair#2056: the caller's check on the pidfile pid
   * (resolveInstanceServingPid: a Harper-shaped command line and no
   * disagreeing flair#1454 sidecar). When given, a live pidfile pid is
   * returned only if it answers true; otherwise the first port listener is
   * returned, if there is one, and that can be the same pid. Omitted by
   * callers that have not gathered this evidence.
   */
  isPidFileEvidence?: (pid: number) => boolean;
}): number | null {
  const { pidFilePid, isAlive, listeningPids, isPidFileEvidence } = input;
  if (pidFilePid !== null && isAlive(pidFilePid) && (isPidFileEvidence === undefined || isPidFileEvidence(pidFilePid))) {
    return pidFilePid;
  }
  return listeningPids.length > 0 ? listeningPids[0] : null;
}

// ─── the verdict ──────────────────────────────────────────────────────────

export type LaunchdManagementState =
  /** Not macOS — launchd is not the process manager here and nothing is claimed. */
  | "not-applicable"
  /** macOS, but no service is registered for this instance. Never was managed; not a degradation. */
  | "no-service"
  /**
   * A service is registered AND launchd is running this instance's process:
   * launchd's pid and the IDENTIFIED serving pid are the same number.
   */
  | "managed"
  /**
   * launchd is running the job, but the process serving this instance could
   * not be identified (no live hdb.pid, no port listener found), so whether
   * launchd serves it is UNKNOWN (flair#2040). Not an alarm — nothing shows it
   * is detached — and never a success: see verifyLaunchdManagement.
   */
  | "unverified"
  /** A service is registered and launchd is NOT running this instance's process. */
  | "detached";

export interface LaunchdManagement {
  state: LaunchdManagementState;
  /** The label examined, when there was one. */
  label?: string;
  /** One line of evidence for the verdict. Present for every state. */
  detail: string;
  /** Commands that restore management. Present for "detached" (and "unverified"). */
  remedy?: string[];
  /** launchd's pid for the job, when it reported one. */
  launchdPid?: number | null;
  /** The pid identified as serving this instance, or null when it could not be identified. */
  servingPid?: number | null;
}

/** True when the instance is running outside the service manager that is registered to own it. */
export function isDetached(m: LaunchdManagement): boolean {
  return m.state === "detached";
}

/**
 * The STRICT verifier every success claim goes through (flair#2040): a
 * launchd check mark from `flair start` or `flair init`, and `doctor --fix`'s
 * "repaired". Verified ONLY when launchd reported a pid, a serving pid was
 * IDENTIFIED, and they are the same number. An unknown serving pid is never
 * verified — unknown evidence must not license a success claim.
 *
 * `assessLaunchdManagement` is the observer (status, warnings); this decides
 * what may be claimed.
 */
export function verifyLaunchdManagement(
  m: LaunchdManagement,
): { verified: true; pid: number; detail: string } | { verified: false; detail: string; remedy?: string[] } {
  if (
    m.state === "managed" &&
    typeof m.launchdPid === "number" &&
    typeof m.servingPid === "number" &&
    m.launchdPid === m.servingPid
  ) {
    return { verified: true, pid: m.launchdPid, detail: m.detail };
  }
  return { verified: false, detail: m.detail, remedy: m.remedy };
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
 *   - launchd reports a PID and we cannot identify the instance's own ⇒
 *     **unverified** (flair#2040). Warning on it would alarm healthy installs,
 *     which is its own defect; calling it managed would be a claim without
 *     proof. It is neither: no warning, and no success claim
 *     (verifyLaunchdManagement refuses it).
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
      launchdPid: job.pid,
      servingPid: instancePid,
    };
  }

  if (instancePid === null) {
    // flair#2040: launchd runs SOMETHING, but nothing identifies the process
    // serving this instance. Not detached (no evidence of that, and a warning
    // on a healthy install trains operators to skip warnings) — and not
    // managed either: an unknown serving pid is not proof.
    return {
      state: "unverified",
      label,
      detail:
        `launchd job ${label} is running as process ${job.pid}, but the process serving this instance could not be ` +
        "identified (no live hdb.pid, and no listener found on its port), so launchd management is NOT verified",
      remedy: ["flair restart"],
      launchdPid: job.pid,
      servingPid: null,
    };
  }

  return {
    state: "managed",
    label,
    detail: `launchd job ${label} is running as process ${job.pid}`,
    launchdPid: job.pid,
    servingPid: instancePid,
  };
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

// ─── the managed-start confirmation warning (flair#2422) ────────────────────

/**
 * What a CLI-managed launchd start's confirmation probe saw on the instance's
 * port (flair#2422): a Flair-shaped answer (`flair`); a response that was not
 * a Flair health answer, non-2xx or not Flair-shaped (`foreign`); a refused
 * connection (`refused`); or it could not reach the port, from a timeout or
 * network error (`unreachable`). The reachability wait that precedes the probe
 * accepts any 2xx or 401, so it cannot tell Flair from a decoy; the probe
 * requires a Flair-shaped body.
 */
export type ManagedStartConfirmation = "flair" | "foreign" | "refused" | "unreachable";

/**
 * The lines for an unconfirmed managed start (flair#2422). Names what was
 * observed: the reachability wait before the probe passed, and the probe's
 * result by name. "Flair is running" is printed for `flair` — the result whose
 * probe saw Flair shape — and the other results say what they saw instead.
 * Kept here so the wording is assertable without a launchd host.
 */
export function renderManagedStartUnconfirmed(input: {
  port: number;
  confirmation: ManagedStartConfirmation;
  detail: string;
  moved?: string;
  /** The launchd observer's detail (LaunchdManagement.detail), printed on its own line. */
  launchdDetail?: string;
  remedy?: string[];
}): string[] {
  const { port, confirmation, detail, moved, launchdDetail, remedy } = input;
  const headline: Record<ManagedStartConfirmation, string> = {
    flair: `Flair is running on port ${port}, but it is NOT verified as launchd-managed`,
    foreign: `The initial reachability wait on port ${port} passed, but the confirmation probe got a response that was not a Flair health answer (non-2xx or not Flair-shaped), so Flair is NOT verified as launchd-managed`,
    refused: `The initial reachability wait on port ${port} passed, but the confirmation probe's connection was refused (nothing was listening), so Flair is NOT verified as launchd-managed`,
    unreachable: `The initial reachability wait on port ${port} passed, but the confirmation probe could not reach the port (timeout or network error), so Flair is NOT verified as launchd-managed`,
  };
  const lines = [`⚠️  ${headline[confirmation]}`, `   ${detail}`];
  if (moved) lines.push(`   ${moved}`);
  if (launchdDetail) lines.push(`   ${launchdDetail}`);
  if (remedy?.length) lines.push(`   Fix: ${remedy.join(" && ")}`);
  return lines;
}

// renderVerifiedSummary used to live here and qualify ✅ from version +
// LaunchdManagement alone (flair#1022). That signature was the ceiling on
// what it could notice — a blacklist of one known-unhealthy form. The
// enumerated doctor runner in doctor-run.ts is now the source of the
// success marker (flair#1439). renderDetachedWarning stays: it is the
// wording for a detached launchd check, used by the runner and by
// `flair restart`.
