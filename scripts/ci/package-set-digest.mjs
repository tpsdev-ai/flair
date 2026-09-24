#!/usr/bin/env node
/**
 * package-set-digest.mjs — the canonical package-set digest (flair#1671, slice
 * A1c). This is the SAME digest the release run's pack job records (A1a, #1877)
 * and prints in its run summary; the post-publish canary recomputes it from the
 * per-package tarball shas it verified and requires it to equal the dispatched
 * `package_set_digest` BEFORE any verdict.
 *
 * WHY IT MUST BYTE-MATCH THE PACK JOB. `.github/workflows/release-publish.yml`
 * builds one line `<name>@<version> <sha256>` per lockstep package, orders them by
 * byte value (`LC_ALL=C sort`), and sha256s the concatenation. A canary that
 * hashed the same set a different way would compute a different digest and refuse
 * an otherwise-correct release. So this file reproduces the pack job's canonical
 * form EXACTLY:
 *    - one line per package: `<name>@<version> <sha256>\n`;
 *    - ordered by raw byte value (equivalent to `LC_ALL=C sort`);
 *    - the digest is the sha256 of the concatenation (trailing newline included,
 *      as `sha256sum file` hashes the file bytes).
 *
 * Input: `<package>=<sha256>` lines on stdin (one per lockstep package) and
 * `--version <v>` (the single lockstep version — the same for every package).
 * Output: the 64-hex digest on stdout.
 *
 * Exit: 0 printed; 2 DID NOT RUN (no lines, or a line whose sha is not a
 * 64-char hex). An empty or malformed line is a REFUSAL, never a match — the same
 * fail-closed rule as the per-package preflight (flair#1856 R2): a missing hash
 * must not silently drop a line and change the digest.
 *
 * DEPENDENCY-FREE: the post-publish canary runs on a clean, credential-less
 * runner that installs no repo dependencies, so every import here is a `node:`
 * builtin. `test/unit/canary-scripts-dependency-free.test.ts` guards the class.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Order strings by raw byte value — byte-identical to `LC_ALL=C sort` — so the
 * digest matches the release pack regardless of the locale of the machine it runs
 * on.
 */
function byteCompare(a, b) {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
     if (ba[i] !== bb[i]) return ba[i] - bb[i];
   }
  return ba.length - bb.length;
}

/**
 * The canonical package-set digest over `<name>=<sha256>` pairs, all at one
 * lockstep `version`. Throws (caught by the CLI) on an empty input or a
 * non-64-hex sha — a refusal, never a match.
 */
export function computePackageSetDigest(pairs, version, options = {}) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error("no package=sha256 lines");
   }
  if (options?.expected != null) {
    assertExactSetOfNames(pairs.map((p) => p[0]), [...options.expected], "the package set");
   }
  const lines = [];
  for (const [name, sha] of pairs) {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`blank package name among ${pairs.length} lines`);
     }
    if (typeof sha !== "string" || !SHA256_RE.test(sha)) {
      throw new Error(`non-64-hex sha256 for ${name}: '${sha}'`);
     }
    lines.push(`${name}@${version} ${sha}`);
   }
  lines.sort(byteCompare);
  return createHash("sha256").update(lines.join("\n") + "\n", "utf8").digest("hex");
}

/**
 * Refuse unless `names` and `expected` describe the same SET of package names:
 * every expected name present exactly once, no name that is not expected, and no
 * name that appears more than once. When they differ, throw naming every
 * offending member as "missing ", "extra " or "duplicated " (the label names the
 * set). `release-pack.mjs` drives this with `expected = lockstepPackages(root)`
 * so a package-set digest is never recorded for a set that is not exactly the
 * derived lockstep set — a missing, extra or duplicated member is a refusal.
 */
export function assertExactSetOfNames(names, expected, label = "the package set") {
  const want = new Set(expected);
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const missing = [...want].filter((n) => !counts.has(n));
  const extra = [...counts.keys()].filter((n) => !want.has(n));
  const duplicated = [...counts.keys()].filter((n) => (counts.get(n) ?? 0) > 1);
  if (missing.length === 0 && extra.length === 0 && duplicated.length === 0) return;
  const parts = [];
  if (missing.length > 0) parts.push(`missing [${missing.join(", ")}]`);
  if (extra.length > 0) parts.push(`extra [${extra.join(", ")}]`);
  if (duplicated.length > 0) parts.push(`duplicated [${duplicated.join(", ")}]`);
  throw new Error(`${label} is not exactly the lockstep set: ${parts.join("; ")}`);
}

/** Parse `<name>=<sha256>` stdin into `[[name, sha], ...]` (throws on malformed). */
function parsePairs(raw) {
  const pairs = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const idx = line.indexOf("=");
    if (idx < 0) throw new Error(`no '=' in line: '${line}'`);
    pairs.push([line.slice(0, idx), line.slice(idx + 1)]);
   }
  return pairs;
}

function main() {
  const args = process.argv.slice(2);
  let version = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" && i + 1 < args.length) {
      version = args[i + 1];
      i++;
     } else if (args[i].startsWith("--version=")) {
      version = args[i].slice("--version=".length);
     }
   }
  if (version === null || version.length === 0) {
    console.error("usage: package-set-digest.mjs --version <v>   (reads name=sha256 lines on stdin)");
    return 2;
   }
  let raw;
  try {
    raw = readFileSync(0, "utf8");
   } catch {
    console.error("package-set-digest.mjs: DID NOT RUN — could not read stdin");
    return 2;
   }
  let pairs;
  try {
    pairs = parsePairs(raw);
   } catch (err) {
    console.error(`package-set-digest.mjs: DID NOT RUN — ${err instanceof Error ? err.message : err}`);
    return 2;
   }
  if (pairs.length === 0) {
    console.error("package-set-digest.mjs: DID NOT RUN — no name=sha256 lines on stdin");
    return 2;
   }
  let digest;
  try {
    digest = computePackageSetDigest(pairs, version);
   } catch (err) {
    console.error(`package-set-digest.mjs: DID NOT RUN — ${err instanceof Error ? err.message : err}`);
    return 2;
   }
  process.stdout.write(digest + "\n");
  return 0;
}

// Follow symlinks on both sides (flair#1856 R2): resolve() alone would make a
// symlinked checkout read as "not the entry point" and skip main().
function sameFile(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
   } catch {
    return false;
   }
}
const invokedDirectly = process.argv[1] !== undefined && sameFile(process.argv[1], fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(main());
}
