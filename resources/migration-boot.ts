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
 */
import { databases } from "@harperfast/harper";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "./migrations/registry.js";
import { runMigrationCycle } from "./migrations/runner.js";
import { seedIdleProgress } from "./migrations/progress.js";
import type { SourceTable } from "./migrations/types.js";
import { getMode } from "./embeddings-provider.js";

/** Same dataDir resolution as resources/health.ts's disk section. */
export function resolveMigrationDataDir(): string {
  return process.env.HDB_ROOT ?? join(homedir(), ".flair", "data");
}

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

let scheduled = false;

export function scheduleMigrationBoot(): void {
  if (scheduled) return;
  scheduled = true;

  const registry = buildRegistry();
  seedIdleProgress(registry.list().map((m) => m.id));

  setImmediate(() => {
    void (async () => {
      const ready = await waitForTablesReady();
      if (!ready) {
        console.error("[flair-migrations] Memory/Relationship tables never became ready — skipping this boot's migration cycle (will retry next boot)");
        return;
      }
      await waitForEmbeddingsSettled();
      try {
        await runMigrationCycle({
          registry,
          getTable,
          dataDir: resolveMigrationDataDir(),
          runningVersion: resolveRunningVersion(),
        });
      } catch (err) {
        // Defense-in-depth only — runMigrationCycle is documented to never
        // throw. A boot-path exception must never surface here regardless.
        console.error(`[flair-migrations] unexpected error from runMigrationCycle: ${(err as Error)?.message ?? String(err)}`);
      }
    })();
  });
}

// Test-only reset so a unit/integration test can re-trigger scheduling
// within the same process (never used in production — a real process only
// ever boots once).
export function _resetMigrationBootForTests(): void {
  scheduled = false;
}

scheduleMigrationBoot();
