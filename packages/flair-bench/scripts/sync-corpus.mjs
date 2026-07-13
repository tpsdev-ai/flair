#!/usr/bin/env node
/**
 * sync-corpus.mjs — regenerate src/corpus-v2.ts from the flair recall-eval
 * harness's own instrument (test/bench/recall-harness/corpus-v2.ts).
 *
 * flair-bench ships standalone (no monorepo checkout at runtime), so it
 * carries a build-time COPY of the harness corpus rather than importing it
 * live (see src/corpus-v2.ts's header). This script re-copies the harness
 * source's body (everything after its own header comment) under a fixed
 * provenance header, so the committed copy stays a mechanical sync rather
 * than a hand-maintained fork. test/corpus-sync.test.ts is the actual gate
 * (deep-equal check against the harness source, run on every `bun test`
 * inside the monorepo) — this script is what you run to fix a drift it
 * flags.
 *
 * Usage: node scripts/sync-corpus.mjs   (run from packages/flair-bench/)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(PKG_ROOT, "..", "..");
const SOURCE = join(REPO_ROOT, "test", "bench", "recall-harness", "corpus-v2.ts");
const DEST = join(PKG_ROOT, "src", "corpus-v2.ts");

const source = readFileSync(SOURCE, "utf8");
// Source's own header is the first /** ... */ block — strip it, we splice in
// our own provenance header (below) followed by the ORIGINAL header text
// (kept verbatim for context) then the rest of the file untouched.
const headerEnd = source.indexOf("*/");
if (headerEnd === -1) {
  console.error(`FATAL: ${SOURCE} has no leading /** */ header block to splice against.`);
  process.exit(1);
}
const originalHeaderBody = source.slice(0, headerEnd).replace(/^\/\*\*\n/, "");
const rest = source.slice(headerEnd); // starts with the closing "*/"

const provenance = `/**
 * corpus-v2.ts — SYNCED COPY of test/bench/recall-harness/corpus-v2.ts
 * (the flair recall-eval harness's eval instrument v2).
 *
 * flair-bench ships standalone (npx-able, no monorepo checkout required at
 * runtime), so it cannot import the harness's corpus at runtime from
 * test/bench/ — that directory is dev-only and excluded from the published
 * package. This file is a build-time copy kept faithful by
 * test/corpus-sync.test.ts, which deep-equals this file's exported CORPUS
 * and QUERIES against the live harness source on every \`bun test\` run
 * inside the monorepo checkout — any drift fails CI loudly. Regenerate with
 * \`bun run sync:corpus\` (packages/flair-bench/scripts/sync-corpus.mjs)
 * whenever the harness corpus changes.
 *
 * Below this header, content is byte-for-byte the harness's corpus-v2.ts —
 * see that file for the full design rationale (near-duplicate clusters,
 * cross-cluster lexical traps, durability/recency stress pairs).
 *
 * ORIGINAL HEADER (test/bench/recall-harness/corpus-v2.ts):
 *
 * ${originalHeaderBody}`;

writeFileSync(DEST, provenance + rest, "utf8");
console.log(`Synced ${DEST} from ${SOURCE}`);
