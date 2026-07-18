/**
 * probe.ts — post-restart instance verification.
 *
 * Shared by `flair upgrade`'s local post-restart verification (flair#635)
 * and the planned Fabric fleet verify sweep (flair#636, peer-at-a-time
 * rolling restart gate). `probeInstance()` answers three questions about a
 * running Flair instance:
 *
 *   1. Is it reachable at all? (GET /Health — public, no auth, polled until
 *      it answers or the time budget runs out.)
 *   2. Does an authenticated request round-trip successfully? Credential
 *      resolution is ENTIRELY the caller's responsibility via the injected
 *      `authedGet` — probeInstance never resolves credentials itself. Local
 *      `flair upgrade` dogfoods `api()`'s local-credential resolution
 *      (flair#640: FLAIR_TOKEN > FLAIR_ADMIN_PASS/HDB_ADMIN_PASSWORD env >
 *      agent Ed25519 key > ~/.flair/admin-pass file); a future Fabric fleet
 *      check will instead build Fabric admin Basic auth per peer. Same
 *      shape, different credentials — that's the reuse.
 *   3. Does the reported running version match what was just installed?
 *      Read from the authenticated GET /HealthDetail response's `version`
 *      field (resources/health.ts resolves it from the RUNNING process's
 *      own package.json — it only changes once the process actually
 *      restarts onto new code, so it can't be spoofed by a package.json
 *      that changed on disk but hasn't been loaded yet).
 *
 * Never throws — every failure mode is expressed structurally in
 * ProbeResult so callers can render (or automate a rollback decision from)
 * a clear reason instead of catching an exception.
 */

export interface ProbeInstanceOptions {
  /** Expected running version (e.g. the version just installed). Omit to skip the version check entirely. */
  expectVersion?: string;
  /** Total time budget for /Health to answer at all. Default 60s. */
  timeoutMs?: number;
  /** Delay between /Health poll attempts. Default 500ms. */
  pollIntervalMs?: number;
  /** Injectable for tests; defaults to the global fetch. Used for the /Health poll only. */
  fetchImpl?: typeof fetch;
  /**
   * Performs an authenticated GET against `path` on the instance and
   * resolves the parsed JSON body. Must throw/reject on any non-2xx
   * response or network failure — that's how probeInstance tells
   * "authenticated and got a real answer" apart from "credentials rejected
   * / instance broken". Omit entirely to run a health-only probe: healthy
   * is still reported, but authenticated/version/versionMatch all come back
   * null (nothing to check without a way to authenticate).
   *
   * flair#741: if the thrown/rejected error carries a numeric `.status`
   * property, probeInstance reads it to fill ProbeResult.authFailureKind
   * (401/403 → "credentials", anything else → "server") — purely additive,
   * duck-typed, optional. An authedGet that never sets `.status` still works
   * exactly as before; it just always classifies as "server".
   */
  authedGet?: (path: string) => Promise<any>;
  /** Path to GET for the authenticated version/auth check. Default "/HealthDetail". */
  versionPath?: string;
}

export interface ProbeResult {
  /** /Health answered (2xx) within timeoutMs. */
  healthy: boolean;
  /** null when authedGet wasn't provided (health-only probe) or /Health never answered. */
  authenticated: boolean | null;
  /** Reported running version from the authenticated response, or null if unavailable. */
  version: string | null;
  /** null when there's nothing to compare (no expectVersion given, auth failed, or unhealthy). */
  versionMatch: boolean | null;
  /** Overall pass/fail — false if unhealthy, unauthenticated, or a version mismatch. */
  ok: boolean;
  /** Human-readable reason. Present iff !ok. */
  error?: string;
  /**
   * Classifies WHY the authenticated leg failed, when it did (flair#741).
   * Callers use this to tell "the server is up and responding, it just
   * rejected our credentials" (not a data-integrity risk — the flair#741
   * incident: a healthy instance, misreported as "state UNKNOWN" because
   * the checker had no admin-pass/agent key on that machine) apart from a
   * genuine "we can't tell what state this instance is in" failure.
   *
   *   - "credentials": `authedGet` rejected — and the rejection carried a
   *     numeric `.status` of 401 or 403 on the thrown error (the convention
   *     `api()` in src/cli.ts follows; any authedGet implementation can
   *     opt in the same way). The server demonstrably answered; only the
   *     credentials were the problem.
   *   - "server": `authedGet` rejected for any other reason — a network
   *     error/timeout reaching the authenticated endpoint, a non-401/403
   *     HTTP status (5xx, etc.), or an error with no recognizable status.
   *     Treated exactly like before flair#741: a real "can't confirm this
   *     instance is OK" signal.
   *   - null: authenticated !== false — either the authenticated call
   *     succeeded, or it was never attempted (no authedGet given, or /Health
   *     itself never answered).
   *
   * Optional (not just nullable) so pre-existing hand-built ProbeResult
   * fixtures in tests keep compiling unchanged; probeInstance() itself
   * always sets it explicitly (never leaves it undefined).
   */
  authFailureKind?: "credentials" | "server" | null;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
export const DEFAULT_PROBE_POLL_INTERVAL_MS = 500;
export const DEFAULT_PROBE_VERSION_PATH = "/HealthDetail";

/**
 * Poll `${baseUrl}/Health` until it answers 2xx or `timeoutMs` elapses, then
 * (if `authedGet` is given) make ONE authenticated GET against
 * `versionPath` to confirm auth works and read the running version.
 */
export async function probeInstance(baseUrl: string, opts: ProbeInstanceOptions = {}): Promise<ProbeResult> {
  const {
    expectVersion,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_PROBE_POLL_INTERVAL_MS,
    fetchImpl = fetch,
    authedGet,
    versionPath = DEFAULT_PROBE_VERSION_PATH,
  } = opts;
  const base = baseUrl.replace(/\/+$/, "");
  const deadline = Date.now() + timeoutMs;

  let healthy = false;
  let lastHealthError: string | undefined;
  for (;;) {
    try {
      const res = await fetchImpl(`${base}/Health`, { signal: AbortSignal.timeout(Math.min(5000, timeoutMs)) });
      if (res.ok) { healthy = true; break; }
      lastHealthError = `HTTP ${res.status}`;
    } catch (err: any) {
      lastHealthError = err?.message ?? String(err);
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (!healthy) {
    return {
      healthy: false,
      authenticated: null,
      version: null,
      versionMatch: null,
      ok: false,
      authFailureKind: null,
      error: `instance did not answer ${base}/Health within ${timeoutMs}ms` +
        (lastHealthError ? ` (last error: ${lastHealthError})` : ""),
    };
  }

  if (!authedGet) {
    return { healthy: true, authenticated: null, version: null, versionMatch: null, ok: true, authFailureKind: null };
  }

  let version: string | null = null;
  let authError: string | undefined;
  let authFailureKind: "credentials" | "server" | null = null;
  try {
    const body = await authedGet(versionPath);
    version = typeof body?.version === "string" ? body.version : null;
  } catch (err: any) {
    authError = err?.message ?? String(err);
    // flair#741: classify the failure so callers can tell "server responded,
    // credentials rejected" (liveness proven) from "can't tell what state
    // this instance is in". Duck-typed on `.status` — any authedGet
    // implementation can opt in by throwing an error with a numeric status;
    // api() (src/cli.ts) does via ApiHttpError. No recognizable status (a
    // plain network error, or an authedGet that doesn't set one) stays
    // conservative and lands in "server".
    const status = typeof err?.status === "number" ? err.status : null;
    authFailureKind = status === 401 || status === 403 ? "credentials" : "server";
  }

  const authenticated = authError === undefined;
  let versionMatch: boolean | null = null;
  if (authenticated && expectVersion !== undefined) {
    versionMatch = version === expectVersion;
  }
  if (authenticated) authFailureKind = null;

  const ok = healthy && authenticated && versionMatch !== false;
  let error: string | undefined;
  if (!authenticated) {
    error = `authenticated request to ${base}${versionPath} failed: ${authError}`;
  } else if (versionMatch === false) {
    error = `version mismatch: expected ${expectVersion}, instance reports ${version ?? "unknown"}`;
  }

  return { healthy, authenticated, version, versionMatch, ok, error, authFailureKind };
}
