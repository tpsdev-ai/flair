/**
 * embedding-identity-tripwire.test.ts — structural guard that embedding
 * "is this stale / does this need re-embedding / is this the same model"
 * decisions ride on METADATA (model id string, GGUF file hash, backend
 * version, template/inputType config) and never on vector BYTES or a hash
 * of vector bytes compared across environments (flair#749).
 *
 * ─── The contract this enforces ────────────────────────────────────────────
 * flair#749 (fallout from hfe#10's reproducibility probe): the L2-normalize
 * path is bit-identical hfe 0.2.3 through 0.5.0 (addon pinned exact), yet the
 * #685-arc comparison measured ~5.85e-8/dim drift between environments. The
 * real source is environmental, not a version discontinuity — ggml
 * accumulation order varies with platform binary (Metal vs linux-x64),
 * `threads`, and `batchSize`, so f32-epsilon-scale output differences on
 * IDENTICAL inputs are EXPECTED across environments. If any embedding-
 * identity or re-embed-detection gate ever compared raw vector bytes (or a
 * hash of them) across environments, that epsilon drift would read as
 * "model changed, re-embed everything" — a false positive that could
 * trigger a pointless full-corpus re-embed. hfe#17 documents the upstream
 * reproducibility contract this rides on: bit-stability is guaranteed for
 * the SAME binary/platform/config, never claimed across environments.
 *
 * The fix flair actually ships (audited below, all confirmed metadata-only
 * as of this PR — see each SCAN_TARGETS entry's `why`): every place that
 * decides staleness or reports embedding-model health compares the
 * `embeddingModel` STRING stamp (`getModelId()`'s `<base>[+searchprefix]`,
 * see resources/embeddings-provider.ts) — never `embedding` (the vector
 * array) itself, and never a hash of it. This test makes that a structural,
 * CI-enforced invariant, the same way claimed-zero-authority-tripwire.test.ts
 * makes flair#735's "claimed.* grants zero authority" contract structural
 * instead of convention-only.
 *
 * ─── What is (and isn't) a violation ───────────────────────────────────────
 * NOT flagged: `m.embeddingModel === current` / `!== currentModel` (the
 * correct pattern — a metadata string compare) and
 * `cosineSimilarity(embedding, candidateEmbedding)` (Memory.ts's dedup gate —
 * a THRESHOLD-gated (>=0.95) semantic-similarity SIGNAL over real content,
 * never an identity/staleness decision, and its threshold is ~7 orders of
 * magnitude looser than the ~1e-6-scale epsilon drift flair#749 describes,
 * so cross-environment float noise cannot flip it).
 *
 * FLAGGED: hashing an embedding/vector array at all (`createHash`/`.digest(`
 * appearing anywhere in these scoped regions — none of them have any
 * legitimate reason to hash anything; confirmed by reading each region in
 * full during this PR's audit) or exact/strict comparison or serialization
 * of a raw vector (`embedding ===`/`!==`, `vector ===`/`!==`,
 * `JSON.stringify(embedding)`/`JSON.stringify(vector)`) — the pattern
 * flair#749 warns would silently misfire on ordinary cross-environment or
 * cross-config float noise.
 *
 * Token-boundary note (mirrors claimed-zero-authority-tripwire.test.ts's
 * care around `.claimed` vs `unclaimed`/`reclaimed`): `"embedding ==="` and
 * `"JSON.stringify(embedding)"`/`"JSON.stringify(embedding,"` are chosen
 * specifically so they do NOT match `embeddingModel === current` or
 * `JSON.stringify(embeddingModel)` — `embeddingModel` immediately follows
 * `embedding` with `M`, never a space, `)`, or `,`, so the closed/spaced
 * violation tokens below cannot match the legitimate metadata-string
 * comparisons this codebase relies on. Verified by the "sanity: existing
 * metadata comparisons do not trip the scanner" test below.
 *
 * ─── Scan targets, and why each is an embedding-identity decision site ────
 * Chosen from this PR's own audit (see the PR body for the full file:line
 * list, including sites examined and found clear that are NOT re-listed as
 * scan targets here — e.g. resources/migrations/source-fields.ts, which
 * legitimately hashes Memory rows but structurally excludes `embedding`/
 * `embeddingModel` from MEMORY_SOURCE_FIELDS, so scanning it for
 * `createHash` would be a guaranteed permanent false positive on code that
 * is already correct by construction, not a decision site this guard needs
 * to watch).
 *
 *   1. resources/migrations/embedding-stamp.ts (WHOLE FILE) — the
 *      boot-keyed auto-migration that decides which Memory rows are stale
 *      (`staleCondition()`) and triggers their re-embed (`run()`). This is
 *      THE re-embed-detection gate flair#749 is about.
 *   2. resources/health.ts, SCOPED to the memory + agent embedding-model
 *      diagnostics (the "Memory stats" through "Agent stats" sections:
 *      modelCounts/hashFallback/"multiple embedding models" reporting) —
 *      the operator-facing surface that tells someone their corpus has
 *      mixed vector spaces. Scoped (not whole-file) because health.ts also
 *      covers unrelated stats (Relationships, Soul, migrations) with no
 *      embedding-identity logic to false-positive on.
 *   3. src/cli.ts, SCOPED to the `reembed` command's action body — `flair
 *      reembed --stale-only`'s CLI-side staleness decision. A SEPARATE
 *      build target from resources/**.ts (see that command's own comment:
 *      tsconfig.cli.json can't reach resources/), so it duplicates
 *      getModelId()'s gate-then-suffix logic as literals — a second place
 *      this invariant must hold independently.
 *   4. resources/Memory.ts:findConservativeDedupMatch — computes
 *      cosineSimilarity against a candidate's stored embedding. Not
 *      currently a violation (cosineSimilarity is the correct pattern — see
 *      above), but this is the one place flair compares two embedding
 *      vectors directly, so it is the highest-value place to guard against
 *      a FUTURE edit sliding from "cosine threshold" toward "hash and
 *      compare" or "===".
 *   5. resources/Memory.ts:runDedupGate — wraps
 *      findConservativeDedupMatch for the create-shaped write path and
 *      stamps `embeddingModel = getModelId()`; scanned for the same reason.
 *
 * ─── CodeQL js/regex-injection note ────────────────────────────────────────
 * Every regex below is a STATIC LITERAL used only for comment-stripping.
 * Token matching itself is plain `String.prototype.includes()` — never a
 * dynamically-constructed `RegExp`.
 *
 * ─── If this test fails ────────────────────────────────────────────────────
 * A scanned embedding-decision module now hashes, exact-compares, or
 * serializes-for-comparison a raw embedding/vector. If this is a genuine
 * diagnostic/logging path, move it out of the scanned region. If it is an
 * actual identity/staleness decision, that is exactly the bug flair#749
 * exists to catch: ggml accumulation order is not stable across platform
 * binary, `threads`, or `batchSize` (hfe#10's probe; hfe#17's reproducibility
 * contract documents bit-stability as SAME-environment-only), so a
 * cross-environment vector-byte or vector-hash comparison WILL false-positive
 * on ordinary float noise. Use the `embeddingModel` metadata stamp (or, for
 * a genuine similarity signal, `cosineSimilarity()` with a real threshold —
 * never strict equality) instead. See flair#749 and hfe#17.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Plain-string tokens indicating a raw vector was hashed, exact-compared, or
 * serialized-for-comparison. See file header's "What is (and isn't) a
 * violation" for the boundary reasoning (why these do NOT match
 * `embeddingModel === `/`JSON.stringify(embeddingModel)`).
 */
const VECTOR_IDENTITY_VIOLATION_TOKENS = [
  // Hashing anything at all — none of the scoped regions below have a
  // legitimate reason to hash (confirmed by reading each in full for this
  // PR's audit). If a hash call ever appears here, it is almost certainly a
  // vector-byte-hash identity shortcut, exactly what flair#749 warns against.
  "createHash(",
  ".digest(",
  // Strict/loose equality on a raw vector array (never meaningful in JS for
  // array-valued identity anyway — always false unless same reference — so
  // this is also a correctness smell independent of flair#749). Spaced so
  // `embeddingModel === ` / `embeddingModel !== ` never match (`embedding`
  // is immediately followed by `Model`, not a space, in that identifier).
  "embedding ===",
  "embedding !==",
  ".embedding ===",
  ".embedding !==",
  "vector ===",
  "vector !==",
  // Serialize-then-compare (or serialize-then-hash) a raw vector. Closed
  // with `)` or `,` so `JSON.stringify(embeddingModel)` never matches
  // (`embedding` is immediately followed by `Model`, not `)`/`,`, there).
  "JSON.stringify(embedding)",
  "JSON.stringify(embedding,",
  "JSON.stringify(vector)",
  "JSON.stringify(vector,",
] as const;

/**
 * Blank out comment CONTENT (replace non-newline characters with spaces) so
 * doc comments referencing these tokens in prose (this file's own header,
 * and the scanned files' own headers, which discuss flair#749 by name)
 * don't trip the scan — while every surviving character keeps its original
 * line number, so failure messages report real, clickable "file:line"
 * locations. Static regex literals only (see file header's CodeQL note).
 */
function stripComments(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  return out;
}

interface Offense {
  line: number;
  token: string;
  excerpt: string;
}

/** Scan (comment-stripped) `text`, whose first line is `startLine` in the
 *  real file, for every VECTOR_IDENTITY_VIOLATION_TOKENS occurrence. */
function findOffenses(text: string, startLine: number): Offense[] {
  const strippedLines = stripComments(text).split("\n");
  const rawLines = text.split("\n");
  const offenses: Offense[] = [];
  for (let i = 0; i < strippedLines.length; i++) {
    for (const token of VECTOR_IDENTITY_VIOLATION_TOKENS) {
      if (strippedLines[i].includes(token)) {
        offenses.push({ line: startLine + i, token, excerpt: (rawLines[i] ?? "").trim() });
      }
    }
  }
  return offenses;
}

/** Whole-file region. */
const wholeFile = (src: string) => ({ text: src, startLine: 1 });

/**
 * Extract the text between two literal markers (inclusive of `startMarker`,
 * exclusive of `endMarker`) — used for health.ts, whose embedding-diagnostics
 * code lives inline in a class method rather than a standalone named
 * function. Throws loudly if a marker has moved, so a refactor can't
 * silently narrow (or disarm) this guard — fix the marker, don't delete the
 * check.
 */
function extractBetweenMarkers(src: string, startMarker: string, endMarker: string, file: string) {
  const start = src.indexOf(startMarker);
  if (start === -1) {
    throw new Error(
      `embedding-identity-tripwire: expected to find ${JSON.stringify(startMarker)} in ${file} — ` +
        `has the embedding-diagnostics section been renamed or moved? Update this test's extraction ` +
        `target to match; do not delete the check (flair#749).`,
    );
  }
  const end = src.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error(
      `embedding-identity-tripwire: expected to find ${JSON.stringify(endMarker)} after ${JSON.stringify(startMarker)} in ${file} — ` +
        `has the section boundary moved? Update this test's extraction target to match; do not delete ` +
        `the check (flair#749).`,
    );
  }
  const startLine = src.slice(0, start).split("\n").length;
  return { text: src.slice(start, end), startLine };
}

/**
 * Extract one top-level `function <fnName>(` declaration's full body from
 * `src` via brace-matching (naive character-count, no string/template-
 * literal awareness — sufficient for the two specific functions this test
 * extracts). Matches `async function findConservativeDedupMatch(` /
 * `async function runDedupGate(`'s shape (`function ${fnName}(` is a
 * substring of both). Throws loudly if the function has been renamed or
 * moved (same discipline as claimed-zero-authority-tripwire.test.ts's
 * identical helper).
 */
function extractFunctionBody(src: string, fnName: string, file: string) {
  const marker = `function ${fnName}(`;
  const start = src.indexOf(marker);
  if (start === -1) {
    throw new Error(
      `embedding-identity-tripwire: expected to find "${marker}" in ${file} — has this function been ` +
        `renamed or moved? Update this test's extraction target to match; do not delete the check (flair#749).`,
    );
  }
  const braceStart = src.indexOf("{", start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const startLine = src.slice(0, start).split("\n").length;
  return { text: src.slice(start, i), startLine };
}

/**
 * Extract a `.command("<name>")` chain's `.action(async (opts) => { ... })`
 * body via brace-matching from the first `{` after the marker's next
 * `.action(async (opts) => {`. Used for src/cli.ts's `reembed` command,
 * which is an inline arrow function (no `function name(` to anchor on).
 */
function extractCommandActionBody(src: string, commandName: string, file: string) {
  const commandMarker = `.command("${commandName}")`;
  const commandStart = src.indexOf(commandMarker);
  if (commandStart === -1) {
    throw new Error(
      `embedding-identity-tripwire: expected to find ${JSON.stringify(commandMarker)} in ${file} — ` +
        `has this command been renamed or moved? Update this test's extraction target to match; do not ` +
        `delete the check (flair#749).`,
    );
  }
  const actionMarker = ".action(async (opts) => {";
  const actionStart = src.indexOf(actionMarker, commandStart);
  if (actionStart === -1) {
    throw new Error(
      `embedding-identity-tripwire: expected to find ${JSON.stringify(actionMarker)} after ${JSON.stringify(commandMarker)} ` +
        `in ${file} — has the action handler's shape changed? Update this test's extraction target to match; ` +
        `do not delete the check (flair#749).`,
    );
  }
  const braceStart = actionStart + actionMarker.length - 1; // the `{` itself
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const startLine = src.slice(0, actionStart).split("\n").length;
  return { text: src.slice(actionStart, i), startLine };
}

interface ScanTarget {
  /** Repo-relative path, used both to load the file and in messages. */
  file: string;
  /** Human label identifying the specific region scanned within the file. */
  label: string;
  /** One-line justification: why this is an embedding-identity decision site. */
  why: string;
  /** Extracts the region to scan (whole file, or a narrower slice). */
  extract: (src: string, file: string) => { text: string; startLine: number };
}

const SCAN_TARGETS: ScanTarget[] = [
  {
    file: "resources/migrations/embedding-stamp.ts",
    label: "embedding-stamp.ts (whole file)",
    why: "the boot-keyed auto-migration that decides which Memory rows are stale (staleCondition/detect/countPending) and triggers their re-embed (run) — THE re-embed-detection gate flair#749 is about",
    extract: (src) => wholeFile(src),
  },
  {
    file: "resources/health.ts",
    label: "health.ts (Memory stats through Agent stats)",
    why: "operator-facing embedding-model-mix / hash-fallback diagnostics (modelCounts, hashFallback, \"multiple embedding models\" warning) — reports embedding identity health",
    extract: (src, file) => extractBetweenMarkers(src, "// ── Memory stats ──", "// ── Relationships ──", file),
  },
  {
    file: "src/cli.ts",
    label: "cli.ts:reembed action body",
    why: "flair reembed --stale-only's CLI-side staleness decision — a separate build target that duplicates getModelId()'s gate-then-suffix logic as literals (must never drift from resources/embeddings-provider.ts's getModelId())",
    extract: (src, file) => extractCommandActionBody(src, "reembed", file),
  },
  {
    file: "resources/Memory.ts",
    label: "Memory.ts:findConservativeDedupMatch",
    why: "the one place flair directly compares two embedding vectors (cosineSimilarity against a candidate's stored embedding) — highest-value guard against a future slide from cosine-threshold toward hash/exact-equality",
    extract: (src, file) => extractFunctionBody(src, "findConservativeDedupMatch", file),
  },
  {
    file: "resources/Memory.ts",
    label: "Memory.ts:runDedupGate",
    why: "wraps findConservativeDedupMatch for the create-shaped write path and stamps embeddingModel = getModelId()",
    extract: (src, file) => extractFunctionBody(src, "runDedupGate", file),
  },
];

describe("embedding-identity tripwire (flair#749)", () => {
  it.each(SCAN_TARGETS)("$label never hashes/exact-compares/serializes a raw embedding vector", ({ file, label, why, extract }) => {
    const src = readFileSync(join(REPO_ROOT, file), "utf8");
    const { text, startLine } = extract(src, file);
    const offenses = findOffenses(text, startLine);
    expect(
      offenses,
      offenses
        .map(
          (o) =>
            `${file}:${o.line} — token "${o.token}" found in ${label} (${why}): ${JSON.stringify(o.excerpt)}. ` +
            `Embedding identity/staleness decisions must ride on METADATA (embeddingModel string, model file ` +
            `hash, backend version, template config) — never vector bytes or a hash of vector bytes compared ` +
            `across environments. ggml accumulation order is not stable across platform binary/threads/batchSize ` +
            `(hfe#10's probe; hfe#17's reproducibility contract is same-environment-only), so a vector-byte or ` +
            `vector-hash comparison WILL false-positive on ordinary cross-environment float noise. See flair#749.`,
        )
        .join("\n"),
    ).toEqual([]);
  });

  it("SCAN_TARGETS covers every module this PR's flair#749 audit identified as an embedding-identity decision site", () => {
    const files = new Set(SCAN_TARGETS.map((t) => t.file));
    expect(files).toEqual(
      new Set([
        "resources/migrations/embedding-stamp.ts",
        "resources/health.ts",
        "src/cli.ts",
        "resources/Memory.ts",
      ]),
    );
  });

  it("sanity: existing metadata comparisons do not trip the scanner (token-boundary check)", () => {
    // Mirrors real code shipped today (embedding-stamp.ts / health.ts /
    // cli.ts's reembed command) — `embeddingModel === `/`!== ` and
    // `JSON.stringify(embeddingModel)` are the CORRECT, encouraged pattern
    // and must never be flagged. See the file header's "What is (and isn't)
    // a violation" section for the character-boundary reasoning.
    const legitimate = [
      "if (existing.embeddingModel === current) continue;",
      "if (staleOnly && m.embeddingModel === currentModel) continue;",
      "if (!m.embeddingModel || m.embeddingModel === \"hash-512d\") row.hashFallback++;",
      "console.log(JSON.stringify({ embeddingModel: m.embeddingModel }));",
    ].join("\n");
    expect(findOffenses(legitimate, 1)).toEqual([]);
  });
});
