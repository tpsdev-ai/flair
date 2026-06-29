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

import { readFileSync } from "node:fs";

// A downstream reader closing the pipe early (e.g. `… | head`) raises EPIPE on
// stdout. That is not an error for us — exit cleanly instead of crashing.
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const version = process.argv[2];
const path = process.argv[3] ?? "CHANGELOG.md";

if (!version) {
  console.error("changelog-extract: missing <version> argument");
  process.exit(2);
}
// Defence-in-depth: the workflow already validates the tag, but the script is
// the one touching the file — never let a crafted "version" become a regex.
if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$/.test(version)) {
  console.error(`changelog-extract: invalid version '${version}'`);
  process.exit(2);
}

let text;
try {
  text = readFileSync(path, "utf8");
} catch (err) {
  console.error(`changelog-extract: cannot read ${path}: ${err.message}`);
  process.exit(2);
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
  console.error(
    `changelog-extract: no '## [${version}]' section found in ${path}`,
  );
  process.exit(1);
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
  console.error(
    `changelog-extract: section '## [${version}]' is empty in ${path}`,
  );
  process.exit(1);
}

process.stdout.write(body + "\n");
