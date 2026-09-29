/**
 * launchd-domain-preflight.ts — can THIS process load a job in the target
 * launchd domain right now? (flair#2040).
 *
 * THE INCIDENT. `flair doctor --fix` over ssh clean-stopped a HEALTHY instance,
 * then failed to load the launchd job — leaving Flair down. From an ssh session
 * the per-user GUI launchd domain is not reachable: `launchctl print gui/<uid>`
 * returns `125: Domain does not support specified action` and
 * `launchctl bootstrap user/<uid>` returns `5: Input/output error`. The job does
 * load at the NEXT console login (the plist has RunAtLoad + KeepAlive), but
 * doctor had already taken the instance down before it found that out. The
 * plist was written and the job was never loaded, yet `flair init` printed
 * "Launchd service registered ✓".
 *
 * THE FIX THIS MODULE IS. A PREFLIGHT that answers, before anything is stopped
 * or started, whether a job can be loaded in the target domain from here. The
 * probe is READ-ONLY:
 *
 *   launchctl print <domain>            (domain = `gui/<uid>`)
 *
 * `print` only READS the domain's current state — it does not load, start,
 * bootstrap, unload or otherwise mutate anything. It is the same domain
 * (`gui/<uid>`) the LaunchAgent must be loaded into, so a domain `print` cannot
 * answer says exactly the thing we need to know: this session cannot load the
 * job here. (`launchctl managername` was considered and rejected as the primary
 * probe: it reports the domain the CURRENT process is in — `Background` over
 * ssh — which does not tell us whether `gui/<uid>` is reachable, only which
 * domain we are in.)
 *
 * The result is TYPED, because "cannot load" and "could not tell" must not be
 * conflated:
 *   - available            -> the domain answers; proceed as before.
 *   - unavailable(reason)  -> the domain answered that it cannot load (the ssh
 *                             symptom); NEVER stop the live instance.
 *   - unknown(reason)      -> launchctl could not be run or answered with
 *                             something we cannot interpret; treat as "do not
 *                             stop" (fail closed) — never as "available".
 *   - not-applicable       -> not macOS. Flair's INSTANCE service is
 *                             launchd-only; Linux has no instance unit, so the
 *                             analogous condition for the instance does not
 *                             arise here (the systemd user-bus condition on the
 *                             scheduled-driver path is handled separately — see
 *                             scheduler-platform.ts `describeLoadFailure`).
 *
 * Pure and injected: the runner is a seam so a test never touches real launchd.
 */

/** Ceiling on a domain probe; a hung launchctl must not hang the CLI. */
export const DOMAIN_PROBE_TIMEOUT_MS = 5_000;

export type DomainAvailability =
  | { state: "available" }
  | { state: "unavailable"; reason: string }
  | { state: "unknown"; reason: string }
  | { state: "not-applicable"; reason: string };

/** Runs the read-only domain probe; injected so tests never touch real launchd. */
export type DomainProbeRunner = () => { code: number | null; stdout: string; stderr: string };

/** The GUI domain a per-user LaunchAgent must be loaded into. */
export function launchdGuiDomain(uid: number): string {
  return `gui/${uid}`;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function probeSummary(target: string, code: number | null, text: string): string {
  const detail = firstLine(text);
  if (code === null) return `launchctl print ${target} did not run${detail ? `: ${detail}` : ""}`;
  return `launchctl print ${target} exited ${code}${detail ? `: ${detail}` : ""}`;
}

/**
 * The ssh-symptom signatures of a GUI domain that this session cannot load into.
 * `125` ("Domain does not support specified action") is the measured launchctl
 * code over ssh (flair#2040); `5` ("Input/output error") is what `bootstrap`
 * returns in the same session; the text forms cover the other wordings launchd
 * uses when the domain is not reachable from here.
 */
const UNREACHABLE_SIGNATURE =
  /domain does not support specified action|could not find domain|no such domain|unknown domain|input\/output error|operation not permitted|not permitted/i;

/**
 * Can this process load a job in the target launchd domain right now?
 *
 * Run the read-only probe against `gui/<uid>`. `code 0` is available; the known
 * unreachable signatures (and codes 125/5) are `unavailable`; anything else
 * (spawn failure, an uninterpretable code) is `unknown`, which callers MUST
 * treat as "do not stop".
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
    return { state: "unavailable", reason: probeSummary(target, res.code, text) };
  }
  return { state: "unknown", reason: probeSummary(target, res.code, text) };
}

export type JobLoadedState =
  | { loaded: true; detail: string }
  | { loaded: false; reason: string }
  | { state: "not-applicable"; reason: string };

/**
 * Is the given launchd job ACTUALLY loaded, read from `launchctl print
 * <domain>/<label>` (read-only; `print` mutates nothing). Used by `flair init`
 * and `flair start` so they report a loaded job — never a bare check mark for a
 * job that was written but not loaded (flair#2040).
 *
 * A non-zero exit is `loaded: false` for any reason, including the ssh symptom
 * (the job is not loaded from here); a spawn failure is also `loaded: false`
 * with the reason, because a job we cannot confirm must not be reported as
 * loaded.
 */
export function verifyLaunchdJobLoaded(opts: {
  platform: string;
  uid: number;
  label: string;
  run: DomainProbeRunner;
}): JobLoadedState {
  if (opts.platform !== "darwin") {
    return { state: "not-applicable", reason: `${opts.platform} does not use launchd` };
  }
  const target = `${launchdGuiDomain(opts.uid)}/${opts.label}`;
  let res: { code: number | null; stdout: string; stderr: string };
  try {
    res = opts.run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { loaded: false, reason: `could not run launchctl print ${target}: ${message}` };
  }
  if (res.code === 0) return { loaded: true, detail: `launchd job ${opts.label} is loaded` };
  const text = `${res.stderr}\n${res.stdout}`.trim();
  return { loaded: false, reason: probeSummary(target, res.code, text) };
}

/**
 * The user-facing message when the domain cannot be loaded into. Actor + state
 * + remedy, in one sentence the operator can act on, and an explicit statement
 * that nothing was stopped. Used by `doctor --fix` (as a refusal) and by
 * `flair start` (before it falls back to a direct start).
 */
export function renderDomainUnavailableMessage(a: {
  state: "unavailable" | "unknown";
  reason: string;
}): string {
  const what = a.state === "unavailable" ? "unavailable from this session" : "could not be verified from this session";
  return (
    `flair doctor --fix: the launchd GUI domain is ${what} (${a.reason}). ` +
    "The launchd job loads at the next console login (the plist has RunAtLoad) — or run 'flair doctor --fix' " +
    "from a console session, or reboot with auto-login. The running instance was left untouched."
  );
}

/** The message `flair init` prints instead of a check mark when the job is not loaded. */
export function renderInitJobNotLoadedMessage(reason: string): string {
  return `Launchd plist written; the job loads at the next console login — ${reason}`;
}

export type InitLaunchdOutcome = "written" | "unchanged";

/**
 * The ONE line `flair init` prints for its launchd step (flair#2040). Pure, so
 * the exact strings are asserted without running init. A check mark is printed
 * ONLY when the job is actually loaded (or launchd does not apply); otherwise
 * the line says the plist was written and the job loads at the next console
 * login, with the reason — never a check mark for a load that did not happen.
 */
export function initLaunchdStatusLine(input: {
  outcome: InitLaunchdOutcome;
  loaded: boolean;
  reason?: string;
}): string {
  const reason = input.reason ?? "the job is not loaded";
  if (input.loaded) {
    return input.outcome === "unchanged"
      ? "Launchd service already managed — plist unchanged ✓"
      : "Launchd service registered ✓";
  }
  if (input.outcome === "unchanged") {
    return `Launchd plist unchanged; the job is not loaded from this session — ${reason}. It loads at the next console login.`;
  }
  return renderInitJobNotLoadedMessage(reason);
}

/** The message `flair start` prints when it falls back to a direct start. */
export function renderStartFallbackMessage(reason: string): string {
  return `launchd could not load the job from this session (${reason}); starting directly. It loads at the next console login.`;
}
