#!/usr/bin/env node
// Extract one version's section body from CHANGELOG.md.
//
// Usage: node scripts/changelog-extract.mjs <version> [changelog-path]
//   <version>      bare semver, e.g. 0.16.0 (no leading "v")
//   changelog-path defaults to ./CHANGELOG.md
//
// Prints the section body (the lines after the `## [<version>] ...` header,
// up to but excluding the next `## [` header) to stdout, trimmed.
// Exits non-zero with a message on stderr if the section is missing or empty,
// so the caller can fail loudly rather than cut an empty release.
//
// The GitHub release page no longer dumps this body verbatim (flair#1392) —
// `scripts/changelog-release-notes.mjs` renders a lede + links summary from
// the same section. This script remains the section reader those tools share.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$/;

export class ExtractError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * Return the body of `## [<version>]` from `path` (trimmed, no header).
 * Throws ExtractError — exitCode 2 for usage/IO, 1 for missing/empty section.
 */
export function extractChangelogSection(version, path = "CHANGELOG.md") {
  if (!version) {
    throw new ExtractError("changelog-extract: missing <version> argument", 2);
  }
  // Defence-in-depth: the workflow already validates the tag, but the script is
  // the one touching the file — never let a crafted "version" become a regex.
  if (!SEMVER_RE.test(version)) {
    throw new ExtractError(`changelog-extract: invalid version '${version}'`, 2);
  }

  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ExtractError(`changelog-extract: cannot read ${path}: ${err.message}`, 2);
  }

  const lines = text.split("\n");
  // Match the header for THIS version literally: "## [<version>]" optionally
  // followed by " - <date>" or other trailing text. version is validated above,
  // but escape it anyway so it is matched as data, not pattern.
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerRe = new RegExp(`^## \\[${esc}\\]`);
  const anyHeaderRe = /^## \[/;

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    throw new ExtractError(
      `changelog-extract: no '## [${version}]' section found in ${path}`,
      1,
    );
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (anyHeaderRe.test(lines[i])) {
      end = i;
      break;
    }
  }

  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();

  if (body.length === 0) {
    throw new ExtractError(
      `changelog-extract: section '## [${version}]' is empty in ${path}`,
      1,
    );
  }

  return body;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  // A downstream reader closing the pipe early (e.g. `… | head`) raises EPIPE on
  // stdout. That is not an error for us — exit cleanly instead of crashing.
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });

  try {
    const body = extractChangelogSection(process.argv[2], process.argv[3]);
    process.stdout.write(body + "\n");
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(err instanceof ExtractError ? err.exitCode : 1);
  }
}
