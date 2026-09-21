#!/usr/bin/env node
/**
 * registry-latest-skew.mjs — refuse to leave the lockstep set skewed on `latest`
 * (flair#1781).
 *
 * Reads `dist-tags.latest` for EVERY lockstep package (lockstep-packages.mjs) and
 * exits non-zero naming the packages that disagree. Two modes:
 *
 *   - no argument — skew is "the packages do not all agree on one `latest`".
 *     This is the PRE-promote check: the canary runs it before the verdict so a
 *     pre-existing skew (a prior partial promote, or an older flow) is visible;
 *     the all-or-none promote below is what resolves it.
 *   - `<expected-version>` — skew is "any package's `latest` != expected". This is
 *     the POST-promote check the operator runs after pasting the promote block.
 *
 * Usage:
 *   node scripts/ci/registry-latest-skew.mjs [expected-version]
 *
 * Exit codes:
 *   0 — the set agrees
 *   1 — skew (the offender packages are named on stderr)
 *   2 — DID NOT RUN (a `latest` could not be read, or no packages found) — an
 *       unmeasurable check is never green
 */
import { execFileSync } from "node:child_process";
import { lockstepPackages } from "./lockstep-packages.mjs";

const expected = process.argv[2] ?? "";
if (expected && !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(expected)) {
  console.error(`usage: node scripts/ci/registry-latest-skew.mjs [expected-version] (got '${expected}')`);
  process.exit(2);
}

const packages = lockstepPackages();
if (packages.length === 0) {
  console.error("registry-latest-skew: DID NOT RUN — no lockstep packages found");
  process.exit(2);
}

function readLatest(pkg) {
  try {
    const raw = execFileSync("npm", ["view", pkg, "dist-tags.latest"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // `npm view <pkg> dist-tags.latest` prints the bare version; tolerate quotes.
    const value = raw.replace(/^"(.*)"$/, "$1").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

const latest = new Map();
const unreadable = [];
for (const pkg of packages) {
  const v = readLatest(pkg);
  if (v === null) unreadable.push(pkg);
  else latest.set(pkg, v);
}
if (unreadable.length > 0) {
  console.error(`registry-latest-skew: DID NOT RUN — could not read dist-tags.latest for: ${unreadable.join(", ")}`);
  process.exit(2);
}

if (expected) {
  const offenders = packages.filter((p) => latest.get(p) !== expected);
  if (offenders.length === 0) {
    console.log(`✓ all ${packages.length} lockstep packages are at latest ${expected}`);
    process.exit(0);
  }
  console.error(`✗ lockstep latest skew — expected ${expected}:`);
  for (const p of offenders) console.error(`   ${p}: latest ${latest.get(p)}`);
  process.exit(1);
}

const values = new Set(packages.map((p) => latest.get(p)));
if (values.size === 1) {
  console.log(`✓ all ${packages.length} lockstep packages agree on latest ${[...values][0]}`);
  process.exit(0);
}

// Name the minority: whichever `latest` the most packages share is the value to
// converge on; the rest are the offenders.
const counts = new Map();
for (const p of packages) counts.set(latest.get(p), (counts.get(latest.get(p)) ?? 0) + 1);
let modal = null;
let best = -1;
for (const [v, c] of counts) if (c > best) { best = c; modal = v; }
const offenders = packages.filter((p) => latest.get(p) !== modal);
console.error(`✗ lockstep latest skew — ${packages.length - offenders.length}/${packages.length} are at ${modal}; these differ:`);
for (const p of offenders) console.error(`   ${p}: latest ${latest.get(p)} (expected ${modal})`);
process.exit(1);
