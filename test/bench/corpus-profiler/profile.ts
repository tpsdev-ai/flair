#!/usr/bin/env bun
// ─── corpus-profiler CLI ────────────────────────────────────────────────────
//
// Measures the structure of a REAL memory corpus and emits distributions only.
// Stage 1a of flair#893: measure the difficulty here, generate the text
// elsewhere.
//
//   bun run test/bench/corpus-profiler/profile.ts                    # to stdout
//   bun run test/bench/corpus-profiler/profile.ts --out PROFILE.json
//   bun run test/bench/corpus-profiler/profile.ts --include-archived
//   bun run test/bench/corpus-profiler/profile.ts --owner <agentId>
//
// Flags:
//   --url <base>            default http://127.0.0.1:9926
//   --agent-id <id>         signing identity; default $FLAIR_AGENT_ID or "flint"
//   --key <path>            default ~/.tps/secrets/flair/<agent-id>-priv.key
//   --owner <agentId>       restrict to one owner; default = full read scope
//   --include-archived      profile ALL rows, not just the retrievable ones
//   --clusters <k>          k for k-means; default round(sqrt(n/2)) in [4,64]
//   --seed <n>              PRNG seed; default 20260728
//   --sample-size <n>       deterministically subsample to n records, so a
//                           like-for-like comparison against a smaller corpus
//                           is reproducible rather than size-inflated
//   --out <path>            write JSON here; default stdout
//
// READ-ONLY against the live instance. It issues exactly one GET; see
// ./fetch.ts for why it does not go through SemanticSearch.
//
// The output is passed through ./guard.ts before it is written or printed, so
// a leak fails the RUN rather than producing a file someone then commits.

import { writeFileSync } from "node:fs";
import { fetchCorpus } from "./fetch.ts";
import { computeProfile, type ProfileRecord } from "./compute.ts";
import { assertNumericOnly } from "./guard.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const agentId = flag("agent-id") ?? process.env.FLAIR_AGENT_ID ?? "flint";
const url = flag("url") ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
const privateKeyPath =
  flag("key") ?? process.env.FLAIR_PRIV_KEY ?? `${process.env.HOME}/.tps/secrets/flair/${agentId}-priv.key`;
const includeArchived = has("include-archived");

const t0 = Date.now();
const all: ProfileRecord[] = await fetchCorpus({ url, agentId, privateKeyPath, ownerAgentId: flag("owner") });

// Production SemanticSearch pushes `archived != true` (resources/SemanticSearch.ts),
// so archived rows are unreachable by any query. Profiling them by default
// would describe a corpus retrieval never sees — and since archived rows are
// often supersedes-chain predecessors, i.e. near-duplicates of the live row
// that replaced them, including them would INFLATE the near-duplicate density
// with pairs no query can ever confuse. Off by default; recorded in meta.scope
// either way so a profile always says which corpus it measured.
const inScope = includeArchived ? all : all.filter((r) => r.archived !== true);

const seed = flag("seed") ? Number(flag("seed")) : 20260728;

// Nearest-neighbour similarity rises with corpus size purely because there are
// more candidates to be close to, so comparing this profile against a smaller
// one (corpus-v2 is 251 records) would credit the live corpus with difficulty
// that is really just volume. --sample-size takes a deterministic subset so a
// like-for-like comparison is reproducible by anyone with an instance, rather
// than being a number only the person who ran it can verify.
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

const records = flag("sample-size") ? subsample(inScope, Number(flag("sample-size")), seed) : inScope;

const profile = computeProfile(records, {
  clusterCount: flag("clusters") ? Number(flag("clusters")) : undefined,
  seed,
  scope: includeArchived ? "all-records" : "retrievable",
  embeddingSource: "stored",
});

// Fail-closed. If anything content-bearing made it into the object, this
// throws before a byte is written.
assertNumericOnly(profile);

const json = JSON.stringify(profile, null, 2);
const out = flag("out");
if (out) {
  writeFileSync(out, json + "\n");
  // Counts only — never a sample of what was read.
  process.stderr.write(
    `profiled ${profile.scale.recordCount} records (${all.length} fetched, ` +
      `${all.length - records.length} excluded) in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${out}\n`,
  );
} else {
  process.stdout.write(json + "\n");
}
