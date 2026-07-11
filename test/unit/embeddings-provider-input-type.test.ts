import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { buildEmbedOptions } from "../../resources/embeddings-provider";

/**
 * buildEmbedOptions() (flair#504 Phase 2, nomic search prefixes) — the single
 * chokepoint `getEmbedding()` uses to turn an `inputType` into the options
 * object passed to Harper's `models.embed()`.
 *
 * Deliberately does NOT go through `getEmbedding()` itself (which would
 * require mocking `@harperfast/harper`'s deferred dynamic import) — that
 * import is process-global and this codebase already has multiple test files
 * racing to be the first to mock `@harperfast/harper` (see
 * memory-soul-read-gate.test.ts's header for the mechanics of that
 * collision); none of those existing mocks export `models`, so a fresh mock
 * here would be at the mercy of `bun test`'s file load order, not a real
 * guarantee. `buildEmbedOptions` is pure and harper-free, so it sidesteps
 * that fragility entirely while still exercising the exact value-forwarding
 * (and reject-a-wrong-value) logic `getEmbedding()` delegates to.
 *
 * The core thing this guards: `'search_document'`/`'search_query'` are the
 * PREFIX STRINGS the HFE 0.3.0 engine prepends — they are NOT valid
 * `inputType` VALUES. Passing `'search_document'` as a value is truthy but
 * `!== 'document'`, so the engine's `#applyPrefix` falls to its `else`
 * branch and applies the QUERY prefix to what is actually a document —
 * silently inverting the trained asymmetry and degrading recall. TypeScript's
 * `EmbedInputType` union already makes this a compile-time error for typed
 * callers (see tsconfig.check.json's `resources/**` coverage); this test
 * exercises the runtime guard that's defense in depth for anything that
 * bypasses the type system (`as any`, a future refactor that loosens the
 * type, a plain-JS caller).
 */
describe("buildEmbedOptions (flair#504 Phase 2 — nomic search prefix inputType)", () => {
  const SAVED_HARNESS_FLAG = process.env.FLAIR_RECALL_HARNESS_NO_PREFIX;

  beforeEach(() => {
    // Belt-and-suspenders against env leak from another file/run — this
    // harness-only escape hatch must be OFF for these tests to exercise the
    // real (non-harness) behavior.
    delete process.env.FLAIR_RECALL_HARNESS_NO_PREFIX;
  });

  afterEach(() => {
    if (SAVED_HARNESS_FLAG === undefined) delete process.env.FLAIR_RECALL_HARNESS_NO_PREFIX;
    else process.env.FLAIR_RECALL_HARNESS_NO_PREFIX = SAVED_HARNESS_FLAG;
  });

  it("omits inputType when not provided (Phase-1 no-prefix behavior, unchanged)", () => {
    expect(buildEmbedOptions()).toEqual({ model: "default" });
  });

  it("forwards 'document' exactly", () => {
    expect(buildEmbedOptions("document")).toEqual({ model: "default", inputType: "document" });
  });

  it("forwards 'query' exactly", () => {
    expect(buildEmbedOptions("query")).toEqual({ model: "default", inputType: "query" });
  });

  it("rejects 'search_document' as a VALUE — the exact bug flair#504 Phase 2 flags: truthy but not 'document', would invert the prefix asymmetry", () => {
    expect(buildEmbedOptions("search_document" as any)).toEqual({ model: "default" });
  });

  it("rejects 'search_query' as a VALUE for the same reason", () => {
    expect(buildEmbedOptions("search_query" as any)).toEqual({ model: "default" });
  });

  it("rejects an arbitrary wrong string rather than forwarding it", () => {
    expect(buildEmbedOptions("bogus" as any)).toEqual({ model: "default" });
  });

  it("harness escape hatch (FLAIR_RECALL_HARNESS_NO_PREFIX=true) forces no-prefix regardless of a valid inputType — test/bench/recall-harness/run.ts's '--prefixes off' arm depends on this", () => {
    process.env.FLAIR_RECALL_HARNESS_NO_PREFIX = "true";
    expect(buildEmbedOptions("document")).toEqual({ model: "default" });
    expect(buildEmbedOptions("query")).toEqual({ model: "default" });
  });
});
