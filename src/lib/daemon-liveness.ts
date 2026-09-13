/**
 * daemon-liveness.ts — the five-state liveness machine for a local Flair
 * (Harper) daemon (flair#1454).
 *
 * The defect this replaces: `flair stop` decided "not running" from a single
 * `lsof -ti :<port>` whose `catch` converted "lsof unavailable" into "nothing
 * is listening" — absence rendered as a definite negative. `flair start` then
 * "succeeded" over the live daemon it had just failed to see, and a
 * `stop; start` wrapper (a systemd `Type=forking` unit's `ExecStop`, say)
 * produced a second daemon while the first kept running.
 *
 * The fix is a classifier with FIVE states, not a boolean:
 *
 *   RUNNING       identity-verified pid alive  +  flair-identified /Health 2xx
 *   NOT_RUNNING   no pidfile, or verified dead  +  port refused
 *   WEDGED        identity-VERIFIED pid alive   +  not serving   -> stop ACTS
 *   DISAGREEMENT  evidence conflicts, identity NOT verified       -> stop REFUSES
 *   UNKNOWN       insufficient evidence to classify               -> stop REFUSES
 *
 * THE INVARIANT (the whole design): WEDGED is reachable ONLY when the pidfile
 * identity has been VERIFIED. The same physical evidence with an unverified
 * identity lands in DISAGREEMENT. This is encoded structurally — the classifier
 * takes the identity-check RESULT as an input, and there is no code path to
 * WEDGED that bypasses it. Killing a wedged daemon is recovery only when we
 * have proven the pid is ours; without that proof it is a recycled-PID gamble
 * and the machine refuses.
 *
 * Identity is carried by a sidecar (`<dataDir>/flair-daemon.json`) that flair
 * writes at spawn — `{ pid, startTimeMs, port, flairVersion }` — because
 * `hdb.pid` is written by the Harper process itself and flair does not own its
 * format. Verification = hdb.pid's pid matches the sidecar pid AND the live
 * process's start time matches the sidecar's startTimeMs (±2s).
 *
 * This module is PURE: it classifies and parses, and never touches the
 * filesystem, the network, or a process. The adapters that do (O_NOFOLLOW
 * reads, `kill(pid, 0)`, the health probe, the start-time readers) live in
 * `src/cli.ts`, so every branch here is unit-testable without a daemon.
 */

/** The five states, as a discriminated union — never booleans. */
export type DaemonState =
  | { state: "RUNNING"; pid: number }
  | { state: "NOT_RUNNING" }
  | { state: "WEDGED"; pid: number }
  | { state: "DISAGREEMENT"; detail: string }
  | { state: "UNKNOWN"; detail: string };

/**
 * The identity-check RESULT, fed into the classifier as an input. The WEDGED
 * branch is gated on `kind === "verified"` and nothing else can reach it.
 */
export type IdentityResult =
  | { kind: "verified"; pid: number }
  | { kind: "unverified"; reason: string }
  | { kind: "none" };

/** `kill(pid, 0)` is a three-way, not a boolean. */
export type PidLiveness =
  | { kind: "alive" }
  | { kind: "gone" }   // ESRCH
  | { kind: "eperm" }; // exists, but another user's

/**
 * The health probe. `ok` is flair-identified 2xx — not "any HTTP answered"
 * (flair#1478). A decoy that returns 200 on `/Health` is `foreign`.
 */
export type HealthResult =
  | { kind: "ok" }          // 2xx AND body is flair's /Health shape
  | { kind: "foreign" }     // HTTP answered, but not flair-identified 2xx
  | { kind: "refused" }     // ECONNREFUSED — nothing is listening
  | { kind: "unreachable" }; // timeout / other — cannot tell

/** Something accepted a TCP connection and spoke HTTP — flair or not. */
export function healthIndicatesListener(health: HealthResult): boolean {
  return health.kind === "ok" || health.kind === "foreign";
}

/**
 * Listener-pid membership against the process we launched (flair#1478).
 * `listenerPids === null` or `[]` means we could not attribute — best-effort
 * skip, never a definite negative (the #1454 scar: lsof absence is not
 * "not running"). A non-empty set that omits the launched pid is a mismatch:
 * a stale or foreign process holds the port.
 */
export type PortOwnerResult =
  | { kind: "match" }
  | { kind: "mismatch"; listenerPids: number[] }
  | { kind: "unavailable" };

/**
 * Worktree / dataDir identity of the listener (flair#1478). Unavailable
 * when we cannot inspect the process; mismatch when we can and it is not
 * the instance we launched.
 */
export type InstanceMatch =
  | { kind: "match" }
  | { kind: "mismatch"; reason: string }
  | { kind: "unavailable" };

export type PidfileRead =
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string }
  | { kind: "present"; pid: number };

export type SidecarRead =
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string }
  | { kind: "present"; pid: number; startTimeMs: number; port: number; flairVersion: string };

/** Everything the classifier needs, already gathered by the adapters. */
export interface DaemonEvidence {
  /** Non-null reason when the data dir is a symlink or world-writable. */
  dataDirUnsafe: string | null;
  pidfile: PidfileRead;
  /** Liveness of the pidfile pid; null when there is no pid to test. */
  pidLiveness: PidLiveness | null;
  identity: IdentityResult;
  health: HealthResult;
}

/** Rendering context only — never consulted for the verdict. */
export interface DaemonContext {
  port: number;
  dataDir: string;
}

/**
 * Classify the gathered evidence into one of the five states.
 *
 * The WEDGED gate is the first branch and the only one that can return WEDGED:
 * it requires `identity.kind === "verified"` AND `pidLiveness.kind === "alive"`.
 * Every other "alive" pid — unverified identity, or EPERM — is DISAGREEMENT.
 */
export function classifyDaemonState(ev: DaemonEvidence, ctx: DaemonContext): DaemonState {
  if (ev.dataDirUnsafe !== null) {
    return { state: "UNKNOWN", detail: ev.dataDirUnsafe };
  }
  if (ev.pidfile.kind === "unreadable") {
    return { state: "UNKNOWN", detail: ev.pidfile.reason };
  }

  const pid = ev.pidfile.kind === "present" ? ev.pidfile.pid : null;
  const liveness = ev.pidLiveness;

  // THE INVARIANT: WEDGED is reachable only through a VERIFIED identity.
  // RUNNING requires flair-identified /Health — a foreign 200 is not RUNNING
  // (flair#1478). Verified + alive + foreign lands in WEDGED: our pid is
  // proven, but it is not serving flair's /Health.
  if (ev.identity.kind === "verified" && liveness?.kind === "alive") {
    if (ev.health.kind === "ok") {
      return { state: "RUNNING", pid: ev.identity.pid };
    }
    return { state: "WEDGED", pid: ev.identity.pid };
  }

  // No live pid recorded (absent, or the recorded pid is gone).
  if (pid === null || liveness?.kind === "gone") {
    if (ev.health.kind === "refused") {
      return { state: "NOT_RUNNING" };
    }
    if (healthIndicatesListener(ev.health)) {
      return {
        state: "DISAGREEMENT",
        detail: pid === null
          ? `a process is serving port ${ctx.port}, but no pid is recorded under ${ctx.dataDir}`
          : `a process is serving port ${ctx.port}, but the recorded pid ${pid} is not alive`,
      };
    }
    return {
      state: "UNKNOWN",
      detail:
        `could not determine whether Flair is running: ` +
        `${pid === null ? "no pid is recorded" : `recorded pid ${pid} is not alive`} ` +
        `and the health check on port ${ctx.port} did not respond`,
    };
  }

  // EPERM — the recorded pid exists but belongs to another user.
  if (liveness?.kind === "eperm") {
    return {
      state: "DISAGREEMENT",
      detail: `the recorded pid ${pid} exists but belongs to another user — refusing to act on it`,
    };
  }

  // Alive, but identity NOT verified — the WEDGED shape without the proof.
  if (liveness?.kind === "alive") {
    const reason = ev.identity.kind === "unverified" ? ev.identity.reason : "no identity sidecar";
    return {
      state: "DISAGREEMENT",
      detail: `the recorded pid ${pid} is alive, but its identity could not be verified (${reason}) — refusing to act on it`,
    };
  }

  return { state: "UNKNOWN", detail: "could not determine whether Flair is running" };
}

/**
 * Verify the pidfile identity against the sidecar. Pure — `readStartTime` is
 * injected so the live-process read (the only non-deterministic part) stays in
 * the adapter layer.
 *
 * Verified requires ALL of: a pidfile pid, a readable sidecar, matching pids,
 * a readable live start time, and a start time within `toleranceMs` (±2s).
 * Any shortfall is `unverified` (or `none` when there is nothing to check).
 */
export function verifyIdentity(input: {
  pidfilePid: number | null;
  sidecar: SidecarRead;
  readStartTime: (pid: number) => number | null;
  toleranceMs?: number;
}): IdentityResult {
  const tolerance = input.toleranceMs ?? 2000;

  if (input.pidfilePid === null) {
    return { kind: "none" };
  }
  if (input.sidecar.kind === "absent") {
    return { kind: "none" };
  }
  if (input.sidecar.kind === "unreadable") {
    return { kind: "unverified", reason: input.sidecar.reason };
  }
  if (input.pidfilePid !== input.sidecar.pid) {
    return {
      kind: "unverified",
      reason: `hdb.pid names pid ${input.pidfilePid} but the sidecar records pid ${input.sidecar.pid}`,
    };
  }
  const actual = input.readStartTime(input.pidfilePid);
  if (actual === null) {
    return { kind: "unverified", reason: `could not read the start time of pid ${input.pidfilePid}` };
  }
  if (!isStartTimeMatch(actual, input.sidecar.startTimeMs, tolerance)) {
    return {
      kind: "unverified",
      reason: `pid ${input.pidfilePid} started at ${actual}ms but the sidecar records ${input.sidecar.startTimeMs}ms`,
    };
  }
  return { kind: "verified", pid: input.pidfilePid };
}

/** `|actual - recorded| <= tolerance`. */
export function isStartTimeMatch(actualMs: number, recordedMs: number, toleranceMs = 2000): boolean {
  return Math.abs(actualMs - recordedMs) <= toleranceMs;
}

/**
 * Parse `/proc/<pid>/stat` field 22 (starttime, in clock ticks).
 *
 * Field 2 (comm) is parenthesised and may itself contain spaces and `)`
 * characters, so the split is on the LAST `)` — not the first space, which is
 * the classic bug that mangles any process whose comm has a space in it.
 * Returns the raw tick count; the ticks→epoch conversion (which needs boot
 * time and CLK_TCK) lives in the adapter.
 */
export function parseProcStatStartTime(stat: string): number | null {
  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 0) return null;
  const rest = stat.slice(closeParen + 1).trim().split(/\s+/);
  // rest[0] is field 3 (state); field 22 (starttime) is therefore rest[19].
  const starttime = Number(rest[19]);
  return Number.isFinite(starttime) ? starttime : null;
}

/**
 * Convert a `/proc/<pid>/stat` starttime (clock ticks since boot) to epoch ms,
 * given the system uptime in seconds and the current wall clock. Pure so the
 * arithmetic is testable without a live process.
 */
export function procStartTimeToEpochMs(
  starttimeTicks: number,
  uptimeSeconds: number,
  nowMs: number,
  clkTck = 100,
): number {
  const bootTimeMs = nowMs - uptimeSeconds * 1000;
  return bootTimeMs + (starttimeTicks / clkTck) * 1000;
}

/**
 * Parse `ps -o lstart= -p <pid>` output ("Sat Aug 29 15:03:22 2026") to epoch
 * ms. Returns null when the output is empty or unparseable — the caller treats
 * that as "identity unverified", never as a verdict toward the destructive
 * branch.
 */
export function parsePsLstart(output: string): number | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/** The sidecar's on-disk shape. */
export interface DaemonSidecar {
  pid: number;
  startTimeMs: number;
  port: number;
  flairVersion: string;
}

/**
 * Parse the sidecar JSON. Returns null on malformed content or a missing /
 * non-positive pid/startTimeMs/port — the caller reports that as "unreadable".
 */
export function parseSidecarJson(content: string): DaemonSidecar | null {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  const pid = Number(rec.pid);
  const startTimeMs = Number(rec.startTimeMs);
  const port = Number(rec.port);
  const flairVersion = typeof rec.flairVersion === "string" ? rec.flairVersion : "";
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isFinite(startTimeMs)) return null;
  if (!Number.isInteger(port) || port <= 0) return null;
  return { pid, startTimeMs, port, flairVersion };
}

/**
 * Flair's public `/Health` fingerprint (resources/search-readiness.ts
 * `buildPublicHealthBody`). `ok: true` alone is not enough — a decoy can
 * return that. Require the fields that distinguish flair from "an HTTP
 * server answered": `version`, `searchReady`, and `buildCommit` (always
 * present, string or null).
 */
export function isFlairHealthBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const rec = body as Record<string, unknown>;
  if (typeof rec.ok !== "boolean") return false;
  if (typeof rec.version !== "string" || rec.version.length === 0) return false;
  if (typeof rec.searchReady !== "boolean") return false;
  if (!("buildCommit" in rec)) return false;
  if (rec.buildCommit !== null && typeof rec.buildCommit !== "string") return false;
  return true;
}

/**
 * Classify a finished HTTP probe or a network error. Pure so the adapter
 * (fetch) stays in cli.ts and every branch is unit-testable.
 */
export function classifyHealthProbe(
  input:
    | { kind: "response"; status: number; body: unknown }
    | { kind: "network-error"; code?: string },
): HealthResult {
  if (input.kind === "network-error") {
    if (input.code === "ECONNREFUSED" || input.code === "ConnectionRefused") {
      return { kind: "refused" };
    }
    return { kind: "unreachable" };
  }
  if (input.status >= 200 && input.status < 300 && isFlairHealthBody(input.body)) {
    return { kind: "ok" };
  }
  return { kind: "foreign" };
}

/** Trailing-slash-insensitive lexical compare — no filesystem, no realpath. */
export function canonicalLexicalPath(p: string): string {
  if (p === "/" || p === "") return "/";
  return p.replace(/[/\\]+$/, "");
}

/**
 * Bind the launched pid to the port's listener set. Empty / null is
 * unavailable (best-effort skip). A populated set that omits `launchedPid`
 * is a stale/foreign holder — not healed.
 */
export function classifyPortOwner(input: {
  launchedPid: number;
  listenerPids: number[] | null;
}): PortOwnerResult {
  if (input.listenerPids === null || input.listenerPids.length === 0) {
    return { kind: "unavailable" };
  }
  if (input.listenerPids.includes(input.launchedPid)) {
    return { kind: "match" };
  }
  return { kind: "mismatch", listenerPids: input.listenerPids };
}

/**
 * Confirm the listener is the flair instance we launched: worktree (cwd /
 * cmdline resolves to `@tpsdev-ai/flair`) and dataDir (`ROOTPATH`). Each
 * check is fail-closed when we could inspect, and skipped when we could not.
 */
export function classifyInstanceMatch(input: {
  expectedDataDir: string;
  processRootPath: string | null;
  environReadable: boolean;
  servingFlairPackage: boolean | null;
}): InstanceMatch {
  if (input.servingFlairPackage === false) {
    return { kind: "mismatch", reason: "listener is not a flair worktree" };
  }
  if (input.environReadable) {
    if (!input.processRootPath) {
      return { kind: "mismatch", reason: "listener process has no ROOTPATH" };
    }
    if (canonicalLexicalPath(input.processRootPath) !== canonicalLexicalPath(input.expectedDataDir)) {
      return {
        kind: "mismatch",
        reason:
          `listener ROOTPATH ${input.processRootPath} is not dataDir ${input.expectedDataDir}`,
      };
    }
  }
  const worktreeKnown = input.servingFlairPackage === true;
  const dataDirKnown = input.environReadable && input.processRootPath !== null;
  if (worktreeKnown || dataDirKnown) return { kind: "match" };
  return { kind: "unavailable" };
}

/** `/proc/<pid>/environ` is NUL-separated `KEY=value`. */
export function parseNullSeparatedEnviron(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

export function extractRootPath(environ: Record<string, string>): string | null {
  const v = environ.ROOTPATH;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * The #1454 sidecar self-heal gate (flair#1478). Adopt a reconstructed
 * sidecar ONLY when /Health is flair-identified AND the port-owning pid
 * is the launched instance (worktree/dataDir). Port-owner or instance
 * `unavailable` is a best-effort skip — not a green light and not a
 * refusal. `mismatch` on either is NOT healed. False-green is worse
 * than no self-heal.
 */
export function shouldAdoptMissingSidecar(input: {
  sidecarAbsent: boolean;
  dataDirSafe: boolean;
  pidfilePresent: boolean;
  pidAlive: boolean;
  health: HealthResult;
  portOwner: PortOwnerResult;
  instanceMatch: InstanceMatch;
}): boolean {
  if (!input.sidecarAbsent || !input.dataDirSafe || !input.pidfilePresent || !input.pidAlive) {
    return false;
  }
  if (input.health.kind !== "ok") return false;
  if (input.portOwner.kind === "mismatch") return false;
  if (input.instanceMatch.kind === "mismatch") return false;
  return true;
}
