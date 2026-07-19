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

/**
 * Pooling declaration (HFE 0.5.0+, harper-fabric-embeddings' `init()`
 * `pooling` option). Verification, not override: the native addon has no
 * pooling knob of its own — llama.cpp always pools by whatever the GGUF's
 * own `<arch>.pooling_type` metadata says. Declaring the expectation makes
 * HFE assert it at init and fail loudly on absent/mismatched metadata,
 * instead of a metadata-less or mismatched conversion silently pooling the
 * wrong way (see node_modules/harper-fabric-embeddings/README.md's `init()`
 * table for the exact contract this PR bumps to).
 *
 * "mean" is nomic-embed-text-v1.5's actual pooling type — NOT assumed from
 * the model's reputation, directly confirmed against the shipped GGUF:
 * `node_modules/.bin/node-llama-cpp inspect gguf
 * ~/.flair/data/models/nomic-embed-text-v1.5.Q4_K_M.gguf` reports
 * `"nomic-bert": { pooling_type: 1 }`, and llama.cpp's
 * `enum llama_pooling_type` maps 1 -> `LLAMA_POOLING_TYPE_MEAN` (0 = none,
 * 1 = mean, 2 = cls, 3 = last, 4 = rank). nomic-embed-text is a
 * NomicBertModel architecture, not Qwen3 (last-token) — flair registers no
 * Qwen3-class embedding model today (the Qwen3-Reranker-0.6B in
 * resources/rerank-provider.ts is a SEPARATE code path that calls
 * node-llama-cpp directly for generative yes/no scoring, never goes through
 * HFE's register()/init(), and has no embedding-pooling context at all — see
 * that file's header). If a Qwen3-class (last-token-pooling) embedding model
 * is ever registered here, it must declare `pooling: "last"`, not "mean".
 *
 * Applies to the bench-only `modelPath` override too (`benchModelPathOverride()`
 * below): `FLAIR_RECALL_HARNESS_MODEL_PATH` lets an operator point this
 * registration at an arbitrary GGUF for a Q4/Q8 bakeoff, and this constant
 * assumes whatever file lands there is still nomic-family (mean-pooling) —
 * true for every bakeoff run to date (same base model, different quant).
 * HFE 0.5.0's verification is exactly the safety net that turns "someone
 * points --model-file at a non-nomic, non-mean-pooling GGUF" into a loud
 * boot-time failure instead of a silently-wrong pooling pass.
 */
const EMBEDDING_POOLING = "mean";

/**
 * BENCH-ONLY escape hatch — NOT a production feature flag, never documented
 * as an operator setting, and never read anywhere else in this codebase.
 * Mirrors `embeddings-provider.ts`'s `FLAIR_RECALL_HARNESS_FORCE_PREFIX`
 * hatch (see that file's header for the pattern this follows): a bench-only
 * env var, read lazily, that lets `test/bench/recall-harness/run.ts`'s
 * `--model-file <path>` flag override model SELECTION the same way that
 * hatch overrides prefix behavior — without editing this file's hardcoded
 * `MODEL_NAME`/`resolveModelsDir()` call every time a bakeoff needs a
 * different GGUF (e.g. a Q8_0 quant of the same base model).
 *
 * This is not a new capability grafted on — `harper-fabric-embeddings`'
 * `register()` factory already accepts `config.modelPath` as an alternative
 * to `modelName`+`modelsDir` (see `engineOptionsFromConfig()` in
 * `harper-fabric-embeddings`' `dist/index.js`): an absolute path bypasses its
 * built-in model registry and HuggingFace-download resolution entirely. This
 * hatch is the one line that lets a caller reach that existing parameter.
 * `EmbeddingEngine`'s `modelIdentity` (used for nomic-prefix detection, see
 * `engine.js`'s `#applyPrefix`) becomes the file's basename in this path, so
 * prefix behavior is unaffected as long as the GGUF's filename still
 * contains "nomic-embed-text".
 *
 * No production deploy sets this env var, so the unset (overwhelmingly
 * common) case is byte-identical to before this hatch existed.
 */
function benchModelPathOverride(): string | undefined {
  return process.env.FLAIR_RECALL_HARNESS_MODEL_PATH || undefined;
}

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
    const modelPath = benchModelPathOverride();
    await register({
      logicalName: LOGICAL_NAME,
      kind: "embedding",
      config: modelPath
        ? { modelPath, pooling: EMBEDDING_POOLING }
        : { modelName: MODEL_NAME, modelsDir: resolveModelsDir(), pooling: EMBEDDING_POOLING },
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
