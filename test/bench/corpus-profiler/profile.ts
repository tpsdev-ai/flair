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
const records = includeArchived ? all : all.filter((r) => r.archived !== true);

const profile = computeProfile(records, {
  clusterCount: flag("clusters") ? Number(flag("clusters")) : undefined,
  seed: flag("seed") ? Number(flag("seed")) : undefined,
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
