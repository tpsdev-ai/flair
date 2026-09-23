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
 *   node scripts/ci/registry-tarball-sha256.mjs <version> [package]
 *
 * `package` defaults to `@tpsdev-ai/flair` (flair#1781). The promote step binds
 * ONE line per lockstep package, so each line carries its own package's sha.
 *
 * Prints the 64-char hex sha256 on stdout. Exit codes:
 *   0 — printed
 *   2 — DID NOT RUN (bad version/package, could not resolve, fetch failed) — never green.
 *
 * NO REPOSITORY DEPENDENCIES. This script runs in the post-publish canary on a
 * clean, credential-less runner that installs nothing (flair#1856): it imported
 * `semver`, which crashed with ERR_MODULE_NOT_FOUND and hashed 0/9 tarballs —
 * refusing to promote a partial set, which is correct but unmeasurable. It now
 * uses the official strict SemVer 2.0.0 regex below, so every import here is a
 * `node:` builtin. `test/unit/canary-scripts-dependency-free.test.ts` guards the
 * class: no script the canary runs may import a bare package specifier.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PACKAGE = "@tpsdev-ai/flair";

// Strict SemVer 2.0.0 — the official regex from semver.org, anchored with ^…$
// so exactly a canonical version matches. This is the SAME CONTRACT as the
// `semver.valid(version) !== version` it replaces:
//   - a leading "v" is NOT canonical (`semver.valid("v1.2.3") === "1.2.3"`);
//   - missing components and leading zeros are rejected;
//   - every legal prerelease identifier is accepted, including a hyphen inside
//     one (`1.2.3-rc-1`), which the old hand-rolled regex rejected and turned
//     into a DID-NOT-RUN for an otherwise measurable canary (flair#1781 R4).
export const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** True iff `version` is exactly a canonical strict SemVer 2.0.0 string. */
export function isStrictSemver(version) {
  return typeof version === "string" && STRICT_SEMVER.test(version);
}

// npm package names are lowercase; a scoped name is @scope/name. A bad value
// must not be interpolated into an `npm view` spec.
const PACKAGE_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Resolve the tarball URL for `<packageName>@<version>` (throws on failure). */
function resolveTarballUrl(spec) {
  const url = execFileSync("npm", ["view", spec, "dist.tarball"], { encoding: "utf8" }).trim();
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`unexpected tarball URL for ${spec}: '${url}'`);
  }
  return url;
}

async function main(argv) {
  const version = argv[0] ?? "";
  const packageName = argv[1] ?? DEFAULT_PACKAGE;

  if (!isStrictSemver(version)) {
    console.error(`usage: node scripts/ci/registry-tarball-sha256.mjs <version> [package] (got version '${version}')`);
    return 2;
  }
  if (!PACKAGE_NAME_RE.test(packageName)) {
    console.error(`usage: node scripts/ci/registry-tarball-sha256.mjs <version> [package] (got package '${packageName}')`);
    return 2;
  }

  const spec = `${packageName}@${version}`;
  let url;
  try {
    url = resolveTarballUrl(spec);
  } catch (err) {
    console.error(`could not resolve ${spec} dist.tarball: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    return 2;
  }

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`fetch ${url} -> HTTP ${res.status}`);
    return 2;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  process.stdout.write(createHash("sha256").update(bytes).digest("hex") + "\n");
  return 0;
}

const isDirect = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`DID NOT RUN: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  });
}
