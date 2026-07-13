import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { buildEmbedOptions, getModelId } from "../../resources/embeddings-provider";

/**
 * buildEmbedOptions() / getModelId() (flair#504 Phase 2, nomic search
 * prefixes — FLIPPED ON, re-baselined through the ratchet gate) — the single
 * chokepoint (`prefixesEnabled()` inside embeddings-provider.ts) both
 * functions read to decide whether inputType-forwarding and the
 * `+searchprefix` model-id suffix are active. THE GATE
 * (`EMBEDDING_PREFIXES_ENABLED`) now defaults to `true` (see
 * test/bench/recall-harness/README.md's "v2 measured results" and
 * BASELINE.json — the measured recall delta between arms was noise-scale,
 * not a regression) — this file pins that default AND the bidirectional
 * bench-only override (`FLAIR_RECALL_HARNESS_FORCE_PREFIX`, reading
 * `"true"`/`"false"`) that lets the harness measure BOTH arms against the
 * SAME dist build.
 *
 * Deliberately does NOT go through `getEmbedding()` itself (which would
 * require mocking `@harperfast/harper`'s deferred dynamic import) — that
 * import is process-global and this codebase already has multiple test files
 * racing to be the first to mock `@harperfast/harper` (see
 * memory-soul-read-gate.test.ts's header for the mechanics of that
 * collision); none of those existing mocks export `models`, so a fresh mock
 * here would be at the mercy of `bun test`'s file load order, not a real
 * guarantee. `buildEmbedOptions`/`getModelId` are pure and harper-free, so
 * they sidestep that fragility entirely while still exercising the exact
 * value-forwarding (and reject-a-wrong-value) logic `getEmbedding()`
 * delegates to.
 *
 * The core thing the reject-guard tests below cover: `'search_document'`/
 * `'search_query'` are the PREFIX STRINGS the HFE 0.3.0 engine prepends —
 * they are NOT valid `inputType` VALUES. Passing `'search_document'` as a
 * value is truthy but `!== 'document'`, so the engine's `#applyPrefix` falls
 * to its `else` branch and applies the QUERY prefix to what is actually a
 * document — silently inverting the trained asymmetry and degrading recall.
 * TypeScript's `EmbedInputType` union already makes this a compile-time
 * error for typed callers (see tsconfig.check.json's `resources/**`
 * coverage); this test exercises the runtime guard that's defense in depth
 * for anything that bypasses the type system (`as any`, a future refactor
 * that loosens the type, a plain-JS caller).
 */
describe("buildEmbedOptions / getModelId (flair#504 Phase 2 — nomic search prefix gate, ON by default)", () => {
  const SAVED_HARNESS_FLAG = process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX;
  const SAVED_MODEL = process.env.FLAIR_EMBEDDING_MODEL;

  beforeEach(() => {
    // Belt-and-suspenders against env leak from another file/run — the
    // bench-only override and any operator model override must start clean
    // so these tests exercise the real shipped default.
    delete process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX;
    delete process.env.FLAIR_EMBEDDING_MODEL;
  });

  afterEach(() => {
    if (SAVED_HARNESS_FLAG === undefined) delete process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX;
    else process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX = SAVED_HARNESS_FLAG;
    if (SAVED_MODEL === undefined) delete process.env.FLAIR_EMBEDDING_MODEL;
    else process.env.FLAIR_EMBEDDING_MODEL = SAVED_MODEL;
  });

  describe("gate ON (default — EMBEDDING_PREFIXES_ENABLED=true, no override)", () => {
    it("forwards 'document' exactly", () => {
      expect(buildEmbedOptions("document")).toEqual({ model: "default", inputType: "document" });
    });

    it("forwards 'query' exactly", () => {
      expect(buildEmbedOptions("query")).toEqual({ model: "default", inputType: "query" });
    });

    it("omits inputType when not provided", () => {
      expect(buildEmbedOptions()).toEqual({ model: "default" });
    });

    it("getModelId() carries the +searchprefix suffix", () => {
      expect(getModelId()).toBe("nomic-embed-text-v1.5-Q4_K_M+searchprefix");
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
  });

  describe("bench-only override (FLAIR_RECALL_HARNESS_FORCE_PREFIX=false) — the recall-harness '--prefixes off' arm", () => {
    beforeEach(() => {
      process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX = "false";
    });

    it("drops inputType even when a call site passes one", () => {
      expect(buildEmbedOptions("document")).toEqual({ model: "default" });
      expect(buildEmbedOptions("query")).toEqual({ model: "default" });
    });

    it("omits inputType when not provided", () => {
      expect(buildEmbedOptions()).toEqual({ model: "default" });
    });

    it("getModelId() has no suffix — base id only (no stale-read false-positive on a no-op re-embed)", () => {
      expect(getModelId()).toBe("nomic-embed-text-v1.5-Q4_K_M");
      expect(getModelId()).not.toContain("+searchprefix");
    });
  });

  describe("bench-only override (FLAIR_RECALL_HARNESS_FORCE_PREFIX=true) — explicit, redundant with the default, but must agree with it", () => {
    beforeEach(() => {
      process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX = "true";
    });

    it("forwards 'document' exactly", () => {
      expect(buildEmbedOptions("document")).toEqual({ model: "default", inputType: "document" });
    });

    it("forwards 'query' exactly", () => {
      expect(buildEmbedOptions("query")).toEqual({ model: "default", inputType: "query" });
    });

    it("getModelId() carries the +searchprefix suffix", () => {
      expect(getModelId()).toBe("nomic-embed-text-v1.5-Q4_K_M+searchprefix");
    });
  });

  /**
   * THE INVARIANT (Kern's ratified mechanism, PR #689, unchanged by the
   * flip): THE GATE atomically controls BOTH inputType-forwarding and the
   * model-id suffix — they must NEVER diverge. A row stamped `+searchprefix`
   * whose vector was actually computed WITHOUT the prefix (or vice versa)
   * would silently corrupt dedup and stale-detection, which both key off
   * `embeddingModel` matching what was actually forwarded to
   * `models.embed()`. This sweeps every externally-reachable configuration —
   * the bench-only override is the only runtime lever (three states: unset
   * defers to THE GATE, `"true"` forces on, `"false"` forces off);
   * `EMBEDDING_PREFIXES_ENABLED` itself is a hardcoded module constant, not a
   * runtime toggle, by design (see that constant's doc in
   * resources/embeddings-provider.ts) — and asserts the two never disagree
   * in any of the three reachable states, in either direction the gate might
   * default to.
   */
  describe("invariant: suffix presence and inputType-forwarding never diverge", () => {
    const overrides: { label: string; value: string | undefined }[] = [
      { label: "unset (defers to THE GATE, currently on)", value: undefined },
      { label: 'override="true"', value: "true" },
      { label: 'override="false"', value: "false" },
    ];
    for (const { label, value } of overrides) {
      it(`${label}: it is impossible to observe suffix-without-inputType or inputType-without-suffix`, () => {
        if (value === undefined) delete process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX;
        else process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX = value;

        const hasSuffix = getModelId().endsWith("+searchprefix");
        const docForwards = "inputType" in buildEmbedOptions("document");
        const queryForwards = "inputType" in buildEmbedOptions("query");

        expect(docForwards).toBe(hasSuffix);
        expect(queryForwards).toBe(hasSuffix);
        // Explicitly rule out both illegal combinations by name, not just
        // by the equality assertions above.
        expect(hasSuffix && !docForwards).toBe(false); // suffix WITHOUT inputType
        expect(!hasSuffix && docForwards).toBe(false); // inputType WITHOUT suffix
      });
    }
  });
});
