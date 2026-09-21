#!/usr/bin/env node
// flair#1776 slice 3 — verdict-diff review artifact.
//
// Reads a JSON array of `{ id, claim }` objects from the file path given as the
// first argument, runs the OLD structural-truncation detector (the ASCII-only
// table, copied VERBATIM from origin/main below and labelled as such) and the
// NEW one (imported from its single definition in src/rem/promote-policy.ts),
// and reports which candidates change verdict — refusals ADDED and refusals
// REMOVED, each with the candidate id and the detector's diagnostic — plus
// totals.
//
// The delta IS the review artifact for the widening. A single rate can hide a
// systematic false-positive class in one script; the per-candidate diff cannot.
// A refusal here means "no detected imbalance": the candidate is left pending
// (reviewer load), never dropped.
//
// This starts no Harper process and touches no live data — it is a pure
// function over the JSON you hand it.
//
// Run with: bun scripts/rem-verdict-diff.mjs <candidates.json>
//
// Input shape (one object per candidate):
//   [{ "id": "cand_123", "claim": "..." }, ...]
// A row without a string `claim` is counted as skipped, never silently dropped.

import { readFileSync } from "node:fs";

// -- OLD detector -------------------------------------------------------------
// Copied VERBATIM from origin/main (017d99b, src/rem/promote-policy.ts). The
// function body is unchanged; only the identifier carries an `Old` suffix and
// the TypeScript type annotation is dropped so this file runs as plain JS.
const STRUCTURAL_CLOSERS_OLD = { ")": "(", "]": "[", "}": "{" };
function structuralImbalanceOld(claim) {
  const stack = [];
  for (const ch of claim) {
    if (ch === "(" || ch === "[" || ch === "{") {
      stack.push(ch);
    } else if (ch in STRUCTURAL_CLOSERS_OLD) {
      if (stack.pop() !== STRUCTURAL_CLOSERS_OLD[ch]) return `unmatched '${ch}'`;
    }
  }
  if (stack.length > 0) return `unclosed '${stack[stack.length - 1]}'`;
  if (((claim.match(/`/g) ?? []).length) % 2 !== 0) return "unbalanced backtick";
  return null;
}

// -- NEW detector (imported, not re-implemented) ------------------------------
const newMod = await import(new URL("../src/rem/promote-policy.ts", import.meta.url).href);
const structuralImbalanceNew = newMod.structuralImbalance;

// -- input --------------------------------------------------------------------
const path = process.argv[2];
if (!path) {
  console.error("usage: bun scripts/rem-verdict-diff.mjs <candidates.json>");
  process.exit(2);
}
let rows;
try {
  rows = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  console.error(`${path}: could not read or parse as JSON: ${err.message}`);
  process.exit(2);
}
if (!Array.isArray(rows)) {
  console.error(`${path}: expected a JSON array of { id, claim } objects`);
  process.exit(2);
}

// -- diff ---------------------------------------------------------------------
let added = 0;
let removed = 0;
let unchanged = 0;
let skipped = 0;
const addedRows = [];
const removedRows = [];

rows.forEach((row, i) => {
  const id = row && row.id != null ? String(row.id) : `#${i}`;
  const claim = row && typeof row.claim === "string" ? row.claim : null;
  if (claim === null) {
    skipped++;
    return;
  }
  const oldDiag = structuralImbalanceOld(claim);
  const newDiag = structuralImbalanceNew(claim);
  const oldRefused = oldDiag !== null;
  const newRefused = newDiag !== null;
  if (oldRefused === newRefused) {
    unchanged++;
    return;
  }
  if (!oldRefused && newRefused) {
    added++;
    addedRows.push({ id, diag: newDiag, claim });
  } else {
    removed++;
    removedRows.push({ id, diag: oldDiag, claim });
  }
});

const preview = (s) => {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
};

console.log("# structural-truncation verdict diff (flair#1776 slice 3)");
console.log(`# input: ${path} — ${rows.length} rows (${skipped} skipped: no string claim)`);
console.log("");
console.log(`## refusals ADDED (promoted -> refused): ${added}`);
for (const r of addedRows) console.log(`  ${r.id}\t${r.diag}\t${preview(r.claim)}`);
console.log("");
console.log(`## refusals REMOVED (refused -> promoted): ${removed}`);
for (const r of removedRows) console.log(`  ${r.id}\t(old) ${r.diag}\t${preview(r.claim)}`);
console.log("");
console.log("## totals");
console.log(`  rows:             ${rows.length}`);
console.log(`  skipped:          ${skipped}`);
console.log(`  refusals added:   ${added}`);
console.log(`  refusals removed: ${removed}`);
console.log(`  unchanged:        ${unchanged}`);
