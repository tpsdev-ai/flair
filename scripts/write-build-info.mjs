#!/usr/bin/env node
// write-build-info.mjs — stamp dist/build-info.json with the build's identity
// (flair#1076).
//
// PROBLEM. dist/ carried no self-identification, so every fleet deploy proved
// "the served code is new" by grepping dist/ for a marker chosen fresh from
// each release's diff — per-release marker archaeology. And the server itself
// could not report WHICH build it loaded (the 0.25.0 stale-dist incident
// class: package.json says X, the loaded dist is older).
//
// FIX. Both build scripts (`build` and `build:cli`) end by running this, so a
// dist/ tree always carries `{ version, commit, builtAt, builder }` alongside
// the compiled modules it describes. resources/build-info.ts reads the file
// back at request time and /Health serves it (resources/health.ts) — the
// running server reports its own build identity.
//
// HONESTY (Sherlock ruling on #1076): `commit` is `git rev-parse HEAD` when
// the build runs inside a git work tree, and an EXPLICIT null otherwise
// (tarball builds — `npm install` from the packed tarball has no .git). A
// null rendered as "unknown" downstream is fine; a fabricated sha is not, and
// the key is always present — never silently omitted.
//
// Runs with cwd = the package root (how the package.json scripts invoke it);
// everything below is cwd-relative so the stamp always describes the tree
// being built, not wherever this script's source happens to live.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
if (typeof pkg.version !== "string" || pkg.version.length === 0) {
  console.error(`write-build-info: ${join(root, "package.json")} has no version — refusing to stamp an unidentifiable build`);
  process.exit(1);
}

let commit = null;
try {
  const out = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf-8",
    // stderr ignored: outside a repo, git's complaint is expected noise — the
    // null fallback below IS the correct answer there, not an error to print.
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  }).trim();
  // Only a full 40-hex sha is a commit identity. Anything else (empty output,
  // an odd wrapper mangling stdout) degrades to the honest null, never to a
  // fabricated or truncated value.
  if (/^[0-9a-f]{40}$/.test(out)) commit = out;
} catch {
  commit = null; // not a git work tree (e.g. building from the npm tarball)
}

const info = {
  version: pkg.version,
  commit,
  builtAt: new Date().toISOString(),
  builder: "tsc",
};

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "build-info.json"), JSON.stringify(info, null, 2) + "\n");
console.log(`write-build-info: dist/build-info.json ${info.version} @ ${commit ?? "null (no git work tree)"}`);
