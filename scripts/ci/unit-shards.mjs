#!/usr/bin/env node
// Root-unit-test shards (flair#2258).
//
// PROBLEM. Before this change the shared unit lane's `root unit tests` step ran
// the whole root unit corpus in one `bun test` invocation under a 450 s per-step
// limit, and on main it took 360–441 s across the Node 22/24/26 legs. Runner
// variance alone pushed some runs past the limit, and a per-step limit that is
// routinely approached stops meaning "hung". A step killed at the limit also
// left its scratch directories behind, so it tripped the temp-dir leak guard as
// a second, unrelated failure.
//
// FIX. This script partitions the root unit corpus into N shards,
// deterministically: every file lands in exactly one shard, and the union of the
// shards is the full file list. The heavy files are spread using checked-in
// weights measured per file (SECONDS_BY_FILE); a file with no weight is assigned
// the default weight and still lands in a shard.
//
// The CI job runs this module's coverage gate before the lane:
//   node scripts/ci/unit-shards.mjs --verify
//
// The lane itself imports the partition (it does not shell out):
// scripts/test-unit.ts calls assignShards() to build its shard steps.
//
// USAGE
//   node scripts/ci/unit-shards.mjs --list-all
//                                            every file, sorted (one per line)
//   node scripts/ci/unit-shards.mjs --shard <i> [--of <N>]
//                                            shard i's files (1-based), sorted
//   node scripts/ci/unit-shards.mjs --verify [--of <N>]
//                                            coverage gate: exit non-zero unless
//                                            the shards partition the full list
//   --of defaults to SHARDS. Every command refuses an argument it does not
//   take, with exit status 2.

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const ROOT_UNIT_DIR = join(ROOT, "test", "unit");
export const ROOT_TEST_DIR = join(ROOT, "test");

/** The number of shards the lane splits the root unit step into. */
export const SHARDS = 4;

/**
 * Seconds per file, measured in a local root-unit run cited by flair#2258
 * (2026-10-04). Only the files that dominated that run are listed; every other
 * file gets DEFAULT_WEIGHT. The weights only steer the assignment — they are
 * never a pass/fail threshold.
 */
export const SECONDS_BY_FILE = {
  "darwin-gated-visibility.test.ts": 45,
  "doctor-continuity-pins-1819.test.ts": 35,
  "action-recall-runtime-working.test.ts": 21,
  "harper-config-port.test.ts": 19,
  "init-pin-guard.test.ts": 17,
  "codex-wiring-strings-2027.test.ts": 17,
  "cli-v2.test.ts": 14,
  "principal-disable-remote-2114.test.ts": 13,
  "backup-server-count-2228.test.ts": 12,
  "backup-fail-closed-2214.test.ts": 10,
  "sandbox-home.test.ts": 10,
  "bm25-index-latency-1357.test.ts": 8,
  "doctor-embed-verify.test.ts": 8,
};
export const DEFAULT_WEIGHT = 1;

/** Every `*.test.ts` in `dir`, recursively when asked. Paths relative to `root`, sorted. */
function walk(dir, root, recursive) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) found.push(...walk(full, root, recursive));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      found.push(full.slice(root.length + 1));
    }
  }
  return found;
}

/**
 * The root unit corpus: every `test/unit/**` `*.test.ts` (recursive) plus every
 * `test/*.test.ts` (the root-level files the shared lane also runs). These are
 * the files the lane's `root unit tests` step covers, as paths relative to
 * `root`, sorted.
 */
export function listUnitFiles(root = ROOT) {
  const found = [];
  const unitDir = join(root, "test", "unit");
  const testDir = join(root, "test");
  if (existsSync(unitDir)) found.push(...walk(unitDir, root, true));
  if (existsSync(testDir)) found.push(...walk(testDir, root, false));
  return found.sort();
}

/** The weight a file contributes to its shard's load. */
export function weightOf(file) {
  return SECONDS_BY_FILE[basename(file)] ?? DEFAULT_WEIGHT;
}

/**
 * Assign `files` to `shards` shards, deterministically. Files are placed by
 * descending weight into the currently-lightest shard (ties by shard index).
 * Returns an array of `shards` arrays, each sorted.
 */
export function assignShards(files, shards) {
  if (!Number.isInteger(shards) || shards < 1) {
    throw new Error(`shard count must be a positive integer, got ${shards}`);
  }
  const ordered = [...files].sort(
    (a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : 1),
  );
  const buckets = Array.from({ length: shards }, () => []);
  const loads = Array.from({ length: shards }, () => 0);
  for (const file of ordered) {
    let lightest = 0;
    for (let i = 1; i < shards; i++) if (loads[i] < loads[lightest]) lightest = i;
    buckets[lightest].push(file);
    loads[lightest] += weightOf(file);
  }
  return buckets.map((b) => b.sort());
}

/** Shard `index` (1-based) of `of`. Throws when the index is out of range. */
export function shardFiles(index, of, files = listUnitFiles()) {
  if (!Number.isInteger(of) || of < 1) throw new Error(`--of must be a positive integer, got ${of}`);
  if (!Number.isInteger(index) || index < 1 || index > of) {
    throw new Error(`--shard must be 1..${of}, got ${index}`);
  }
  return assignShards(files, of)[index - 1];
}

/**
 * Coverage of a candidate shard assignment: which files the shards miss, which
 * they count twice, and which they name but the full list does not. `allFiles`
 * is the authoritative list; `shards` is an array of file arrays. A file in
 * `missing` would run in NO shard, which the check must catch; a file in
 * `duplicated` would run twice.
 */
export function coverageReport(allFiles, shards) {
  const all = new Set(allFiles);
  const seen = new Set();
  const duplicated = [];
  for (const shard of shards) {
    for (const file of shard) {
      if (seen.has(file)) duplicated.push(file);
      seen.add(file);
    }
  }
  const missing = [...all].filter((f) => !seen.has(f));
  const unknown = [...seen].filter((f) => !all.has(f));
  return { total: all.size, covered: seen.size, missing, duplicated, unknown };
}

/**
 * Coverage gate: exit non-zero unless the shards partition the full list — the
 * union equals every file, and no file appears in two shards.
 */
export function verifyShards(of, files = listUnitFiles()) {
  return coverageReport(files, assignShards(files, of));
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function usageError(msg) {
  process.stderr.write(
    `unit-shards: ${msg}\nUsage: node scripts/ci/unit-shards.mjs ` +
      `--list-all | --shard <i> [--of <N>] | --verify [--of <N>]\n`,
  );
  process.exit(2);
}

function parseOf(args) {
  const at = args.indexOf("--of");
  if (at === -1) return SHARDS;
  const value = Number(args[at + 1]);
  if (!Number.isInteger(value) || value < 1) usageError(`--of must be a positive integer`);
  return value;
}

const isEntryPoint =
  process.argv[1] &&
  (() => {
    try {
      return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
      return false;
    }
  })();
if (isEntryPoint) {
  const args = process.argv.slice(2);
  try {
    if (args.includes("--list-all")) {
      if (args.length !== 1) usageError(`--list-all takes no other arguments`);
      process.stdout.write(`${listUnitFiles().join("\n")}\n`);
    } else if (args.includes("--verify")) {
      const rest = args.filter((a) => a !== "--verify");
      const of = parseOf(rest);
      if (rest.length !== 0 && !(rest.length === 2 && rest[0] === "--of")) {
        usageError(`--verify takes only --of <N>`);
      }
      const res = verifyShards(of);
      const bad = res.missing.length || res.duplicated.length || res.unknown.length;
      process.stdout.write(
        `shards of ${of}: ${res.covered}/${res.total} files covered, ` +
          `${res.missing.length} missing, ${res.duplicated.length} duplicated\n`,
      );
      if (bad) {
        if (res.missing.length) process.stderr.write(`missing: ${res.missing.join(", ")}\n`);
        if (res.duplicated.length) process.stderr.write(`duplicated: ${res.duplicated.join(", ")}\n`);
        if (res.unknown.length) process.stderr.write(`unknown: ${res.unknown.join(", ")}\n`);
        process.exit(1);
      }
    } else if (args.includes("--shard")) {
      const at = args.indexOf("--shard");
      const index = Number(args[at + 1]);
      const rest = args.filter((a, i) => a !== "--shard" && i !== at + 1);
      const of = parseOf(rest);
      if (rest.length !== 0 && !(rest.length === 2 && rest[0] === "--of")) {
        usageError(`--shard takes only --of <N>`);
      }
      process.stdout.write(`${shardFiles(index, of).join("\n")}\n`);
    } else {
      usageError(`no command given`);
    }
  } catch (err) {
    process.stderr.write(`unit-shards: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}
