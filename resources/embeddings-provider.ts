/**
 * embeddings-provider.ts
 *
 * Wrapper around Harper's native `models.embed()` facade for Flair resources.
 *
 * Phase 1 (flair#504) — infra swap, DEAD-FLAT WASH. Embeddings now resolve
 * through Harper's process-wide `models` singleton instead of this file
 * dynamic-importing `harper-fabric-embeddings` and initializing it itself.
 * The engine is the SAME one, registered as the `embedding`/`default`
 * backend by harper-fabric-embeddings@0.3.0's own `register()` factory —
 * called DIRECTLY, in-process, by `resources/embeddings-boot.ts` on every
 * boot (flair#694; see that file's header for why: the original mechanism
 * drove `register()` off a `models.embedding.default` block Harper's
 * `bootstrapModels()` read from the INSTANCE-ROOT config, delivered via the
 * `HARPER_CONFIG` env var — but that env var's value got PERSISTED into
 * `harper-config.yaml`, and a boot that didn't reassert it (any
 * older/downgraded build) tore the persisted block down to an invalid empty
 * shell that the next boot's config validator rejected outright, bricking
 * the instance). Registering directly means nothing is ever written to the
 * config file, so there is no downgrade-unsafe state — and it works
 * uniformly whether this package's own `config.yaml` loads root or non-root
 * (e.g. a Harper Fabric deploy, where it's always non-root and
 * `bootstrapModels()` was never reachable at all). Phase 1 passed no
 * `inputType`, so no
 * `search_document:`/`search_query:` prefix was applied — output was
 * byte-identical to the pre-migration direct-import path. That's what made
 * that swap a dead-flat wash: same model, same weights, same input, same
 * output — only the plumbing changed. Phase 2 (below) turns `inputType` on.
 *
 * This retires the `@node-llama-cpp/<platform>` addon-path discovery and
 * the VM-sandbox manual-init block that used to live here: Harper 5.0.0's VM
 * sandbox can't statically link npm packages during module resolution (an
 * async race in getOrCreateModule), which is why the OLD code deferred to a
 * dynamic import() on first call. That fragility — a runtime bump silently
 * breaking embeddings on next restart (the node-26 near-miss) — is exactly
 * what this migration removes: `models.embed` is a process-wide singleton
 * Harper initializes at boot, off the first-call dynamic-import race.
 *
 * `@harperfast/harper` is dynamic-imported here (deferred to first actual
 * getEmbedding()/getMode()/getStatus() call), NOT statically imported like
 * every other resource's `Resource`/`databases`/`server` — those work
 * unmocked-import-free only because every test that (transitively) imports
 * them already mocks `@harperfast/harper` first. Statically importing
 * `models` here would make *any* test that imports this file for
 * `resolveModelsDir()` alone (test/unit/embeddings-models-dir.test.ts, which
 * has no reason to know about Harper at all) also eagerly load Harper's real
 * `dist/index.js` — which `require()`s `server/threads/threadServer.js` at
 * module scope and throws ("Unable to determine database storage path...")
 * outside an actual Harper boot (verified: this broke 4 unit-test files
 * before this file switched to a deferred import). Deferring avoids that
 * entirely: the dynamic import only fires when an embedding is actually
 * requested, exactly mirroring this file's own pre-existing pattern for
 * harper-fabric-embeddings.
 *
 * Phase 2 (flair#504) — nomic search prefixes, now ON. Verified from HFE
 * 0.3.0's shipped `engine.js` (`#applyPrefix`): `models.embed(text, { model,
 * inputType })` forwards `inputType` to the backend, which prepends
 * `search_document: ` for `inputType === 'document'`, `search_query: ` for
 * `'query'`, and nothing for `undefined` (Phase 1's wash). nomic-embed-text-
 * v1.5 is *trained* on this asymmetry, so the design hypothesis going in was
 * that turning it on would be a real recall improvement, not just plumbing.
 * The measured A/B (recall-harness instrument v2, N=126 queries,
 * 2026-07-11; see `test/bench/recall-harness/README.md`'s "v2 measured
 * results") didn't confirm that hypothesis, but it didn't refute it either:
 * prefixes=off p@3=0.992/MRR=0.949 vs prefixes=on p@3=0.976/MRR=0.946
 * (Δp@3 -0.016 — 2 of 126 queries — ΔMRR -0.003, SE=±0.000 across 3 runs in
 * both arms). Stated plainly: that delta is noise-scale at this instrument's
 * N, not a directional signal either way — see PR #689 for the full
 * measurement and its initial "park on the numbers" read.
 *
 * This checkpoint of flair#504 revisits that read and flips
 * `EMBEDDING_PREFIXES_ENABLED` to `true` on strategic grounds instead, since
 * the recall measurement alone was a wash: nomic-embed-text-v1.5 is trained
 * expecting these prefixes, so running it unprefixed indefinitely is the
 * actual departure from convention, not the reverse. The flip is also the
 * first real payload for the boot-keyed auto-migration machinery (flair#690,
 * flair#695) — exercising the detect-stale/re-embed path now, on a change
 * with a proven noise-scale recall floor, is lower-risk than letting that
 * machinery sit unexercised until some future higher-stakes change needs it
 * first, and avoids two unrelated stamp-bumping changes compounding into one
 * migration debt pile. This file still ships the same plumbing (typed
 * `inputType`, every call site passing the correct literal), the same stamp
 * mechanism (`EMBEDDING_VARIANT`/`getModelId()`), and the same measurement
 * instrument as PR #689 — what changed is the gate value and the
 * re-baselined `test/bench/recall-harness/BASELINE.json` this flip required.
 *
 * `EmbedInputType` is a closed union — `'document' | 'query'` — because the
 * values are literal and load-bearing: `'search_document'` (the PREFIX
 * STRING, not the inputType VALUE) is truthy but `!== 'document'`, so passing
 * it as a value falls to the engine's `else` branch and applies the QUERY
 * prefix to a document — silently inverting the asymmetry and degrading
 * recall. The union makes that a compile-time error for typed callers;
 * `buildEmbedOptions()` below adds a runtime guard as defense in depth for a
 * caller that bypasses the type system. Every `getEmbedding()` call site
 * passes the correct literal unconditionally — they declare INTENT
 * ('document' for stored content, 'query' for a search query); the gate at
 * `buildEmbedOptions()`/`getModelId()` is the single chokepoint that decides
 * whether that intent actually reaches the backend. Flipping the gate DOES
 * change `getModelId()`'s output (the `+searchprefix` suffix now applies by
 * default — see `EMBEDDING_VARIANT` below), which means every row written
 * before this PR now reads as stale against the new model id — the
 * boot-keyed auto-migration runner
 * (`resources/migrations/embedding-stamp.ts`) picks that up and re-embeds
 * automatically on next boot. That is this flip's intended, not incidental,
 * consequence: proving the migration machinery actually re-embeds a real
 * corpus end to end. A live production instance re-embedding on upgrade is
 * still a separate, deliberate step from shipping this code — see the PR
 * description for that distinction.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

/**
 * The nomic search-prefix `inputType` — closed union, not `string`. See the
 * file header: the VALUES `'document'`/`'query'` are what HFE 0.3.0's engine
 * matches on; anything else (including the prefix strings themselves,
 * `'search_document'`/`'search_query'`) falls through to no-match-is-query
 * behavior. Widening this to `string` would silently reopen that bug for
 * every typed caller — don't.
 */
export type EmbedInputType = "document" | "query";

const VALID_INPUT_TYPES: ReadonlySet<string> = new Set<EmbedInputType>(["document", "query"]);

/**
 * THE GATE (flair#504 Phase 2 — flipped ON). A module-level constant, not an
 * env toggle: Kern's original Phase 2 review called this "a code-level
 * decision," and that principle survives the flip — an operator must not be
 * able to move prefix behavior out of sync with a re-baselined A/B. This PR
 * IS that re-baseline: `test/bench/recall-harness/BASELINE.json` now records
 * the prefixes=on numbers this gate change measured, replacing the
 * prefixes=off baseline PR #689 froze. See that file and
 * `test/bench/recall-harness/README.md`'s "Phase 2 prefix A/B" section for
 * why it's on: the measured v2 A/B (N=126) showed a noise-scale delta
 * between arms (Δp@3 -0.016, ΔMRR -0.003, 2 of 126 queries) — not the
 * hypothesized bump, but not a real regression either — so the decision to
 * flip rests on strategic grounds (training-convention alignment, and using
 * this wash-scale change as the auto-migration machinery's proving payload)
 * rather than a recall win. Flipping this back to `false` requires the same
 * process in reverse: a fresh harness run through the ratchet gate that
 * shows staying on is actively worse, not just unproven.
 *
 * This is THE single chokepoint both `buildEmbedOptions()` (inputType
 * forwarding) and `getModelId()` (the `+searchprefix` stamp) read — see
 * `prefixesEnabled()` immediately below. They must never diverge: a suffix
 * without matching inputType-forwarding (or vice versa) would silently
 * mislabel every embedding written while the mismatch existed (dedup and
 * stale-detection both key off `embeddingModel`, and it would no longer
 * describe what was actually forwarded to `models.embed()`). Enforcing this
 * at one chokepoint — rather than trusting every call site and every
 * stamp-reader to independently agree — is what makes that impossible by
 * construction instead of by convention.
 */
const EMBEDDING_PREFIXES_ENABLED = true; // Phase 2 prefix flip ON — re-baselined through the ratchet gate (flair#504)

/**
 * BENCH-ONLY escape hatch — NOT a production feature flag, never documented
 * as an operator setting, and never read by any call site (Memory.ts,
 * SemanticSearch.ts, MemoryBootstrap.ts, auth-middleware.ts) — those pass
 * `'document'`/`'query'` unconditionally regardless of the gate; only
 * `prefixesEnabled()` (immediately below) reads this.
 *
 * test/bench/recall-harness/run.ts's `--prefixes on|off` arms and its
 * mixed-space canary need to measure "as if the gate were flipped the other
 * way" against the SAME dist build the default ships — the harness is an
 * external HTTP client with no way to reach into a spawned Harper process's
 * embedding call, so this lets it override the ONE thing that matters
 * (whether `models.embed` receives `inputType`, and whether `getModelId()`
 * stamps the suffix) via the env var it already forwards to `startHarper()`
 * (the same mechanism `FLAIR_HYBRID_RETRIEVAL`/`FLAIR_RERANK_ENABLED` use).
 *
 * Bidirectional, not two separate force-on/force-off hatches: THE GATE has
 * flipped direction once already (off→on, this PR) and may again in the
 * future, so a single override that reads `"true"`/`"false"` (unset = defer
 * to THE GATE) stays correct regardless of which way the gate itself is
 * currently set — the harness always names the arm it wants explicitly
 * rather than assuming "no hatch" means "off" (or "on"). Read lazily (not
 * cached at module load) to match this codebase's existing env-var
 * convention (see resources/rate-limiter.ts).
 */
function harnessPrefixOverride(): boolean | undefined {
  const v = process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/**
 * The single source of truth for "are prefixes active right now" — reads
 * THE GATE, overridden by the bench-only hatch when set. Both
 * `buildEmbedOptions()` and `getModelId()` call this and nothing else, so
 * the suffix and the inputType-forwarding can never diverge (see
 * `EMBEDDING_PREFIXES_ENABLED`'s doc above for why that invariant matters).
 */
function prefixesEnabled(): boolean {
  const override = harnessPrefixOverride();
  return override !== undefined ? override : EMBEDDING_PREFIXES_ENABLED;
}

/**
 * Build the options object passed to `models.embed()`. Pulled out as its own
 * pure, harper-free function so the value-forwarding (and the reject-a-
 * wrong-value guard) is unit-testable without touching the deferred
 * `@harperfast/harper` import this file's header explains — see
 * test/unit/embeddings-provider-input-type.test.ts.
 *
 * Gate ON (default): rejects anything other than the literal
 * `'document'`/`'query'` (or omitted): TypeScript's `EmbedInputType` union
 * already makes a wrong value a COMPILE-time error for typed callers; this
 * is defense in depth for a caller that bypasses the type system (`as any`,
 * a future refactor that loosens the type, a plain-JS caller). A rejected
 * value is treated as if omitted (no prefix) rather than forwarded — see the
 * file header for why forwarding the wrong value is actively harmful, not
 * just a no-op.
 *
 * Gate OFF (only reachable now via the bench-only override — see
 * `harnessPrefixOverride()`): `inputType` is dropped even when a call site
 * passes one — call sites keep passing `'document'`/`'query'`
 * unconditionally (they declare intent; this chokepoint enforces the gate),
 * matching Phase 1's wash behavior exactly.
 */
export function buildEmbedOptions(inputType?: EmbedInputType): { model: "default"; inputType?: EmbedInputType } {
  if (!prefixesEnabled()) return { model: "default" };
  if (inputType !== undefined && !VALID_INPUT_TYPES.has(inputType)) {
    console.error(
      `[embeddings] getEmbedding: invalid inputType ${JSON.stringify(inputType)} ignored (expected 'document' | 'query' | undefined) — see flair#504 Phase 2, passing the prefix STRING as the VALUE inverts the asymmetry`
    );
    return { model: "default" };
  }
  return inputType ? { model: "default", inputType } : { model: "default" };
}

type HarperModelsApi = typeof import("@harperfast/harper")["models"];

let _modelsApi: HarperModelsApi | undefined;

/**
 * Resolve (and cache) Harper's `models` facade via a deferred import — see file header.
 *
 * NOTE for anyone using this as a reference: `models` (the `@harperfast/harper`
 * package export) and a component's `scope.models` are the SAME boot-time
 * singleton — Harper's jsLoader hands components `scope.models = <the global
 * models>` (two accessors, one object; the model registry lives on that singleton).
 * A Harper *component* (one with a `handleApplication(scope)` hook) reaches it
 * idiomatically as `scope.models`; this file is a Resource *helper* with no
 * `scope`, so it imports the global export. Same registry, same backends — the
 * global import here is the correct accessor for this context, not a workaround.
 */
async function getModelsApi(): Promise<HarperModelsApi> {
  if (_modelsApi) return _modelsApi;
  const harper = await import("@harperfast/harper");
  _modelsApi = harper.models;
  return _modelsApi;
}

/**
 * Resolve the directory the embeddings model lives in / downloads into.
 *
 * Resolution order (everything writable, never the read-only package dir):
 *   1. FLAIR_MODELS_DIR        — explicit operator/docker override.
 *   2. <ROOTPATH>/models       — Harper's data dir (Flair passes ROOTPATH =
 *                                ~/.flair/data when it spawns Harper). User-
 *                                owned and writable even on sudo-global installs.
 *   3. <cwd>/models            — ONLY if a model already lives there. Backward
 *                                compat for existing writable installs that
 *                                downloaded into the package dir before this fix;
 *                                never used as a download target on fresh installs.
 *   4. ~/.flair/data/models    — last-resort default when ROOTPATH is unset.
 *
 * The chosen dir is always writable, so the embeddings engine can download the
 * model on first use without hitting EACCES on a root-owned package dir.
 *
 * Called by `resources/embeddings-boot.ts` (flair#694) to build the
 * `modelsDir` it passes to harper-fabric-embeddings' `register()` — both run
 * in the SAME process now (unlike the retired src/cli.ts-side computation,
 * which duplicated this exact default because it ran in a separate process
 * that set the resulting value via an env var). Still exported and tested
 * independently (test/unit/embeddings-models-dir.test.ts) as the single
 * documented source of truth for this default.
 */
export function resolveModelsDir(): string {
  const override = process.env.FLAIR_MODELS_DIR;
  if (override) return override;

  const rootPath = process.env.ROOTPATH;
  if (rootPath) return join(rootPath, "models");

  // Backward compat: a prior (writable) install may have the model cached in
  // the package dir. Reuse it rather than re-downloading — but only if present.
  const cwdModels = join(process.cwd(), "models");
  if (existsSync(cwdModels)) return cwdModels;

  return join(homedir(), ".flair", "data", "models");
}

// ─── Health translation (Design §3 / Kern's hardening) ──────────────────────
// `models.embed()` THROWS (ModelBackendNotFoundError / ModelCapabilityError)
// on failure — it does not return null, and there's no backend-agnostic
// health API. getMode()/getStatus() gate SemanticSearch's keyword-only
// fallback (SemanticSearch.ts:558) and must preserve that exact
// degrade-gracefully contract. Both are called SYNCHRONOUSLY by consumers,
// so a cached flag — kept current by a boot probe and by every real
// getEmbedding() call's outcome — stands in for a live await.

type Mode = "local" | "none";

// Kern: "Boot probe MUST have a 5-10s timeout ... on timeout set mode='none'
// + log a warning. A hung probe ... must never block Harper boot."
const PROBE_TIMEOUT_MS = 8_000;

let _mode: Mode = "none"; // pessimistic until the probe (or a real call) proves otherwise
let _dims: number | undefined;
let _lastError: string | undefined;
let _probeStarted = false;
let _warnedOnce = false;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    // Never let a pending probe keep the process alive on its own.
    (timer as unknown as { unref?: () => void }).unref?.();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Boot-time health probe. Does NOT gate getEmbedding() (which always
 * attempts the real call and lets its own try/catch decide the return
 * value) — this exists purely to populate the synchronous getMode() /
 * getStatus() contract those two functions must preserve.
 *
 * `dims` is sourced from an actual embed call's output, never from a raw
 * `dimensions()` accessor — the facade has no dims-metadata accessor (HFE
 * PR #3 confirmed this), and a backend's own `dimensions()` would reflect
 * ITS default engine, not necessarily the config-registered `default`
 * backend `models.embed` actually calls. A mismatch here would be a silent
 * regression in the embedding-stamp / stale-detection logic (Kern's Q3).
 */
async function probe(): Promise<void> {
  try {
    const models = await getModelsApi();
    const [vec] = await withTimeout(
      models.embed("x", { model: "default" }),
      PROBE_TIMEOUT_MS,
      "embedding boot-probe",
    );
    _dims = vec?.length;
    _mode = "local";
    _lastError = undefined;
  } catch (err: any) {
    _mode = "none";
    _lastError = err?.message ?? String(err);
    if (!_warnedOnce) {
      console.warn(
        `[embeddings] WARN: native embeddings unavailable, falling back to keyword-only search. Error: ${_lastError}`
      );
      _warnedOnce = true;
    }
  }
}

function ensureProbeStarted(): void {
  if (_probeStarted) return;
  _probeStarted = true;
  probe().catch(() => {}); // probe() already catches internally; belt-and-suspenders
}

/**
 * Generate an embedding vector for the given text via Harper's `models.embed()`
 * facade. Returns null if the embedding backend isn't available — preserves
 * the pre-migration null-on-failure contract.
 *
 * Phase 2 (flair#504): callers pass `inputType` — `'document'` for stored
 * memory content (Memory.ts's dedup gate / post / put, auth-middleware.ts's
 * backfill), `'query'` for a search query (SemanticSearch.ts,
 * MemoryBootstrap.ts) — unconditionally, declaring intent. Whether that
 * `inputType` actually reaches HFE 0.3.0 (which would prepend the matching
 * `search_document: `/`search_query: ` prefix — see file header) is gated:
 * `buildEmbedOptions()` is the single chokepoint that turns `inputType` into
 * the options object, and it forwards `inputType` while THE GATE
 * (`EMBEDDING_PREFIXES_ENABLED`) is on — the current default (flipped this
 * PR; see the file header for why). Omitted (no second arg) always stays a
 * no-op regardless of the gate, same as Phase 1.
 */
export async function getEmbedding(text: string, inputType?: EmbedInputType): Promise<number[] | null> {
  ensureProbeStarted();
  try {
    const models = await getModelsApi();
    const [vec] = await models.embed(text, buildEmbedOptions(inputType));
    if (!vec) return null;
    // Self-heal on a live success — harper-fabric-embeddings' register() loads
    // the model in the background and retries readiness on the next call, so
    // a transient failure the boot probe caught needn't stay sticky forever.
    _mode = "local";
    _dims = vec.length;
    _lastError = undefined;
    return Array.from(vec);
  } catch (err: any) {
    _mode = "none";
    _lastError = err?.message ?? String(err);
    console.error(`[embeddings] embed failed: ${_lastError}`);
    return null;
  }
}

/**
 * Check if the embedding engine is currently believed available.
 * Called synchronously (SemanticSearch.ts gates its keyword-only fallback on
 * this), so it reads the cached flag the boot probe and getEmbedding() keep
 * current rather than awaiting a live call.
 */
export function getMode(): Mode {
  ensureProbeStarted();
  return _mode;
}

/**
 * Variant suffix — Kern's call (flair#504 Phase 2 review), NOT
 * `FLAIR_EMBEDDING_MODEL`: prefix-on uses the SAME model/weights as Phase 1,
 * so the base model id alone can't distinguish a prefixed vector from an
 * unprefixed one. Without a distinct stamp, `flair reembed --stale-only`
 * would see every row's `embeddingModel` already match `getModelId()` and
 * skip them all, and `health.ts` would report a false "all uniform" state —
 * this is the linchpin that makes stale-detection (and therefore the
 * re-embed this flip triggers) possible at all. Only appended when
 * `prefixesEnabled()` is true (see `getModelId()` below) — with THE GATE now
 * on (this PR's default), `getModelId()` returns `<base>+searchprefix` by
 * default, so every row embedded before this PR (stamped with the bare base
 * id, since the gate was off when it was written) now reads as stale —
 * exactly the signal the boot-keyed auto-migration runner
 * (`resources/migrations/embedding-stamp.ts`) needs to re-embed them. That
 * mass "stale" transition is this flip's intended payload, not a bug.
 */
const EMBEDDING_VARIANT = "searchprefix";

/**
 * Get the current embedding model identifier.
 * Used for stamping memories and detecting stale embeddings. Reads the SAME
 * `prefixesEnabled()` chokepoint `buildEmbedOptions()` does (see THE GATE's
 * doc above `EMBEDDING_PREFIXES_ENABLED`) — gate on (default): bumps to
 * `<base>+searchprefix` (see `EMBEDDING_VARIANT` above). Gate off (only
 * reachable now via the bench-only override, see `harnessPrefixOverride()`):
 * bare base id, no suffix. A prefixed vector and an unprefixed vector of the
 * SAME text are genuinely different vectors (dedup must not short-circuit
 * across them), and `--stale-only` needs a distinct string to target the
 * rows that still need re-embedding. `+` is URL-safe and doesn't collide
 * with the existing `-`/`_` id characters. `src/cli.ts` duplicates this
 * exact gate-then-suffix logic for `--stale-only` (separate build target,
 * see its own comment) — the two must never drift.
 */
export function getModelId(): string {
  const base = process.env.FLAIR_EMBEDDING_MODEL ?? "nomic-embed-text-v1.5-Q4_K_M";
  return prefixesEnabled() ? `${base}+${EMBEDDING_VARIANT}` : base;
}

/**
 * Get embedding engine status for diagnostics.
 * `dims`/`model` are sourced from what `models.embed()` actually produced
 * (the boot probe or the last real call) — never from a backend's raw
 * `dimensions()` accessor (Kern's Q3 hardening).
 */
export function getStatus(): {
  mode: Mode;
  model?: string;
  dims?: number;
  error?: string;
} {
  ensureProbeStarted();
  if (_mode === "local") {
    return {
      mode: _mode,
      model: "nomic-embed-text-v1.5",
      dims: _dims,
    };
  }
  return {
    mode: _mode,
    error: _lastError,
  };
}
