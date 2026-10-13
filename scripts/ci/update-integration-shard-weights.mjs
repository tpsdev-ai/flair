#!/usr/bin/env node
// Regenerate scripts/ci/integration-shard-weights.json from CI job logs.
//
// The weights that steer integration-shards.mjs come from measured CI runs, not
// guesses. Each input is a job log for an `Integration Tests (shard N/M)` job —
// the `actions/jobs/<id>/logs` REST endpoint, or the per-job text file in the
// run's logs archive. bun prints one `##[group]<file>` … `##[endgroup]` block
// per integration file; this reads the wall time of each block.
//
// Per file the script keeps the MAX within a job (a mutation step can re-run a
// file) and the MEDIAN across jobs, then writes the file → seconds map sorted by
// path. A file that appears in no log is left out and falls back to
// DEFAULT_WEIGHT in integration-shards.mjs.
//
// USAGE
//   node scripts/ci/update-integration-shard-weights.mjs <job-log> [<job-log> ...]
//   node scripts/ci/update-integration-shard-weights.mjs --out <path> <job-log> ...
//   With no log paths, reads one log path per line from stdin.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listIntegrationFiles, WEIGHTS_FILE } from "./integration-shards.mjs";

/** Per-file MAX wall seconds within one job log. */
export function parseJobLog(text) {
  const perFile = {};
  let cur = null;
  let startTs = 0;
  for (const raw of text.split("\n")) {
    // Each line is `<timestamp> <body>`. The first line of a log may carry a
    // UTF-8 BOM, and a log export may prefix lines with a `<job>\t<step>\t`
    // tag; strip both before reading the timestamp.
    const m = raw
      .replace(/^\uFEFF/, "")
      .match(/^(?:[^\t]*\t[^\t]*\t)?(\S+?Z)\s(.*)$/);
    if (!m) continue;
    const body = m[2];
    const g = body.match(/^##\[group\](\S+\.test\.ts):\s*$/);
    if (g) {
      cur = g[1];
      startTs = Date.parse(m[1]);
      continue;
    }
    if (cur && body === "##[endgroup]") {
      const secs = (Date.parse(m[1]) - startTs) / 1000;
      if (Number.isFinite(secs) && secs >= 0) {
        perFile[cur] = Math.max(perFile[cur] ?? 0, secs);
      }
      cur = null;
    }
  }
  return perFile;
}

/** Median of the per-job maxima, rounded to whole seconds (min 1), for `keep`. */
export function aggregate(logs, keep) {
  const perFile = {};
  for (const text of logs) {
    for (const [file, secs] of Object.entries(parseJobLog(text))) {
      if (keep && !keep.has(file)) continue;
      (perFile[file] ??= []).push(secs);
    }
  }
  const out = {};
  for (const [file, arr] of Object.entries(perFile)) {
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    out[file] = Math.max(1, Math.round(median));
  }
  return out;
}

function usage(msg) {
  process.stderr.write(
    `update-integration-shard-weights: ${msg}\n` +
      "Usage: node scripts/ci/update-integration-shard-weights.mjs " +
      "[--out <path>] <job-log> [<job-log> ...]\n",
  );
  process.exit(2);
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
  let out = WEIGHTS_FILE;
  const logs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") {
      if (i + 1 >= args.length) usage("--out needs a path");
      out = args[++i];
    } else if (args[i].startsWith("-")) {
      usage(`unknown flag ${args[i]}`);
    } else {
      logs.push(args[i]);
    }
  }
  const paths = logs.length
    ? logs
    : readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!paths.length) usage("no job-log paths given");
  const texts = paths.map((p) => {
    try {
      return readFileSync(p, "utf8");
    } catch (err) {
      process.stderr.write(`update-integration-shard-weights: cannot read ${p}: ${err.message}\n`);
      process.exit(1);
    }
  });
  const keep = new Set(listIntegrationFiles());
  const weights = aggregate(texts, keep);
  if (Object.keys(weights).length === 0) {
    process.stderr.write(
      "update-integration-shard-weights: no per-file timings found in the given " +
        "logs (no `##[group]<file>.test.ts:` blocks); refusing to write an empty " +
        "weights table\n",
    );
    process.exit(1);
  }
  const sorted = {};
  for (const k of Object.keys(weights).sort()) sorted[k] = weights[k];
  writeFileSync(out, `${JSON.stringify(sorted, null, 2)}\n`);
  const files = Object.keys(sorted).length;
  const sum = Object.values(sorted).reduce((a, b) => a + b, 0);
  process.stdout.write(
    `wrote ${files} weights to ${out} (total ${sum}s = ${(sum / 60).toFixed(1)}min)\n`,
  );
}
