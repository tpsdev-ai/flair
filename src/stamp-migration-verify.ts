/**
 * stamp-migration-verify.ts — post-deploy / `upgrade --target` check that
 * embedding-stamp actually converged (flair#1073).
 *
 * Route verify (`verifyDeployServing`) proves the component is serving.
 * That is not enough: a Fabric upgrade can serve new writes (prefixed
 * stamps) while pre-flip rows stay stale, and `flair status` used to
 * report only a generic mixed-models warning. This polls authenticated
 * /HealthDetail until the corpus is a single current space (and
 * embedding-stamp is not halted/failed), the same way route verify polls
 * until /Memory is non-404.
 */
import {
  EMBEDDING_STAMP_ID,
  stampMigrationConverged,
  type StampMigrationProgress,
} from "./stamp-outstanding.js";

export const DEFAULT_STAMP_VERIFY_TIMEOUT_MS = 600_000;
export const STAMP_VERIFY_POLL_INTERVAL_MS = 2_000;

export interface VerifyStampMigrationOptions {
  baseUrl: string;
  fabricUser: string;
  fabricPassword: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (msg: string) => void;
}

export interface StampVerifySnapshot {
  modelCounts?: Record<string, number>;
  cyclePhase?: string;
  lastCycleError?: string | null;
  migrations?: StampMigrationProgress[];
  /** /HealthDetail warnings — the server-side outstanding signal uses getModelId(). */
  warnings?: string[];
}

function basicAuthHeader(user: string, password: string): string {
  return "Basic " + Buffer.from(`${user}:${password}`, "utf8").toString("base64");
}

/**
 * Parse /HealthDetail into a verify snapshot. `memories: null` (HealthDetail
 * 200 after the Memory walk threw) and a missing `modelCounts` field stay
 * `undefined` — that is unread, not an empty corpus. An explicit
 * `modelCounts: {}` is the valid empty-store case (Bugbot Medium on #1606).
 */
export function snapshotFromHealthDetail(body: unknown): StampVerifySnapshot {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const memories =
    rec.memories && typeof rec.memories === "object" ? (rec.memories as Record<string, unknown>) : null;
  const migrationsBlock =
    rec.migrations && typeof rec.migrations === "object" ? (rec.migrations as Record<string, unknown>) : {};
  const modelCounts =
    memories && memories.modelCounts && typeof memories.modelCounts === "object"
      ? (memories.modelCounts as Record<string, number>)
      : undefined;
  const rawList = Array.isArray(migrationsBlock.migrations) ? migrationsBlock.migrations : undefined;
  const migrations = rawList
    ?.filter((m): m is StampMigrationProgress => !!m && typeof m === "object" && typeof (m as StampMigrationProgress).id === "string")
    .map((m) => ({
      id: m.id,
      state: String(m.state ?? ""),
      rowsDone: typeof m.rowsDone === "number" ? m.rowsDone : undefined,
      rowsRemaining: typeof m.rowsRemaining === "number" ? m.rowsRemaining : undefined,
      reason: typeof m.reason === "string" ? m.reason : undefined,
    }));
  const warnings = Array.isArray(rec.warnings)
    ? rec.warnings
        .map((w) => (w && typeof w === "object" && typeof (w as { message?: unknown }).message === "string" ? (w as { message: string }).message : null))
        .filter((m): m is string => m !== null)
    : undefined;
  return {
    modelCounts,
    cyclePhase: typeof migrationsBlock.cyclePhase === "string" ? migrationsBlock.cyclePhase : undefined,
    lastCycleError: typeof migrationsBlock.lastCycleError === "string" ? migrationsBlock.lastCycleError : migrationsBlock.lastCycleError === null ? null : undefined,
    migrations,
    warnings,
  };
}

/**
 * Read the current-space id from the HealthDetail warning or from the
 * dominant +searchprefix / gguf: stamp. Fallback: the most common real
 * stamp — verify then treats any other space as stale.
 */
export function inferCurrentModelId(snapshot: StampVerifySnapshot): string {
  const counts = snapshot.modelCounts ?? {};
  let best: { stamp: string; n: number } | null = null;
  let prefixed: { stamp: string; n: number } | null = null;
  for (const [stamp, n] of Object.entries(counts)) {
    if (stamp === "hash-512d" || typeof n !== "number" || n <= 0) continue;
    if (!best || n > best.n) best = { stamp, n };
    if (stamp.includes("+searchprefix") && (!prefixed || n > prefixed.n)) prefixed = { stamp, n };
  }
  return prefixed?.stamp ?? best?.stamp ?? "nomic-embed-text-v1.5-Q4_K_M+searchprefix";
}

export function evaluateStampSnapshot(snapshot: StampVerifySnapshot): { converged: boolean; detail: string } {
  // Unread corpus (HealthDetail omitted modelCounts, including memories: null)
  // is not an empty store. Reject before stampMigrationConverged can treat
  // `undefined` as `{}` and report success (Bugbot Medium on #1606).
  if (snapshot.modelCounts === undefined) {
    return {
      converged: false,
      detail: "HealthDetail did not include memories.modelCounts",
    };
  }
  const outstandingWarning = snapshot.warnings?.find(
    (w) => w.includes(`migration '${EMBEDDING_STAMP_ID}' is outstanding`) || w.includes("duplicate detection is inactive"),
  );
  if (outstandingWarning) {
    return { converged: false, detail: outstandingWarning };
  }
  const counts = snapshot.modelCounts;
  const realStamps = Object.entries(counts).filter(([k, n]) => k !== "hash-512d" && typeof n === "number" && n > 0);
  // Production getModelId() stamps +searchprefix. A corpus that is entirely
  // on the pre-flip bare id is the #1073 failure mode — do not treat a
  // single-space bare corpus as converged just because inferCurrentModelId
  // would pick that majority stamp as "current."
  if (realStamps.length > 0 && realStamps.every(([k]) => !k.includes("+searchprefix"))) {
    const list = realStamps.map(([k, n]) => `${k}:${n}`).join(", ");
    return {
      converged: false,
      detail: `migration '${EMBEDDING_STAMP_ID}' is outstanding — corpus has no +searchprefix stamp yet (${list})`,
    };
  }
  const currentModelId = inferCurrentModelId(snapshot);
  const migration = snapshot.migrations?.find((m) => m.id === EMBEDDING_STAMP_ID);
  return stampMigrationConverged({
    modelCounts: counts,
    currentModelId,
    migration,
    cyclePhase: snapshot.cyclePhase,
    lastCycleError: snapshot.lastCycleError,
  });
}

async function readHealthDetail(
  baseUrl: string,
  auth: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status: number; snapshot?: StampVerifySnapshot; error?: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/HealthDetail`;
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: auth, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `GET /HealthDetail returned ${res.status}` };
    }
    const body = await res.json();
    return { ok: true, status: res.status, snapshot: snapshotFromHealthDetail(body) };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error)?.message ?? String(err) };
  }
}

/**
 * Poll /HealthDetail until embedding-stamp has converged, or throw.
 * Skipped by the caller when verify is disabled (`--no-verify`).
 */
export async function verifyStampMigrationConverged(o: VerifyStampMigrationOptions): Promise<void> {
  const {
    baseUrl,
    fabricUser,
    fabricPassword,
    timeoutMs = DEFAULT_STAMP_VERIFY_TIMEOUT_MS,
    pollIntervalMs = STAMP_VERIFY_POLL_INTERVAL_MS,
    fetchImpl = fetch,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    onProgress,
  } = o;
  const auth = basicAuthHeader(fabricUser, fabricPassword);
  onProgress?.(`verifying ${EMBEDDING_STAMP_ID} converged on ${baseUrl}...`);

  const deadline = Date.now() + timeoutMs;
  let last = await readHealthDetail(baseUrl, auth, fetchImpl);
  for (;;) {
    if (last.ok && last.snapshot) {
      const verdict = evaluateStampSnapshot(last.snapshot);
      if (verdict.converged) {
        onProgress?.(`embedding-stamp converged`);
        return;
      }
      onProgress?.(verdict.detail);
    } else {
      onProgress?.(last.error ?? "HealthDetail not readable yet");
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    last = await readHealthDetail(baseUrl, auth, fetchImpl);
  }

  if (!last.ok) {
    throw new Error(
      `deploy verification: embedding-stamp did not converge within ${timeoutMs}ms — ` +
        `could not read /HealthDetail (${last.error ?? `HTTP ${last.status}`}). ` +
        `The component may still be restarting; re-run without --no-verify, or ` +
        `\`flair status --json\` and look for migration '${EMBEDDING_STAMP_ID}'.`,
    );
  }
  const verdict = last.snapshot ? evaluateStampSnapshot(last.snapshot) : { detail: "no HealthDetail snapshot" };
  throw new Error(
    `deploy verification: embedding-stamp did not converge within ${timeoutMs}ms — ${verdict.detail}`,
  );
}
