#!/usr/bin/env node
/**
 * select-migration-baseline.mjs — newest non-deprecated npm version strictly
 * below HEAD (flair#1757).
 *
 * Migration lanes used to pick max(version) where version < HEAD. `npm
 * deprecate` does not remove a version from `versions`, so a known-broken
 * publish (0.54.1: global install omits fs-extra) was installed and the lane
 * died later inside Harper. This helper refuses that version at selection
 * time.
 *
 * Usage:
 *   node scripts/ci/select-migration-baseline.mjs <head-version>
 *   node scripts/ci/select-migration-baseline.mjs --fixture <file> <head-version>
 *
 * stdout: the chosen x.y.z baseline, and nothing else
 * stderr: each deprecated version skipped (and why), then the chosen baseline
 * exit 1: no baseline, or the registry/usage check did not run — the lane
 *         must not install
 *
 * Deprecated fields are read newest-first and the walk stops at the first
 * non-deprecated version below HEAD. Older publishes cannot win once that
 * version exists, so they are not queried. The skip log is the set version
 * order would have preferred over the baseline.
 *
 * NO REPOSITORY DEPENDENCIES. Both lanes invoke this with node before any
 * package install of the baseline itself. Every import here is a node builtin.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const NO_BASELINE = "no baseline";
export const DEFAULT_PACKAGE = "@tpsdev-ai/flair";

/** Strict x.y.z. Matches the install guard in the migration lanes (flair#1055). */
export const STRICT_XYZ = /^[0-9]+\.[0-9]+\.[0-9]+$/;

const USAGE =
  "usage: node scripts/ci/select-migration-baseline.mjs [--fixture <file>] <head-version>";

export function isStrictXyz(version) {
  return typeof version === "string" && STRICT_XYZ.test(version);
}

/** Numeric x.y.z compare. Negative when `a` is older than `b`. */
export function compareStrictSemver(a, b) {
  const pa = a.split(".").map((part) => Number(part));
  const pb = b.split(".").map((part) => Number(part));
  for (let i = 0; i < 3; i++) {
    const ca = pa[i] || 0;
    const cb = pb[i] || 0;
    if (ca < cb) return -1;
    if (ca > cb) return 1;
  }
  return 0;
}

/**
 * The npm deprecation message, or null when the version is usable.
 * A missing field, empty string, or false is not a deprecation.
 * @param {{ deprecated?: unknown }} record
 * @returns {string | null}
 */
export function deprecationReason(record) {
  if (!record || typeof record !== "object") return null;
  const value = record.deprecated;
  if (value === true) return "deprecated";
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

/**
 * Pick the newest non-deprecated strict x.y.z strictly below `headVersion`.
 *
 * @param {Array<{ version?: unknown, deprecated?: unknown } | string>} records
 * @param {string} headVersion
 * @returns {{
 *   status: "ok" | "no baseline",
 *   baseline: string | null,
 *   skipped: Array<{ version: string, reason: string }>,
 *   message: string,
 * }}
 */
export function selectMigrationBaseline(records, headVersion) {
  if (!isStrictXyz(headVersion)) {
    return {
      status: NO_BASELINE,
      baseline: null,
      skipped: [],
      message: `${NO_BASELINE}: head version '${headVersion}' is not x.y.z`,
    };
  }

  const skipped = [];
  const usable = [];
  const list = Array.isArray(records) ? records : [];
  for (const record of list) {
    const version = typeof record === "string" ? record : record?.version;
    if (!isStrictXyz(version)) continue;
    if (compareStrictSemver(version, headVersion) >= 0) continue;
    const reason = deprecationReason(typeof record === "string" ? {} : record);
    if (reason) skipped.push({ version, reason });
    else usable.push(version);
  }

  skipped.sort((a, b) => compareStrictSemver(b.version, a.version));

  if (usable.length === 0) {
    const named = skipped.length
      ? `; skipped deprecated: ${skipped.map((s) => `${s.version} (${s.reason})`).join("; ")}`
      : "";
    return {
      status: NO_BASELINE,
      baseline: null,
      skipped,
      message: `${NO_BASELINE}: no non-deprecated x.y.z version is strictly older than ${headVersion}${named}`,
    };
  }

  usable.sort(compareStrictSemver);
  const baseline = usable[usable.length - 1];
  return {
    status: "ok",
    baseline,
    skipped,
    message: `baseline ${baseline} (newest non-deprecated version < ${headVersion})`,
  };
}

/**
 * Versions strictly below HEAD, newest first, with `deprecated` filled in
 * until the first usable version (inclusive).
 *
 * @param {string[]} versions
 * @param {string} headVersion
 * @param {(version: string) => unknown} readDeprecated
 */
export function collectCandidateRecords(versions, headVersion, readDeprecated) {
  if (!isStrictXyz(headVersion)) return [];
  const below = (Array.isArray(versions) ? versions : [])
    .filter((version) => isStrictXyz(version) && compareStrictSemver(version, headVersion) < 0)
    .sort((a, b) => compareStrictSemver(b, a));
  const records = [];
  for (const version of below) {
    const deprecated = readDeprecated(version);
    records.push({ version, deprecated });
    if (!deprecationReason({ version, deprecated })) break;
  }
  return records;
}

/** stderr lines: skipped deprecated versions, then the selection message. */
export function formatSelection(selection) {
  const lines = selection.skipped.map((skip) => `skipped deprecated ${skip.version}: ${skip.reason}`);
  lines.push(selection.message);
  return lines;
}

/**
 * `npm view <pkg> versions --json` is a JSON array, except a package with one
 * version prints a JSON string. Anything else is unusable.
 * @param {string} stdout
 * @returns {string[]}
 */
export function parseNpmVersions(stdout) {
  const parsed = JSON.parse(String(stdout).trim());
  if (typeof parsed === "string") return [parsed];
  if (Array.isArray(parsed) && parsed.every((version) => typeof version === "string")) return parsed;
  throw new Error("npm view versions returned unexpected JSON");
}

/**
 * `npm view <pkg>@<version> deprecated --json` prints a JSON string, or
 * nothing when the version is not deprecated.
 * @param {string} stdout
 * @returns {string | null}
 */
export function parseDeprecatedField(stdout) {
  const raw = String(stdout).trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("npm view deprecated returned non-JSON output");
  }
  if (parsed == null || parsed === false) return null;
  if (typeof parsed === "string") return parsed.length ? parsed : null;
  if (parsed === true) return "deprecated";
  throw new Error("npm view deprecated returned unexpected JSON");
}

/**
 * @param {string[]} argv
 * @returns {{ fixture: string | null, head: string } | { error: string }}
 */
export function parseArgs(argv) {
  const args = [...argv];
  let fixture = null;
  if (args[0] === "--fixture") {
    fixture = args[1] ?? "";
    if (!fixture) return { error: USAGE };
    args.splice(0, 2);
  }
  const head = args[0] ?? "";
  if (!head || args.length !== 1) return { error: USAGE };
  return { fixture, head };
}

function npmView(spec, field) {
  try {
    return execFileSync("npm", ["view", spec, field, "--json"], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr ?? "") : "";
    const detail = stderr
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("npm error log")) ?? (err instanceof Error ? err.message.split("\n")[0] : String(err));
    throw new Error(detail);
  }
}

function loadFixture(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read baseline fixture ${path}: ${err instanceof Error ? err.message : err}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`baseline fixture ${path} must be a JSON array`);
  return parsed;
}

function recordsFromRegistry(headVersion) {
  let stdout;
  try {
    stdout = npmView(DEFAULT_PACKAGE, "versions");
  } catch (err) {
    throw new Error(
      `cannot query npm registry for ${DEFAULT_PACKAGE} versions: ${err instanceof Error ? err.message : err}`,
    );
  }
  const versions = parseNpmVersions(stdout);
  return collectCandidateRecords(versions, headVersion, (version) => {
    let field;
    try {
      field = npmView(`${DEFAULT_PACKAGE}@${version}`, "deprecated");
    } catch (err) {
      throw new Error(
        `cannot read deprecated field for ${DEFAULT_PACKAGE}@${version}: ${err instanceof Error ? err.message : err}`,
      );
    }
    return parseDeprecatedField(field);
  });
}

/**
 * @param {string[]} argv
 * @returns {number} process exit code
 */
export function main(argv) {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`::error::${parsed.error}`);
    return 1;
  }

  let records;
  try {
    records = parsed.fixture ? loadFixture(parsed.fixture) : recordsFromRegistry(parsed.head);
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : err}`);
    return 1;
  }

  const selection = selectMigrationBaseline(records, parsed.head);
  for (const line of formatSelection(selection)) {
    console.error(selection.status === "ok" || line !== selection.message ? line : `::error::${line}`);
  }
  if (selection.status !== "ok" || !selection.baseline) return 1;
  process.stdout.write(`${selection.baseline}\n`);
  return 0;
}

function sameFile(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

const isDirect = process.argv[1] !== undefined && sameFile(process.argv[1], fileURLToPath(import.meta.url));
if (isDirect) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
