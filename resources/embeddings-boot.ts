/**
 * embeddings-boot.ts — registers harper-fabric-embeddings as Harper's
 * `embedding`/`default` model backend DIRECTLY, in-process, on every boot
 * (flair#694 fix; invariants at flair#695).
 *
 * ─── Why this file exists (flair#694) ──────────────────────────────────────
 * The previous mechanism (removed by this change) delivered the registration
 * as a `models.embedding.default` block via the `HARPER_CONFIG` env var
 * (src/cli.ts's old `buildEmbeddingsHarperConfigEnv`) — a "merge layer" that
 * Harper's environment-manager (`@harperfast/harper`'s
 * `config/harperConfigEnvVars.js`) reasserts on every boot AND PERSISTS into
 * the instance-root `harper-config.yaml`. That file proved to be config-as-
 * STATE, not config-as-intent: `flair#694`'s downgrade-and-revert CI lane
 * (flair#692) caught a real bricking sequence —
 *
 *   1. A build with this feature boots and HARPER_CONFIG reasserts
 *      `models.embedding.default.{backend,modelName,modelsDir}`, which
 *      Harper's env-var layer persists to `harper-config.yaml` AND records
 *      each of those THREE flattened leaf paths as `sources[path] =
 *      'HARPER_CONFIG'` in `.harper-config-state.json` (no "original value"
 *      stored, because the key didn't exist before this boot introduced it).
 *   2. On ANY later boot that does not reassert `HARPER_CONFIG` for those
 *      paths (a downgrade to a build that predates this feature; equally, a
 *      transient resolution failure on the current build) — Harper's own
 *      `applyRuntimeEnvConfig` treats the env var's absence as "the operator
 *      removed this config" and calls `cleanupRemovedEnvVar`, which deletes
 *      each of the three leaves INDIVIDUALLY (no stored original to restore
 *      to), leaving `models.embedding.default: {}` — an empty shell —
 *      persisted to disk.
 *   3. The next boot's config schema validator
 *      (`@harperfast/harper`'s `validation/configValidator.js`) resolves the
 *      entry's backend via `Joi.alternatives().conditional('.backend', {...,
 *      otherwise: unknownBackendEntrySchema})`; with `backend` absent, that
 *      falls through to `unknownBackendEntrySchema = Joi.object({backend:
 *      string.required()})`, which throws exactly: "Harper config file
 *      validation error: 'models.embedding.default.backend' is required" —
 *      Harper refuses to boot. Confirmed byte-identical in both @harperfast/
 *      harper 5.1.15 and 5.1.17 (this is upstream env-var-config behavior,
 *      not a schema difference between versions), and reproduced locally by
 *      replaying the exact downgrade-and-revert sequence.
 *
 * No shape flair could put IN HARPER_CONFIG fixes this: the deletion is
 * triggered by an OLDER build never setting the env var in the first place,
 * which is unfixable from the newer build's side. Config that gets torn
 * down whenever a boot doesn't reassert it is fundamentally unsafe for
 * anything a downgrade must survive (flair#695 invariant I: "config files
 * are state too").
 *
 * ─── The fix ────────────────────────────────────────────────────────────
 * Skip Harper's config-file-driven bootstrap path ENTIRELY. Call
 * harper-fabric-embeddings' own `register({logicalName, kind, config})`
 * factory DIRECTLY — the same factory Harper's `bootstrapModels()` would
 * have invoked, and (per that package's own source) the "public path for
 * components and apps to add in-process ... backends":
 * `models.registerBackend(kind, id, backend)` on Harper's process-wide
 * `models` singleton. This is genuinely reassert-only: every boot calls this
 * function again (module-scope side effect, same convention as
 * `migration-boot.ts`), NOTHING is ever written to `harper-config.yaml`, so
 * there is no persisted state for a downgrade to trip over — the class of
 * bug this file fixes cannot recur by construction, not by a shape
 * contract that has to keep being honored.
 *
 * Bonus: this also drops the old absolute-path workaround
 * (`resolveEmbeddingBackendModule`'s `require.resolve` + `pathToFileURL`
 * dance) that HARPER_CONFIG's `backend:` needed because
 * `resolveBackendSpecifier` resolves a bare package name from the Harper
 * INSTANCE ROOT's `node_modules`, not flair's own package dir. Importing
 * harper-fabric-embeddings directly from flair's own code needs no such
 * workaround — plain Node module resolution from flair's own `node_modules`
 * always finds it, uniformly across a local install, Docker, AND a Fabric
 * deploy (where flair runs as a non-root cluster component and
 * `bootstrapModels()` — gated on `isRoot` — was never reachable at all; see
 * the removed comment this replaces in `config.yaml`).
 *
 * ─── Loading mechanism ──────────────────────────────────────────────────
 * Plain (non-Resource) module — same shape as `migration-boot.ts` /
 * `embeddings-provider.ts` / `table-helpers.ts` — so Harper's `jsResource:
 * files: dist/resources/*.js` loader (config.yaml) imports it at boot like
 * every other flat file under `resources/`, running its top-level side
 * effect exactly once per process. No config.yaml wiring needed.
 *
 * Graceful degrade preserved: if harper-fabric-embeddings isn't installed,
 * or `globalThis.models` isn't available (this module loaded outside a real
 * Harper boot), registration is skipped and logged — Harper falls back to
 * keyword-only search, matching the pre-existing degrade contract.
 */
import { resolveModelsDir } from "./embeddings-provider.js";

const LOGICAL_NAME = "default";
const MODEL_NAME = "nomic-embed-text";

let registered = false;

/**
 * Register the embedding backend. Idempotent within a process (mirrors
 * `migration-boot.ts`'s `scheduled` guard) — safe to call more than once,
 * only the first call does anything.
 */
export async function registerEmbeddingsBackend(): Promise<void> {
  if (registered) return;
  registered = true;
  try {
    const { register } = await import("harper-fabric-embeddings");
    await register({
      logicalName: LOGICAL_NAME,
      kind: "embedding",
      config: { modelName: MODEL_NAME, modelsDir: resolveModelsDir() },
    });
  } catch (err) {
    // Not installed, or globalThis.models isn't ready (module loaded outside
    // a real Harper boot, e.g. some future non-Harper import path) — degrade
    // to Harper's keyword-only fallback, the same contract the old
    // HARPER_CONFIG-omitted path preserved.
    console.error(
      `[embeddings] backend registration skipped: ${(err as Error)?.message ?? String(err)}`
    );
  }
}

/** Test-only reset — never used in production (a real process boots once). */
export function _resetEmbeddingsBackendRegistrationForTests(): void {
  registered = false;
}

void registerEmbeddingsBackend();
