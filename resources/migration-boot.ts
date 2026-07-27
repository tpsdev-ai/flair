/**
 * migration-boot.ts — the boot-keyed trigger (flair#695
 * §A, Kern verdict): "Envelope ASYNC after ready — boot serves immediately
 * on the old shape; pre-hash runs async; migration deferred until it
 * completes; health shows 'pre-flight integrity check in progress'."
 *
 * This is a plain (non-Resource) module — same shape as
 * resources/embeddings-provider.ts / resources/table-helpers.ts / etc. — so
 * Harper's `jsResource: files: dist/resources/*.js` loader (config.yaml)
 * imports it at boot like every other flat file under resources/, running
 * its top-level side effect exactly once per process. It exports no
 * Resource subclass — there is no HTTP endpoint here, only the trigger.
 *
 * Timing: `scheduleMigrationBoot()` defers the actual cycle via
 * `setImmediate`, which runs after the current synchronous phase (module
 * loading / resource registration) yields to the event loop — in practice,
 * after Harper's HTTP listener is already accepting connections, so the
 * server is serving on the OLD shape before any migration write happens
 * (the #687 boot-win property this preserves). As an additional guard
 * against Harper-internal load-ordering this file has no visibility into,
 * the deferred callback ALSO polls for `databases.flair.Memory`/`Relationship`
 * actually being live table accessors before invoking the runner — cheap,
 * bounded, and self-healing if the very first check is too early.
 *
 * `runMigrationCycle` itself never throws (see runner.ts's module doc) —
 * the `.catch()` below is pure defense-in-depth so a bug there can never
 * take down the process either.
 *
 * ─── flair#812: this path must never fail silently ────────────────────────
 * `runMigrationCycle` REPORTS why a cycle didn't run (`{ ran: false, reason
 * }`) — it does not log it, because it is a library. This file, the only
 * caller, previously DISCARDED that value, which is what turned a
 * recoverable environment problem into an invisible one: on a provisioned
 * install where `~/.flair/data` isn't creatable, the runner's very first
 * step (`acquireMigrationLock` → `mkdirSync`) threw `EACCES`, the runner
 * caught it and returned `reason: "lock error: ..."`, and nothing anywhere
 * said a word. `.migrations/state.json` was never written, no
 * `[flair-migrations]` marker ever appeared, and EVERY migration — shipped
 * and future — was skipped on that instance forever.
 *
 * So: the data dir is now resolved to a candidate PROVEN writable before
 * the cycle is handed one (resources/migrations/data-dir.ts), and every
 * non-benign outcome — an unresolvable data dir, tables that never became
 * ready, a runner-reported failure, an unexpected throw — is BOTH logged
 * with a `[flair-migrations]` marker AND recorded as a `failed` progress
 * entry per registered migration. That progress entry is what makes the
 * condition visible where an operator will actually meet it:
 * `/HealthDetail` (with a warning), `flair doctor`'s Migrations section
 * (counted as an issue) and `flair quality`'s `instance.migrationsClean`.
 *
 * The one deliberately-quiet outcome is `single-flight` — another thread or
 * process holds the lock and is running the cycle. That is the guard doing
 * its job, not a failure, and Harper boots N worker threads that each load
 * this module; logging it would emit N-1 scary lines on every healthy boot.
 */
import { databases } from "harper";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry, type MigrationRegistry } from "./migrations/registry.js";
import { runMigrationCycle } from "./migrations/runner.js";
import { markIdleMigrationsFailed, seedIdleProgress, setCyclePhase } from "./migrations/progress.js";
import {
  describeUnresolvableDataDir,
  resolveWritableMigrationDataDir,
} from "./migrations/data-dir.js";
import type { SourceTable } from "./migrations/types.js";
import { getMode } from "./embeddings-provider.js";

/** Same "resolve the running package's own version" idiom as resources/health.ts. */
export function resolveRunningVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, "..", "..", "package.json"), join(here, "..", "package.json")];
    for (const p of candidates) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf-8"));
        if (pkg.version) return pkg.version;
      }
    }
  } catch {
    /* fall through */
  }
  return process.env.npm_package_version ?? "dev";
}

function getTable(table: SourceTable) {
  return (databases as unknown as Record<string, Record<string, unknown>>).flair[table] as {
    search(query: unknown): AsyncIterable<Record<string, unknown>>;
    get(id: string): Promise<Record<string, unknown> | null>;
  };
}

async function waitForTablesReady(maxWaitMs = 30_000, intervalMs = 200): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      const flair = (databases as unknown as Record<string, Record<string, unknown>>)?.flair;
      const mem = flair?.Memory as { search?: unknown } | undefined;
      const rel = flair?.Relationship as { search?: unknown } | undefined;
      if (typeof mem?.search === "function" && typeof rel?.search === "function") return true;
    } catch {
      /* keep polling */
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Gives the embeddings engine a bounded window to finish its own boot probe
 * (resources/embeddings-provider.ts: PROBE_TIMEOUT_MS = 8s) before running
 * migrations. Root-cause fix for a real race found while building the
 * embedding-stamp integration test: this trigger fires very early (right
 * after the Memory/Relationship tables exist), which can beat the
 * embeddings engine's own async model-load — a Memory.put() regen attempted
 * during that window silently fails (getEmbedding() catches and returns
 * null), leaving a row's embeddingModel null instead of freshly stamped.
 * `getMode()==="local"` breaks out early on the common case (embeddings
 * already warm); otherwise this waits up to ~8.5s (a hair over the probe's
 * own timeout, so whatever getMode() reports by then is genuinely settled,
 * not just "haven't checked yet") and proceeds regardless — a migration
 * must never block boot indefinitely on this, and embedding-stamp's own
 * pending-condition (OR of not_equal + equals-null — see that file) still
 * self-heals a stray null on the NEXT boot even if this window isn't enough.
 */
async function waitForEmbeddingsSettled(maxWaitMs = 8_500, intervalMs = 150): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (getMode() === "local") return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Records a boot-path failure everywhere an operator might look: the
 * process log (with the `[flair-migrations]` marker the runbook greps for),
 * the cycle status (`lastCycleError`, surfaced by `/HealthDetail` and named
 * by `flair doctor`), and a `failed` entry for each migration that never
 * started — because a boot path that cannot run is not a per-migration
 * problem, it is an instance-wide one, and `flair doctor` / `flair quality`
 * read per-migration state.
 *
 * `failed` (not `halted`) is deliberate for these: nothing was attempted
 * against the corpus, so there is no halted work to resume. And the marking
 * deliberately touches only migrations still `idle` — see
 * `markIdleMigrationsFailed` for why overwriting a terminal state would be
 * a downgrade rather than extra information.
 */
function reportBootFailure(registry: MigrationRegistry, reason: string): void {
  console.error(`[flair-migrations] ${reason}`);
  setCyclePhase("done", reason);
  markIdleMigrationsFailed(registry.list().map((m) => m.id), reason);
}

let scheduled = false;

export function scheduleMigrationBoot(): void {
  if (scheduled) return;
  scheduled = true;

  const registry = buildRegistry();
  seedIdleProgress(registry.list().map((m) => m.id));
  // Proof-of-life, set SYNCHRONOUSLY at module load: from here on,
  // `cyclePhase === "idle"` means this module never loaded at all — the
  // one hypothesis flair#812 could not otherwise rule out from the outside.
  setCyclePhase("scheduled");

  setImmediate(() => {
    void (async () => {
      const ready = await waitForTablesReady();
      if (!ready) {
        reportBootFailure(
          registry,
          "Memory/Relationship tables never became ready within 30s — this boot's migration cycle was skipped (it retries on the next restart)",
        );
        return;
      }
      await waitForEmbeddingsSettled();

      // Resolve a data dir PROVEN writable before handing one to the runner
      // — the runner's first act is to take a file lock there, and a
      // failure at that point is reported back rather than thrown, which is
      // precisely how flair#812 stayed invisible. See data-dir.ts.
      const resolved = resolveWritableMigrationDataDir();
      if (!resolved.dataDir) {
        reportBootFailure(registry, describeUnresolvableDataDir(resolved.tried));
        return;
      }

      try {
        const result = await runMigrationCycle({
          registry,
          getTable,
          dataDir: resolved.dataDir,
          runningVersion: resolveRunningVersion(),
        });
        // `nothing pending` is the healthy no-op; `single-flight` is the
        // lock guard working as designed on a multi-threaded boot. Anything
        // else is a cycle that WANTED to run and couldn't, and must be loud.
        if (!result.ran && result.reason && !isBenignSkip(result.reason)) {
          reportBootFailure(registry, `migration cycle did not run: ${result.reason}`);
        }
      } catch (err) {
        // Defense-in-depth only — runMigrationCycle is documented to never
        // throw. A boot-path exception must never surface here regardless.
        reportBootFailure(
          registry,
          `unexpected error from runMigrationCycle: ${(err as Error)?.message ?? String(err)}`,
        );
      }
    })();
  });
}

/**
 * The two `{ ran: false }` reasons that are NOT failures: nothing was
 * pending, or another holder is already running the cycle. Matched on the
 * prefixes runner.ts constructs (`"nothing pending"`, `"single-flight: …"`).
 */
export function isBenignSkip(reason: string): boolean {
  return reason === "nothing pending" || reason.startsWith("single-flight:");
}

// Test-only reset so a unit/integration test can re-trigger scheduling
// within the same process (never used in production — a real process only
// ever boots once).
export function _resetMigrationBootForTests(): void {
  scheduled = false;
}

scheduleMigrationBoot();
