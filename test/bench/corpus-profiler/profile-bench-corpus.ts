#!/usr/bin/env bun
// ─── profile the SYNTHETIC bench corpora through the same instrument ────────
//
// The live profile (./profile.ts) is a set of numbers with no referent until
// you can compare it to the corpus we currently measure recall against. This
// script produces that referent: it embeds corpus-v1/v2 with the SAME model
// and the SAME `inputType: 'document'` prefixing production uses, then runs
// the identical computeProfile() over the result.
//
// Same-instrument, same-space, so the two profiles are directly comparable.
// Embedding with anything else would measure a different geometry and the
// comparison would be arithmetic without meaning.
//
//   bun run test/bench/corpus-profiler/profile-bench-corpus.ts \
//     --models-dir /path/to/an/existing/flair/checkout/models \
//     --addon-path /path/to/@node-llama-cpp/<platform>/bins/<platform>/llama-addon.node \
//     --out test/bench/corpus-profiler/profiles/corpus-v2.json
//
// Flags:
//   --corpus v1|v2      which bench corpus; default v2 (the standing gate)
//   --models-dir <dir>  GGUF directory. Default <repo>/models, empty in a fresh
//                       worktree — point it at an existing install, read-only.
//                       Same convention as the recall harness's FLAIR_MODELS_DIR.
//   --addon-path <p>    llama-addon.node. Needed when the @node-llama-cpp
//                       platform package is not present in this worktree
//                       (it is an optional dependency and often is not).
//   --out <path>        write JSON here; default stdout
//   --sample-size <n>   profile a random subset — use it to match the live
//                       corpus's record count, since nearest-neighbour
//                       similarity rises with corpus size and an unmatched
//                       comparison overstates the difference.
//   --seed <n>          PRNG seed for the subsample and for computeProfile.
//
// No live instance, no Harper, no network beyond a model download you should
// avoid by passing --models-dir. Nothing here reads real memories.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { computeProfile, type ProfileRecord } from "./compute.ts";
import { assertNumericOnly } from "./guard.ts";
import * as CorpusV1 from "../recall-harness/corpus.ts";
import * as CorpusV2 from "../recall-harness/corpus-v2.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const which = flag("corpus") ?? "v2";
const corpus = which === "v1" ? CorpusV1.CORPUS : CorpusV2.CORPUS;
const seed = flag("seed") ? Number(flag("seed")) : 20260728;

// The real corpus is bigger, and nearest-neighbour similarity rises with n
// purely because there are more candidates to be close to. Comparing an
// unmatched pair would credit the live corpus with difficulty that is really
// just size, so --sample-size exists to control for it.
function subsample<T>(arr: T[], n: number, s: number): T[] {
  let a = s >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const c = arr.slice();
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c.slice(0, Math.min(n, c.length));
}

const sampleSize = flag("sample-size") ? Number(flag("sample-size")) : corpus.length;
const selected = subsample(corpus, sampleSize, seed);

const { EmbeddingEngine } = await import("harper-fabric-embeddings");
const engine = new EmbeddingEngine({
  // Mirrors resources/embeddings-boot.ts: same registry name, same pooling.
  modelName: "nomic-embed-text",
  modelsDir: flag("models-dir") ?? process.env.FLAIR_MODELS_DIR ?? path.join(repoRoot, "models"),
  pooling: "mean",
  ...(flag("addon-path") ? { addonPath: flag("addon-path") } : {}),
} as ConstructorParameters<typeof EmbeddingEngine>[0]);

await engine.ensureReady();
// `inputType: 'document'` is what makes these vectors comparable to stored
// ones: resources/embeddings-provider.ts ships with the search-prefix gate ON,
// so every stored memory vector carries the `search_document: ` template.
// Dropping it here would silently profile a different space.
const { vectors } = await engine.embedMany(selected.map((r) => r.text), { inputType: "document" });
await engine.dispose();

const now = Date.now();
const records: ProfileRecord[] = selected.map((r, i) => ({
  content: r.text,
  createdAt: new Date(now - r.ageDays * 86_400_000).toISOString(),
  agentId: "bench",
  embedding: Array.from(vectors[i]),
  embeddingModel: "nomic-embed-text-v1.5-Q4_K_M+searchprefix",
  durability: r.durability,
  tags: [],
  archived: false,
}));

const profile = computeProfile(records, { seed, scope: "retrievable", embeddingSource: "computed" });
assertNumericOnly(profile);

const json = JSON.stringify(profile, null, 2);
const out = flag("out");
if (out) {
  writeFileSync(out, json + "\n");
  process.stderr.write(`profiled bench corpus-${which}: ${profile.scale.recordCount} records -> ${out}\n`);
} else {
  process.stdout.write(json + "\n");
}
