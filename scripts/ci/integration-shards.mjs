#!/usr/bin/env node
// Integration-test shards (flair#2149, #2131).
//
// PROBLEM. The `Integration Tests` job ran ~24 min against a 30-minute cap and
// was sometimes cancelled mid-pass, blocking merges. The fix is to shard the
// suite across parallel jobs.
//
// FIX. This script partitions `test/integration/**/*.test.ts` into N shards,
// deterministically: every file lands in exactly one shard, and the union of the
// shards is the full file list. The heavy files are spread using checked-in
// weights measured from CI (SECONDS_BY_FILE); a file with no weight is assigned
// the default weight and still lands in a shard.
//
// The job that runs a shard asks this script for its files:
//   bun test $(node scripts/ci/integration-shards.mjs --shard 2 --of 3)
//
// USAGE
//   node scripts/ci/integration-shards.mjs --list-all
//                                            every file, sorted (one per line)
//   node scripts/ci/integration-shards.mjs --shard <i> --of <N>
//                                            shard i's files (1-based), sorted
//   node scripts/ci/integration-shards.mjs --verify --of <N>
//                                            coverage gate: exit non-zero unless
//                                            the shards partition the full list
//   Every command refuses an argument it does not take, with exit status 2.

import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const INTEGRATION_DIR = join(ROOT, "test", "integration");

/**
 * Seconds measured per file in the CI run cited by flair#2149 (2026-10-01,
 * PR #2148). Only the files that dominated that run are listed; every other file
 * gets DEFAULT_WEIGHT. The weights only steer the assignment — they are never a
 * pass/fail threshold.
 */
export const SECONDS_BY_FILE = {
  "table-subscription-default-deny.test.ts": 125,
  "migrations-provisioned-datadir.test.ts": 98,
  "presence-read-gate.test.ts": 51,
  "federation-instance-create-race-1897.test.ts": 38,
  "oauth-rate-limit-e2e.test.ts": 37,
  "patch-updates-existing-rows.test.ts": 36,
  "replay-store-two-workers-2061.test.ts": 32,
};
export const DEFAULT_WEIGHT = 1;

/** Every `*.test.ts` under `dir`, recursively, as paths relative to ROOT, sorted. */
export function listIntegrationFiles(dir = INTEGRATION_DIR) {
  const found = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        found.push(full.slice(ROOT.length + 1));
      }
    }
  };
  walk(dir);
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
export function shardFiles(index, of, files = listIntegrationFiles()) {
  if (!Number.isInteger(of) || of < 1) throw new Error(`--of must be a positive integer, got ${of}`);
  if (!Number.isInteger(index) || index < 1 || index > of) {
    throw new Error(`--shard must be 1..${of}, got ${index}`);
  }
  return assignShards(files, of)[index - 1];
}

/**
 * Coverage gate: exit non-zero unless the shards partition the full list — the
 * union equals every file, and no file appears in two shards. A file missing
 * from the union means it would run in NO shard, which check must catch.
 */
export function verifyShards(of, files = listIntegrationFiles()) {
  const all = new Set(files);
  const seen = new Set();
  const duplicated = [];
  for (let i = 1; i <= of; i++) {
    for (const file of shardFiles(i, of, files)) {
      if (seen.has(file)) duplicated.push(file);
      seen.add(file);
    }
  }
  const missing = [...all].filter((f) => !seen.has(f));
  const unknown = [...seen].filter((f) => !all.has(f));
  return { total: all.size, covered: seen.size, missing, duplicated, unknown };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function usageError(msg) {
  process.stderr.write(
    `integration-shards: ${msg}\nUsage: node scripts/ci/integration-shards.mjs ` +
      `--list-all | --shard <i> --of <N> | --verify --of <N>\n`,
  );
  process.exit(2);
}

function parseOf(args) {
  const values = args.filter((a) => a === "--of");
  if (values.length !== 1) usageError(`--of must be given exactly once`);
  const at = args.indexOf("--of");
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
      process.stdout.write(`${listIntegrationFiles().join("\n")}\n`);
    } else if (args.includes("--verify")) {
      const rest = args.filter((a) => a !== "--verify");
      const of = parseOf(rest);
      if (rest.length !== 2) usageError(`--verify takes only --of <N>`);
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
      if (rest.length !== 2) usageError(`--shard takes only --of <N>`);
      process.stdout.write(`${shardFiles(index, of).join("\n")}\n`);
    } else {
      usageError(`no command given`);
    }
  } catch (err) {
    process.stderr.write(`integration-shards: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}
