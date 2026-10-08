#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { LANE_SHARDS, ROOT } from "./lane-shards.mjs";

export function effectiveMatrix(matrix) {
  const axes = Object.entries(matrix).filter(([key, value]) => key !== "include" && key !== "exclude" && Array.isArray(value));
  const entries = value => Array.isArray(value) ? value : [];
  const matches = (combo, entry) => Object.entries(entry).every(([key, value]) => combo[key] === value);
  const originals = axes.length ? axes.reduce(
    (acc, [key, values]) => acc.flatMap(combo => values.map(value => ({ ...combo, [key]: value }))),
    [{}],
  ).filter(combo => !entries(matrix.exclude).some(entry => matches(combo, entry))) : [];
  const combos = originals.map(combo => ({ ...combo }));
  const added = [];
  // GitHub: original matrix values cannot be overwritten; added values can.
  // https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#jobsjob_idstrategymatrixinclude
  for (const entry of entries(matrix.include)) {
    let merged = false;
    originals.forEach((original, index) => {
      if (Object.keys(entry).some(key => key in original && original[key] !== entry[key])) return;
      Object.assign(combos[index], entry);
      merged = true;
    });
    if (!merged) added.push({ ...entry });
  }
  return [...combos, ...added];
}

export function shardValues(matrix) {
  return [...new Set(effectiveMatrix(matrix).flatMap(combo => combo.shard === undefined ? [] : [Number(combo.shard)]))].sort((a, b) => a - b);
}

export function verifyWorkflowMatrix(text) {
  const doc = load(text);
  const matrix = doc.jobs["test-unit"].strategy.matrix;
  const present = new Set(shardValues(matrix));
  const missing = Array.from({ length: LANE_SHARDS }, (_, i) => i + 1).filter(shard => !present.has(shard));
  if (missing.length) throw new Error(`missing lane shards: ${missing.join(", ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error("expected at most one workflow path");
    verifyWorkflowMatrix(readFileSync(process.argv[2] || resolve(ROOT, ".github/workflows/test.yml"), "utf8"));
    console.log("Lane matrix covers all required shard indices.");
  } catch (error) {
    console.error(`lane matrix: ${error.message}`);
    process.exitCode = 1;
  }
}
