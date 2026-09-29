/**
 * launchd-domain-preflight.ts — can THIS process load and start this
 * instance's launchd job, in the domain the job belongs to, right now?
 * (flair#2040).
 *
 * THE INCIDENT. `flair doctor --fix` over ssh clean-stopped a HEALTHY instance,
 * then failed to load the launchd job — leaving Flair down. From that ssh
 * session the per-user GUI launchd domain was not reachable: `launchctl print
 * gui/<uid>` returned `125: Domain does not support specified action` and
 * `launchctl bootstrap user/<uid>` returned `5: Input/output error`. `flair
 * init` had printed "Launchd service registered ✓" for a plist it wrote but
 * never loaded.
 *
 * THE RULE this module serves, for the guarded launchd handoffs — `doctor
 * --fix`'s adopt/regenerate, `flair init`'s replacement of a legacy job, and
 * the launchd attempt in `flair start` and in the start leg of restart /
 * upgrade / snapshot: nothing running is stopped or unloaded before every
 * check that can be made from this session has passed, an UNKNOWN answer is a
 * failed check, and every failure after a stop is followed by an attempt to
 * bring back what was running, reporting the state it left (or that the state
 * could not be established). `flair restart` itself stops the instance first
 * — that is what it was asked to do — so its start leg's preflight decides
 * only HOW it comes back (under launchd, or directly), not whether it stopped.
 *
 * WHAT IS CHECKED, AND HOW. Everything here is READ-ONLY:
 *
 *   launchctl print gui/<uid>              is the GUI domain reachable from here?
 *   launchctl print-disabled gui/<uid>     is this job's label disabled there?
 *
 * `print` and `print-disabled` only read launchd's state; they never load,
 * start, bootstrap, unload or enable anything. What they cannot do is PROVE a
 * later `bootstrap` will succeed — only loading something proves that — so the
 * callers treat a passed preflight as "allowed to try", and restore on failure.
 *
 * WHY THE LOAD COMMANDS NAME THE DOMAIN. The legacy subcommands `launchctl
 * load/unload/start` act on whatever domain launchctl infers for the CALLING
 * process. Over ssh that is not the GUI domain (`launchctl managername` reports
 * `Background` in a session where `print gui/<uid>` still answers), so a
 * successful `print gui/<uid>` said nothing about where `load` would put the
 * job. The load sequence therefore uses the targeted forms:
 *
 *   launchctl bootout   gui/<uid>/<label>
 *   launchctl bootstrap gui/<uid> <plist>
 *   launchctl kickstart gui/<uid>/<label>
 *
 * so the preflight and the load are about the SAME domain, and a failure is
 * reported by the command that failed, for that domain.
 *
 * Pure and injected: every runner is a seam, so a test never touches launchd.
 */

/** Ceiling on a domain probe; a hung launchctl must not hang the CLI. */
export const DOMAIN_PROBE_TIMEOUT_MS = 5_000;

export type DomainAvailability =
  | { state: "available" }
  | { state: "unavailable"; reason: string }
  | { state: "unknown"; reason: string }
  | { state: "not-applicable"; reason: string };

/**
 * Everything the preflight can say about loading ONE job: the domain's
 * availability, plus `disabled` when the domain answers but the job's label is
 * disabled in it (launchd refuses to bootstrap a disabled service).
 */
export type LaunchdLoadability =
  | DomainAvailability
  | { state: "disabled"; reason: string; label: string };

/** Runs one read-only launchctl query; injected so tests never touch real launchd. */
export type DomainProbeRunner = () => { code: number | null; stdout: string; stderr: string };

/** The GUI domain a per-user LaunchAgent must be loaded into. */
export function launchdGuiDomain(uid: number): string {
  return `gui/${uid}`;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function probeSummary(command: string, code: number | null, text: string): string {
  const detail = firstLine(text);
  if (code === null) return `launchctl ${command} did not run${detail ? `: ${detail}` : ""}`;
  return `launchctl ${command} exited ${code}${detail ? `: ${detail}` : ""}`;
}

/**
 * The signatures of a GUI domain that this session cannot load into. `125`
 * ("Domain does not support specified action") is the code measured over ssh in
 * flair#2040; `5` ("Input/output error") is what `bootstrap` returned in the
 * same session. The text forms cover the other wordings launchd uses for an
 * unreachable domain. Anything else non-zero is `unknown`, never `available`.
 */
const UNREACHABLE_SIGNATURE =
  /domain does not support specified action|could not find domain|no such domain|unknown domain|input\/output error|operation not permitted|not permitted/i;

/**
 * Is the target GUI domain reachable from this process? Runs the read-only
 * `launchctl print gui/<uid>`. `code 0` is available; the unreachable
 * signatures (and codes 125/5) are `unavailable`; anything else (spawn failure,
 * an uninterpretable code) is `unknown`, which every caller treats as "do not
 * stop anything".
 */
export function assessLaunchdDomain(opts: {
  platform: string;
  uid: number;
  run: DomainProbeRunner;
}): DomainAvailability {
  if (opts.platform !== "darwin") {
    return { state: "not-applicable", reason: `${opts.platform} does not use launchd` };
  }
  const target = launchdGuiDomain(opts.uid);
  let res: { code: number | null; stdout: string; stderr: string };
  try {
    res = opts.run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { state: "unknown", reason: `could not run launchctl print ${target}: ${message}` };
  }
  const text = `${res.stderr}\n${res.stdout}`.trim();
  if (res.code === 0) return { state: "available" };
  if (res.code === 125 || res.code === 5 || UNREACHABLE_SIGNATURE.test(text)) {
    return { state: "unavailable", reason: probeSummary(`print ${target}`, res.code, text) };
  }
  return { state: "unknown", reason: probeSummary(`print ${target}`, res.code, text) };
}

/**
 * Is `label` disabled in the output of `launchctl print-disabled gui/<uid>`?
 *
 * Two output forms are in the wild: `"<label>" => disabled|enabled` (macOS 13
 * and later) and `"<label>" => true|false` (earlier; `true` means disabled). A
 * label that is not listed is enabled — launchd lists only overrides.
 */
export function parsePrintDisabled(output: string, label: string): boolean {
  // Match the quoted label as plain text and read its value with a fixed
  // pattern: no expression is built from the label.
  const quoted = `"${label}"`;
  for (const line of output.split("\n")) {
    const at = line.indexOf(quoted);
    if (at < 0) continue;
    const m = /^\s*=>\s*(\w+)/.exec(line.slice(at + quoted.length));
    if (!m) continue;
    return m[1] === "disabled" || m[1] === "true";
  }
  return false;
}

/**
 * The full read-only preflight for loading `label` into the GUI domain: the
 * domain probe first, then — only when the domain answers — whether the label
 * is disabled there. A failed `print-disabled` is `unknown` (fail closed).
 */
export function assessLaunchdLoadability(opts: {
  platform: string;
  uid: number;
  label: string;
  printDomain: DomainProbeRunner;
  printDisabled: DomainProbeRunner;
}): LaunchdLoadability {
  const domain = assessLaunchdDomain({ platform: opts.platform, uid: opts.uid, run: opts.printDomain });
  if (domain.state !== "available") return domain;
  const target = launchdGuiDomain(opts.uid);
  let res: { code: number | null; stdout: string; stderr: string };
  try {
    res = opts.printDisabled();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { state: "unknown", reason: `could not run launchctl print-disabled ${target}: ${message}` };
  }
  if (res.code !== 0) {
    return { state: "unknown", reason: probeSummary(`print-disabled ${target}`, res.code, `${res.stderr}\n${res.stdout}`) };
  }
  // flair#2040: "not listed" means enabled only in output we RECOGNISE. An
  // unrecognised listing (no `disabled services` block) is unknown, not a
  // silent "enabled".
  if (!/disabled services/i.test(res.stdout)) {
    return {
      state: "unknown",
      reason: `launchctl print-disabled ${target} printed no "disabled services" listing, so whether ${opts.label} is disabled is unknown`,
    };
  }
  if (parsePrintDisabled(res.stdout, opts.label)) {
    return {
      state: "disabled",
      label: opts.label,
      reason: `the launchd job ${opts.label} is disabled in ${target} (launchctl print-disabled ${target}), so launchd would refuse to load it`,
    };
  }
  return { state: "available" };
}

/** True when the preflight allows an attempt (available, or not macOS). */
export function loadabilityAllowsAttempt(l: LaunchdLoadability): boolean {
  return l.state === "available" || l.state === "not-applicable";
}

/** One clause naming why launchd cannot be used from here (for the messages below). */
export function describeLoadabilityProblem(l: Exclude<LaunchdLoadability, { state: "available" } | { state: "not-applicable" }>): string {
  switch (l.state) {
    case "unavailable":
      return `the launchd GUI domain is unavailable from this session (${l.reason})`;
    case "unknown":
      return `the launchd GUI domain could not be verified from this session (${l.reason})`;
    case "disabled":
      return l.reason;
  }
}

/** The remedy for a failed preflight: what the operator runs, and where. */
export function loadabilityRemedy(
  l: Exclude<LaunchdLoadability, { state: "available" } | { state: "not-applicable" }>,
  uid: number,
  rerun: string,
): string {
  if (l.state === "disabled") {
    return `run 'launchctl enable ${launchdGuiDomain(uid)}/${l.label}', then '${rerun}'`;
  }
  return `run '${rerun}' from a console (GUI) login session on this Mac`;
}

/**
 * The conditional sentence about RunAtLoad. It is what launchd MAY do — it
 * reads the plist at the next console login and starts a job that sets
 * RunAtLoad — not a guarantee: a plist that is invalid, points at a missing
 * program, or whose job is disabled does not start.
 */
export const RUN_AT_LOAD_NOTE =
  "launchd may also start the job at the next console login (the plist sets RunAtLoad), " +
  "provided the plist is valid and the job is enabled";

/**
 * What happens if launchd starts the job while a DIRECT process serves the same
 * data directory: the product launcher finds the live pid in `<dataDir>/hdb.pid`
 * and exits without starting a second Harper (templates/launchd/
 * start-flair-with-admin-pass.sh).
 */
export const DIRECT_PROCESS_GUARD_NOTE =
  "while a direct process serves this data directory, a launchd start of the job exits without starting a second instance";

// ─── doctor --fix ─────────────────────────────────────────────────────────

/**
 * The `doctor --fix` refusal when the preflight fails. Actor + state + remedy,
 * and an explicit statement that nothing was touched.
 */
export function renderDomainUnavailableMessage(
  l: Exclude<LaunchdLoadability, { state: "available" } | { state: "not-applicable" }>,
  uid: number,
): string {
  return (
    `flair doctor --fix: refusing to repair launchd management — ${describeLoadabilityProblem(l)}. ` +
    "Nothing was stopped, unloaded or rewritten; a running instance was left running. " +
    `Fix: ${loadabilityRemedy(l, uid, "flair doctor --fix")}. ` +
    `If this instance's plist is already on disk, ${RUN_AT_LOAD_NOTE}.`
  );
}

// ─── flair start / restart (direct-start fallback) ────────────────────────

/** Why `start` (or a restart's start leg) is not using launchd, before it starts directly. */
export function renderStartLaunchdUnavailable(
  actor: string,
  l: Exclude<LaunchdLoadability, { state: "available" } | { state: "not-applicable" }>,
): string {
  return `${actor}: launchd cannot start this instance's job from this session — ${describeLoadabilityProblem(l)}. Starting Flair directly instead.`;
}

/**
 * The launchd attempt itself failed (load/start/health) AND the job was then
 * verified absent from the domain (ensureLaunchdJobAbsent) — only then does the
 * caller fall back to a direct start, and only then may it say so.
 */
export function renderStartLaunchdFailed(actor: string, label: string, error: string): string {
  return `${actor}: launchd could not start the job ${label} (${error}). The job was unloaded again (verified absent); starting Flair directly instead.`;
}

/**
 * The launchd attempt failed and the job could NOT be shown to be unloaded:
 * launchd may still start it, and a direct start could run a second Harper on
 * the same data directory. The caller does not start directly.
 */
export function renderStartLaunchdUnloadUncertain(actor: string, target: string, error: string, uncertainty: string): string[] {
  return [
    `${actor}: launchd could not start the job ${target} (${error}), and unloading it again could not be confirmed (${uncertainty}).`,
    "   Flair was NOT started directly: launchd may still start this job, and a direct start could run a second instance on the same data directory.",
    `   Fix: unload it ('launchctl bootout ${target}'), confirm 'launchctl print ${target}' no longer finds it, then re-run the command.`,
  ];
}

/**
 * The lines after a direct start that took the place of launchd: running
 * directly, NOT launchd-managed — with what that costs and what to do.
 */
export function renderDirectRunNotice(port: number, pid: number | null): string[] {
  return [
    `✅ Flair started on port ${port} — running directly${pid ? ` (pid ${pid})` : ""}, NOT launchd-managed.`,
    "   launchd will not restart it if it exits. To hand it to launchd, run 'flair doctor --fix' from a console (GUI) login session.",
    `   ${RUN_AT_LOAD_NOTE[0].toUpperCase()}${RUN_AT_LOAD_NOTE.slice(1)}; ${DIRECT_PROCESS_GUARD_NOTE}.`,
  ];
}

// ─── the targeted load sequence ───────────────────────────────────────────

/** Runs one `launchctl …` shell command; throws on a non-zero exit. */
export type LaunchctlCommandRunner = (cmd: string) => void;

export function bootoutCommand(domain: string, label: string): string {
  return `launchctl bootout ${domain}/${label}`;
}

export function bootstrapCommand(domain: string, plistPath: string): string {
  return `launchctl bootstrap ${domain} "${plistPath}"`;
}

export function kickstartCommand(domain: string, label: string): string {
  return `launchctl kickstart ${domain}/${label}`;
}

export function printJobCommand(domain: string, label: string): string {
  return `launchctl print ${domain}/${label}`;
}

/** Where a job stands in a domain: loaded, proven absent, or UNKNOWN. */
export type LaunchdJobPresence = "loaded" | "absent" | "unknown";

/**
 * Is `label` loaded in `domain`, per the read-only `launchctl print
 * <domain>/<label>`? (flair#2040) Tri-state on purpose: "absent" only when
 * launchctl SAYS so (exit 113 / "Could not find service"); any other failure is
 * "unknown" — a probe that did not answer is not proof the job is gone.
 */
export function launchdJobPresence(run: LaunchctlCommandRunner, domain: string, label: string): LaunchdJobPresence {
  try {
    run(printJobCommand(domain, label));
    return "loaded";
  } catch (err) {
    const e = err as { status?: unknown; stderr?: unknown; message?: unknown } | null;
    const text = `${e && e.stderr != null ? String(e.stderr) : ""}\n${String(e?.message ?? err)}`;
    if (e?.status === 113 || /could not find service/i.test(text)) return "absent";
    return "unknown";
  }
}

/**
 * Boot `label` out of `domain` and VERIFY it is gone (flair#2040): `bootout`
 * errors are not swallowed into "fine" — absence is re-read with the
 * read-only presence probe — polled for up to `settleMs` after a bootout that
 * launchctl accepted (or reports in progress), because `bootout` can return
 * while launchd is still tearing the job down. Returns null when the job
 * is PROVEN absent, or the reason absence could not be established. (A nullable
 * result rather than a boolean-keyed union: src/cli.ts compiles without
 * strictNullChecks, where such a union does not narrow.)
 */
export function ensureLaunchdJobAbsent(opts: {
  run: LaunchctlCommandRunner;
  domain: string;
  label: string;
  settleMs?: number;
  sleep?: (ms: number) => void;
}): string | null {
  const { run, domain, label } = opts;
  const settleMs = opts.settleMs ?? 5_000;
  const sleep = opts.sleep ?? sleepSync;
  let bootoutError: string | null = null;
  if (launchdJobPresence(run, domain, label) === "absent") return null;
  try {
    run(bootoutCommand(domain, label));
  } catch (err) {
    bootoutError = errorText(err);
  }
  // Wait out launchd's asynchronous teardown only when there is one to wait
  // for: a bootout launchctl accepted, or one it reports as still in
  // progress. A bootout it REFUSED leaves the job where it was — re-read once.
  const settling = bootoutError === null || /in progress|\b36\b/i.test(bootoutError);
  const deadline = Date.now() + (settling ? settleMs : 0);
  let presence = launchdJobPresence(run, domain, label);
  while (presence !== "absent" && Date.now() < deadline) {
    sleep(250);
    presence = launchdJobPresence(run, domain, label);
  }
  if (presence === "absent") return null;
  return (
    `after launchctl bootout ${domain}/${label}${bootoutError ? ` (which failed: ${bootoutError})` : ""}, ` +
    (presence === "loaded" ? "the job is still loaded" : "launchctl print could not say whether the job is loaded")
  );
}

function errorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const stderr = e && e.stderr != null ? String(e.stderr).trim() : "";
  if (stderr) return firstLine(stderr);
  return firstLine(String(e?.message ?? err));
}

/** Synchronous sleep for the short bootout settle wait (no event loop needed). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Load and start `label` from `plistPath` in `domain`, with commands that name
 * the domain: bootout (so a rewritten plist is re-read, flair#872) → bootstrap
 * → kickstart.
 *
 * `bootout` of a job that is not loaded fails harmlessly and is ignored here:
 * nothing below trusts it — a failed bootstrap is retried ONLY after the job is
 * proven absent (launchdJobPresence). `bootout` is asynchronous, so a failed
 * bootstrap waits (up to `settleMs`) for the job to leave the domain and
 * retries ONCE. If the job is not proven gone:
 *   - `strict` (doctor, init): throw — the loaded definition is the old one,
 *     and a repair must not report the new one as loaded;
 *   - otherwise (start/restart): fall through to `kickstart`, which starts the
 *     definition launchd holds — the tolerance the old `load` step had.
 * A `kickstart` failure always throws, naming the bootstrap failure too.
 */
export function loadLaunchdJob(opts: {
  run: LaunchctlCommandRunner;
  domain: string;
  label: string;
  plistPath: string;
  strict?: boolean;
  settleMs?: number;
  sleep?: (ms: number) => void;
}): void {
  const { run, domain, label, plistPath } = opts;
  const settleMs = opts.settleMs ?? 5_000;
  const sleep = opts.sleep ?? sleepSync;
  try { run(bootoutCommand(domain, label)); } catch { /* not loaded — nothing to boot out */ }
  let bootstrapError: string | null = null;
  try {
    run(bootstrapCommand(domain, plistPath));
  } catch (first) {
    bootstrapError = errorText(first);
    // Retry only once the job is PROVEN absent; "unknown" counts as still there.
    const deadline = Date.now() + settleMs;
    let presence = launchdJobPresence(run, domain, label);
    while (presence !== "absent" && Date.now() < deadline) {
      sleep(250);
      presence = launchdJobPresence(run, domain, label);
    }
    if (presence === "absent") {
      try {
        run(bootstrapCommand(domain, plistPath));
        bootstrapError = null;
      } catch (second) {
        throw new Error(`launchctl bootstrap ${domain} ${plistPath} failed: ${errorText(second)}`);
      }
    } else if (opts.strict) {
      throw new Error(
        `launchctl bootstrap ${domain} ${plistPath} failed (${bootstrapError}) and ${domain}/${label} is still loaded ` +
          "with its previous definition, so the rewritten plist was not loaded",
      );
    }
  }
  try {
    run(kickstartCommand(domain, label));
  } catch (err) {
    const why = bootstrapError ? ` (bootstrap had failed: ${bootstrapError})` : "";
    throw new Error(`launchctl kickstart ${domain}/${label} failed: ${errorText(err)}${why}`);
  }
}
