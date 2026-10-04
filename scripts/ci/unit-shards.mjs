#!/usr/bin/env node
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { testFiles } from "./test-files.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const ROOT_UNIT_DIR = join(ROOT, "test", "unit");
export const ROOT_TEST_DIR = join(ROOT, "test");

/** The number of shards the lane splits the root unit step into. */
export const SHARDS = 4;

export function listUnitFiles(root = ROOT) {
  const found = [];
  for (const [dir, recursive] of [["test", false], ["test/unit", true]]) {
    const files = testFiles(join(root, dir), recursive);
    if (!files.length) throw new Error(`No unit test files found in ${dir}`);
    found.push(...files.map(file => relative(root, file)));
  }
  return found.sort();
}

export function assignShards(files, shards) {
  if (!Number.isInteger(shards) || shards < 1) {
    throw new Error(`shard count must be a positive integer, got ${shards}`);
  }
  const buckets = Array.from({ length: shards }, () => []);
  for (const file of files) {
    const index = createHash("sha256").update(file).digest().readUInt32BE(0) % shards;
    buckets[index].push(file);
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
