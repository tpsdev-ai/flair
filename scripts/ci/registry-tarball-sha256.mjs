#!/usr/bin/env node
/**
 * registry-tarball-sha256.mjs — the content hash the post-publish canary binds
 * to (flair#1686).
 *
 * WHY THIS EXISTS. The canary's promote command is meant to be sha256-bound: a
 * stale PASS, a re-cut version, or a wrong input must abort before `latest`
 * moves. npm's packument does NOT expose a sha256 — `dist.shasum` is a SHA-1
 * (40 hex) and `dist.integrity` is a SHA-512 SRI. Comparing a sha256 to
 * `dist.shasum` can therefore never match, which is the bug this helper removes.
 * It downloads the published tarball and prints its real sha256, so the canary,
 * the promote command and the stage job all talk about the same hash.
 *
 * Usage:
 *   node scripts/ci/registry-tarball-sha256.mjs <version>
 *
 * Prints the 64-char hex sha256 on stdout. Exit codes:
 *   0 — printed
 *   2 — DID NOT RUN (bad version, could not resolve, fetch failed) — never green.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(version)) {
  console.error(`usage: node scripts/ci/registry-tarball-sha256.mjs <version> (got '${version}')`);
  process.exit(2);
}

const spec = `@tpsdev-ai/flair@${version}`;
let url;
try {
  url = execFileSync("npm", ["view", spec, "dist.tarball"], { encoding: "utf8" }).trim();
} catch (err) {
  console.error(`could not resolve ${spec} dist.tarball: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
  process.exit(2);
}
if (!/^https?:\/\//.test(url)) {
  console.error(`unexpected tarball URL for ${spec}: '${url}'`);
  process.exit(2);
}

const res = await fetch(url);
if (!res.ok) {
  console.error(`fetch ${url} -> HTTP ${res.status}`);
  process.exit(2);
}
const bytes = Buffer.from(await res.arrayBuffer());
process.stdout.write(createHash("sha256").update(bytes).digest("hex") + "\n");
