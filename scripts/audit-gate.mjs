#!/usr/bin/env node
/**
 * Dependency audit gate — the blocking check behind CI's `audit` job.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * The audit step used to be:
 *
 *     run: bun audit || echo "::warning::Audit found vulnerabilities — all in
 *          harper transitive deps (unreleased v5 build)"
 *     continue-on-error: true
 *
 * Two independent mechanisms each guaranteed a pass, so the step reported
 * success no matter what `bun audit` found. The justification was true when it
 * was written, but it carried no expiry, so it outlived its reason: by the time
 * it was removed the claim "all in harper transitive deps" was simply false —
 * a critical advisory was reaching users through a first-party workspace
 * package, and the gate said nothing.
 *
 * The fix is not "delete the escape hatch" — some advisories genuinely cannot be
 * fixed from this repo. The fix is to make every exception *enumerated, justified
 * and dated*, and to make the gate fail when an exception outlives its date or
 * its justification. An unexpirable exception is how we got here.
 *
 * WHAT IT ENFORCES
 * ----------------
 *   1. The audit must actually run. If `bun audit` cannot produce parseable
 *      output, the gate FAILS. A gate that passes when its tool breaks is the
 *      same defect wearing a different hat.
 *   2. Every advisory `bun audit` reports must be on the allowlist. Anything
 *      unlisted BLOCKS.
 *   3. Every allowlist entry must be well-formed: advisory id, package, the
 *      reason it cannot be fixed here, an expiry date, and the condition that
 *      removes it. Missing any field BLOCKS.
 *   4. Expiry is capped by severity (see the allowlist's `policy` block). You
 *      cannot park a critical for a year. Writing an over-long expiry BLOCKS.
 *   5. An expired entry BLOCKS. That is the point of the mechanism, not a flaw:
 *      the build stops and a human re-decides.
 *   6. STALENESS — an allowlist entry whose advisory no longer appears BLOCKS
 *      with "remove this entry". An allowlist that only ever grows is the same
 *      failure with more ceremony.
 *   6a. COVERAGE PER LOCATION — an advisory may carry several entries, keyed by
 *      GHSA, package, sources and introducedBy. On `bun` and the root
 *      npm-install observation, one entry per (GHSA, package) may name the
 *      source. On another consumer install, each entry's chain resolves to one
 *      node and every reported node must be the node of exactly one entry. Such
 *      an entry that covers no reported location in a source it names is stale,
 *      whatever its siblings cover. A GHSA with one entry keeps the
 *      single-entry matching path; the class rule in 6b applies to it too.
 *   6b. CLASS PER SOURCE — `vendor-pinned` is refused on `bun`: bun.lock
 *      resolves through this repository's root overrides.
 *   7. FIXABILITY DRIFT — entries claiming `no-patch-published` are re-checked
 *      against the registry. If a patched version has since shipped, the stated
 *      justification is false and the entry BLOCKS.
 *
 * Check 7 needs the network. If the registry is unreachable the script says so
 * loudly and continues with checks 1-6, which are offline-deterministic and
 * carry the load. That is a deliberate, narrow degradation — not a blanket
 * `continue-on-error`.
 *
 * Run it locally:  node scripts/audit-gate.mjs --explain
 * CI invokes it as `bun scripts/audit-gate.mjs --explain` because the `audit`
 * job pins bun exactly and has no setup-node step; it behaves identically under
 * both runtimes. `--explain` prints the full reasoning behind every decision.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST_PATH = join(REPO_ROOT, ".github", "audit-allowlist.json");
const EXPLAIN = process.argv.includes("--explain");

const REQUIRED_ENTRY_FIELDS = [
  "ghsa",
  "package",
  "severity",
  "class",
  "introducedBy",
  "reason",
  "added",
  "expires",
  "removeWhen",
  "sources",
  "approvedBy",
];

/**
 * The consumer-install observations. Each is one published package, packed
 * from its workspace directory `dir` and installed with npm --omit=dev outside
 * this repo (so without its overrides), then audited with `npm audit
 * --omit=dev --json`. npm overrides in a package do not apply to its consumers,
 * so the workspace's bun lockfile does not show what a consumer of each package
 * resolves (flair#1498, flair#2398, flair#2757).
 *
 * Each input is a mandatory flag naming an install prefix. Before any audit
 * runs, the gate refuses a missing flag, two flags naming one prefix, and a
 * prefix whose install records fail `prefixIdentityProblems` against the
 * workspace manifest the job packs: the package as a production dependency
 * from a local tarball, with that manifest's version and `dependencies`.
 * `source` is the name an allowlist entry's `sources` uses for that tree.
 * `vendor`, when set, is the only direct dependency a vendor-pinned entry's
 * chain may name second.
 */
export const CONSUMER_INSTALLS = [
  { flag: "--npm-install-prefix", source: "npm-install", package: "@tpsdev-ai/flair", dir: "." },
  { flag: "--adk-npm-install-prefix", source: "npm-install-adk", package: "@tpsdev-ai/adk-flair", dir: "packages/adk-flair-js", vendor: "@google/adk" },
  { flag: "--mcp-npm-install-prefix", source: "npm-install-mcp", package: "@tpsdev-ai/flair-mcp", dir: "packages/flair-mcp" },
  { flag: "--openclaw-npm-install-prefix", source: "npm-install-openclaw", package: "@tpsdev-ai/openclaw-flair", dir: "packages/openclaw-flair" },
  { flag: "--pi-npm-install-prefix", source: "npm-install-pi", package: "@tpsdev-ai/pi-flair", dir: "packages/pi-flair" },
  { flag: "--n8n-npm-install-prefix", source: "npm-install-n8n", package: "@tpsdev-ai/n8n-nodes-flair", dir: "packages/n8n-nodes-flair" },
];

// The observations the gate runs. `bun` is the lockfile observation (`bun
// audit`); the others are the consumer-install observations above. An
// allowlist entry declares which of these it expects to see its advisory in.
const VALID_SOURCES = new Set(["bun", ...CONSUMER_INSTALLS.map((input) => input.source)]);

/**
 * Sources where at most one entry per (ghsa, package) may cover an advisory.
 * `bun audit` reports no location, and the root npm-install observation is
 * checked against harper's shipped evidence per entry, not per chain. On every
 * other consumer-install source an advisory may be split across entries, one
 * per dependency chain, each covering the node its chain resolves to.
 */
const SINGLE_ENTRY_SOURCES = new Set(["bun", "npm-install"]);

/**
 * The identity of an allowlist entry: GHSA (case-insensitive), package, the set
 * of sources and introducedBy. Several entries may share a GHSA; two with the
 * same key are a duplicate.
 */
export function entryKey(entry) {
  const sources = Array.isArray(entry?.sources) ? [...new Set(entry.sources)].sort() : entry?.sources;
  return JSON.stringify([String(entry?.ghsa ?? "").toUpperCase(), entry?.package, sources, entry?.introducedBy]);
}

/** How a diagnostic names an entry when its GHSA has more than one. */
function entryLabel(entry, index) {
  // Formats a non-array `sources` value as text instead of joining it.
  const sources = Array.isArray(entry.sources) ? entry.sources.join(", ") : String(entry.sources ?? "");
  return `entry[${index}] (${entry.ghsa} / ${entry.package}, sources [${sources}], via ${entry.introducedBy})`;
}

const VALID_CLASSES = new Set([
  // No patched version exists anywhere yet. Nothing to do but wait upstream.
  "no-patch-published",
  // A patch exists upstream, but the vulnerable version is pinned inside a
  // vendored dependency we do not control the resolution of.
  "vendor-pinned",
  // A patch exists AND we could take it. Deliberately deferred to a separate,
  // test-gated change. Shortest leash of the three.
  "remediation-available",
]);

const failures = [];
const warnings = [];

function reportFailuresAndExit() {
  console.log(`  ${failures.length} problem(s) block this build:\n`);
  for (const f of failures) {
    console.log(`::error::audit-gate: ${f.split("\n")[0]}`);
    console.log(`    - ${f}\n`);
  }
  console.log(
    "  This gate is blocking by design. Do not add `continue-on-error` or `|| true` to it —\n" +
      "  that is the exact defect it was written to remove. Either fix the advisory, or add a\n" +
      "  justified, dated entry to .github/audit-allowlist.json that a reviewer has agreed to.\n",
  );
  process.exit(1);
}
const notes = [];

const fail = (m) => failures.push(m);
const warn = (m) => warnings.push(m);

/* ------------------------------------------------------------------ *
 * Minimal semver, scoped to the comparator sets `bun audit` actually  *
 * emits: space-separated AND-ed comparators, e.g. ">=4.0.0 <4.0.4",   *
 * "<=7.5.20", "<2.2.0". No ranges, unions or carets appear there.     *
 * ------------------------------------------------------------------ */

function parseVersion(v) {
  const [core, pre = ""] = String(v).trim().replace(/^v/, "").split("-");
  const parts = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
  return { parts: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], pre };
}

function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (va.parts[i] !== vb.parts[i]) return va.parts[i] < vb.parts[i] ? -1 : 1;
  }
  // A prerelease sorts below its own release (1.0.0-rc < 1.0.0).
  if (va.pre && !vb.pre) return -1;
  if (!va.pre && vb.pre) return 1;
  if (va.pre === vb.pre) return 0;
  return va.pre < vb.pre ? -1 : 1;
}

function satisfiesComparator(version, comparator) {
  const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(comparator.trim());
  if (!m) return false;
  const [, op = "=", target] = m;
  const c = compareVersions(version, target);
  switch (op) {
    case ">=":
      return c >= 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    case "<":
      return c < 0;
    default:
      return c === 0;
  }
}

/** True when `version` falls inside the vulnerable range. */
export function isVulnerable(version, range) {
  const comparators = String(range).trim().split(/\s+/).filter(Boolean);
  if (comparators.length === 0) return false;
  return comparators.every((c) => satisfiesComparator(version, c));
}

/* ------------------------------------------------------------------ *
 * Inputs                                                             *
 * ------------------------------------------------------------------ */

/** A short description of a parsed JSON value, for audit-report refusal messages. */
function jsonShapeOf(value) {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value !== "object") return `a ${typeof value}`;
  const keys = Object.keys(value);
  return keys.length === 0 ? "an empty object" : `an object with keys ${keys.slice(0, 6).join(", ")}`;
}

/** The remedy the report refusals below name, so an operator knows what to do. */
const AUDIT_REMEDY = "Re-run the stage; if it keeps failing, check registry access.";

/**
 * Refuses a value that is not a JSON object (null, an array, a string, a
 * number), and an object whose own `error` property is a string or an object.
 * Returns the reason, or null. Passing this check does not make the value a
 * report; each stage adds its own checks.
 */
function errorEnvelopeRefusal(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return `did not produce a JSON report object (got ${jsonShapeOf(parsed)})`;
  }
  const e = parsed.error;
  if (
    Object.hasOwn(parsed, "error") &&
    (typeof e === "string" || (e !== null && typeof e === "object" && !Array.isArray(e)))
  ) {
    const code = e !== null && typeof e === "object" ? e.code : e;
    return `returned an error object instead of a report${code === undefined ? "" : ` (${String(code)})`}`;
  }
  return null;
}

/**
 * Refuses what `errorEnvelopeRefusal` refuses, and an object whose
 * `vulnerabilities` property is missing or is not an object (the empty object
 * `{}` included). `{"vulnerabilities":{}}` passes. The entries inside
 * `vulnerabilities` are not checked here. Returns the reason, or null.
 */
export function npmAuditReportRefusal(parsed) {
  const envelope = errorEnvelopeRefusal(parsed);
  if (envelope) return envelope;
  const v = parsed.vulnerabilities;
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return `report has no "vulnerabilities" object (got ${jsonShapeOf(v)})`;
  }
  return null;
}

/**
 * Applies the envelope check only, so `{}` passes. The values in bun's map of
 * package name to advisory array are not checked here; `bunAuditOutcomeRefusal`
 * compares the report with bun's exit status and stderr. Returns the reason,
 * or null.
 */
export function bunAuditReportRefusal(parsed) {
  return errorEnvelopeRefusal(parsed);
}

/** Refuse an audit report: the reason, then the stage and remedy an operator acts on. */
function refuseAuditReport(stage, reason) {
  return new Error(`${stage} ${reason}. ${AUDIT_REMEDY}`);
}

/** The first stderr line matching `pattern`, with ANSI colour codes removed, or null. */
function stderrLineMatching(stderr, pattern) {
  for (const raw of String(stderr ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (pattern.test(line)) return line.slice(0, 300);
  }
  return null;
}

/** How a refusal names the exit: spawnSync reports a null status when a signal ended the tool. */
function exitText(status) {
  return status === null || status === undefined ? "ended without an exit status" : `exited ${status}`;
}

/**
 * The failure lines bun 1.3.10 printed in the real-tool tests:
 * `error: ...` and `<Name>: audit request failed`.
 */
const BUN_STDERR_ERROR = /^error:|audit request failed/i;
/**
 * npm's failure lines: `npm error` (npm 10.9 and 11.19 in the real-tool tests)
 * and the older `npm ERR!`.
 */
const NPM_STDERR_ERROR = /^npm (error|ERR!)/;

/**
 * Refuses a bun report when bun's stderr has a line matching
 * `BUN_STDERR_ERROR`, or when bun exited non-zero (or without an exit status)
 * and the report lists no advisories. bun exits 1 when its report lists
 * advisories, so a non-zero exit with advisories passes this check. Returns
 * the reason, or null.
 */
export function bunAuditOutcomeRefusal(parsed, status, stderr = "") {
  const errorLine = stderrLineMatching(stderr, BUN_STDERR_ERROR);
  if (errorLine) return `wrote an error to stderr (${errorLine})`;
  if (status !== 0 && flattenAdvisories(parsed).length === 0) {
    return `${exitText(status)} but its report lists no advisories`;
  }
  return null;
}

/**
 * Refuses an npm report when npm's stderr has a line matching
 * `NPM_STDERR_ERROR`, or when npm exited non-zero (or without an exit status)
 * and the `vulnerabilities` object is empty. Returns the reason, or null.
 */
export function npmAuditOutcomeRefusal(parsed, status, stderr = "") {
  const errorLine = stderrLineMatching(stderr, NPM_STDERR_ERROR);
  if (errorLine) return `wrote an error to stderr (${errorLine})`;
  if (status !== 0 && Object.keys(parsed.vulnerabilities).length === 0) {
    return `${exitText(status)} but its report lists no vulnerabilities`;
  }
  return null;
}

/**
 * Parse `bun audit --json` output. Refused: no stdout, stdout that is not valid
 * JSON, the envelope check, and the exit-status and stderr checks in
 * `bunAuditOutcomeRefusal`.
 */
export function parseBunAuditOutput(stdout, status, stderr = "") {
  const stage = "`bun audit`";
  const trimmed = (stdout || "").trim();
  if (!trimmed) {
    throw new Error(
      `${stage} produced no output on stdout (exit ${status}). ` +
        `stderr: ${(stderr || "").trim().slice(0, 500) || "<empty>"}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(
      `${stage} stdout was not valid JSON (exit ${status}): ${e.message}. ` +
        `First 300 chars: ${trimmed.slice(0, 300)}`,
    );
  }
  const refusal = bunAuditReportRefusal(parsed) ?? bunAuditOutcomeRefusal(parsed, status, stderr);
  if (refusal) throw refuseAuditReport(stage, refusal);
  return parsed;
}

export function runBunAudit() {
  const res = spawnSync("bun", ["audit", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (res.error) {
    throw new Error(`could not execute \`bun audit\`: ${res.error.message}`);
  }

  return parseBunAuditOutput(res.stdout, res.status, res.stderr);
}

/** Flatten bun's {package: [advisory,...]} shape into a flat advisory list. */
export function flattenAdvisories(auditJson) {
  const out = [];
  for (const [pkg, advisories] of Object.entries(auditJson ?? {})) {
    if (!Array.isArray(advisories)) continue;
    for (const a of advisories) {
      const ghsa = /(GHSA-[a-z0-9-]+)/i.exec(a?.url ?? "")?.[1] ?? null;
      out.push({
        package: pkg,
        ghsa,
        id: a?.id ?? null,
        title: a?.title ?? "",
        severity: (a?.severity ?? "unknown").toLowerCase(),
        vulnerableVersions: a?.vulnerable_versions ?? "",
        url: a?.url ?? "",
        source: "bun",
      });
    }
  }
  return out;
}

/**
 * `npm audit --omit=dev --json` on the packed-and-installed prefix the
 * Install-from-tarball lane produces. This is the installed-tree observation:
 * it reports the advisories a real `npm install -g @tpsdev-ai/flair` would see,
 * which the lockfile observation (`bun audit`) cannot — harper's
 * npm-shrinkwrap or bundled dependency tree pins versions the root overrides
 * never reach under npm.
 *
 * Refused: no stdout, stdout that is not valid JSON, the checks in
 * `npmAuditReportRefusal`, and the exit-status and stderr checks in
 * `npmAuditOutcomeRefusal`.
 */
export function parseNpmAuditOutput(stdout, prefix, status, stderr = "") {
  const stage = `\`npm audit --omit=dev --json\` in ${prefix}`;
  const trimmed = (stdout || "").trim();
  if (!trimmed) {
    throw new Error(
      `${stage} produced no output on stdout (exit ${status}). ` +
        `stderr: ${(stderr || "").trim().slice(0, 500) || "<empty>"}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(
      `${stage} stdout was not valid JSON (exit ${status}): ${e.message}. ` +
        `First 300 chars: ${trimmed.slice(0, 300)}`,
    );
  }
  const refusal = npmAuditReportRefusal(parsed) ?? npmAuditOutcomeRefusal(parsed, status, stderr);
  if (refusal) throw refuseAuditReport(stage, refusal);
  return parsed;
}

export function runNpmAudit(prefix) {
  const res = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
    cwd: prefix,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (res.error) {
    throw new Error(`could not execute \`npm audit\` in ${prefix}: ${res.error.message}`);
  }

  return parseNpmAuditOutput(res.stdout, prefix, res.status, res.stderr);
}

/**
 * Flatten npm's v2 audit report (`{ vulnerabilities: { <pkg>: { nodes, via, ... } } }`)
 * into the same flat advisory shape as `flattenAdvisories`, plus the dependency
 * `nodes` (paths relative to the install root), optional per-node versions
 * from the audit report, and `source: "npm-install"`.
 *
 * `via` carries the advisory metadata (one entry per advisory, with the GHSA in
 * its `url`); `nodes` is per-package, so every advisory for a package shares the
 * same paths. A package may appear both hoisted (`node_modules/<pkg>`) and under
 * harper (`node_modules/harper/node_modules/<pkg>`). The vendor-pinned check
 * below examines every npm-audit-reported node; one harper node cannot cover
 * a hoisted copy reported by npm audit.
 *
 * `source` labels which installed tree this report came from. The root tarball
 * observation is the default `"npm-install"`; the published ADK package's own
 * consumer install passes `"npm-install-adk"` so an entry can name the tree it
 * covers (flair#2398).
 */
export function flattenNpmAdvisories(npmJson, source = "npm-install") {
  const out = [];
  const vulns = npmJson?.vulnerabilities ?? {};
  for (const [pkg, v] of Object.entries(vulns)) {
    if (!v || typeof v !== "object") continue;
    const nodes = Array.isArray(v.nodes) ? v.nodes : [];
    const via = Array.isArray(v.via) ? v.via : [];
    for (const item of via) {
      if (!item || typeof item !== "object") continue;
      const ghsa = /(GHSA-[a-z0-9-]+)/i.exec(item.url ?? "")?.[1] ?? null;
      if (!ghsa) continue;
      out.push({
        package: pkg,
        ghsa,
        id: item.id ?? null,
        title: item.title ?? "",
        severity: (item.severity ?? v.severity ?? "unknown").toLowerCase(),
        vulnerableVersions: item.range ?? "",
        url: item.url ?? "",
        nodes,
        nodeVersions: Object.fromEntries(
          nodes
            .filter((node) => typeof node === "string" && Object.hasOwn(npmJson?.packages ?? {}, node))
            .map((node) => [node, npmJson.packages[node]?.version ?? null]),
        ),
        source,
      });
    }
  }
  return out;
}

function loadAllowlist() {
  let raw;
  try {
    raw = readFileSync(ALLOWLIST_PATH, "utf8");
  } catch (e) {
    throw new Error(`cannot read allowlist at .github/audit-allowlist.json: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`.github/audit-allowlist.json is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed?.entries)) {
    throw new Error(`.github/audit-allowlist.json must have an "entries" array`);
  }
  return parsed;
}

/* ------------------------------------------------------------------ *
 * Allowlist validation                                               *
 * ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;
const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? "")) && !Number.isNaN(Date.parse(s));

/** The UTC calendar day of a Date or a parseable date string. */
function utcDay(value) {
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

/**
 * The first day each advisory id appears in the allowlist's followed git history.
 * Dates are read as UTC calendar days, because a commit made late in a negative
 * offset is already the next day in UTC.
 *
 * A shallow repository, a failed git call or an unreadable allowlist throws.
 * The repository root comes from the script location, so the gate behaves the
 * same whatever directory it is run from.
 */
export function readAllowlistHistory(repoRoot = REPO_ROOT) {
  const allowlistPath = join(repoRoot, ".github", "audit-allowlist.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(allowlistPath, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${allowlistPath}: ${e.message}`);
  }
  if (!Array.isArray(parsed?.entries)) {
    throw new Error(`${allowlistPath} must have an "entries" array`);
  }

  const runGit = (args) => {
    const res = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", timeout: 120_000 });
    if (res.error) throw new Error(`git ${args[0]} failed: ${res.error.message}`);
    if (res.status !== 0) {
      throw new Error(`git ${args[0]} failed (exit ${res.status}): ${(res.stderr ?? "").trim()}`);
    }
    return res.stdout;
  };

  if (runGit(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new Error(
      `repository ${repoRoot} is shallow, so the allowlist history is incomplete. ` +
        "Fetch full history (fetch-depth: 0) before running the gate.",
    );
  }

  // Search a JSON ghsa field without trusting the casing of historical commits.
  const ids = new Map();
  for (const entry of parsed.entries) {
    const id = String(entry?.ghsa ?? "");
    if (id) ids.set(id.toUpperCase(), `GHSA-${id.slice(5).toLowerCase()}`);
  }
  if (ids.size > 1_000) throw new Error(`allowlist has ${ids.size} advisory ids; refusing to read history for more than 1000`);

  // A -G filter hides rename commits, so discover prior paths before searching.
  const paths = new Set([".github/audit-allowlist.json"]);
  const names = runGit(["log", "--follow", "--name-status", "--format=", "--", ".github/audit-allowlist.json"]);
  for (const line of names.split("\n")) {
    const rename = /^R\d+\t(.+)\t(.+)$/.exec(line);
    if (rename) paths.add(rename[1]);
  }

  const firstDays = new Map();
  for (const [key, id] of ids) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const out = runGit([
      "log",
      "--reverse",
      "--regexp-ignore-case",
      "--format=%cI",
      `-G"ghsa"[[:space:]]*:[[:space:]]*"${escapedId}"`,
      "--",
      ...paths,
    ]);
    const first = out.split("\n").map((line) => line.trim()).find(Boolean);
    if (!first) continue;
    const day = utcDayFromTimestamp(first);
    if (!day) throw new Error(`git returned an unparseable date for ${id}: ${first}`);
    firstDays.set(key, day);
  }
  return firstDays;
}

function utcDayFromTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/**
 * Each entry's `added` may not be later than the first day its advisory id
 * appears in the allowlist history. Moving it earlier is permitted. An id with
 * no search result must have been added no later than today.
 */
export function validateAllowlistHistory(allowlist, firstDays, today) {
  const problems = [];
  const todayDay = utcDay(today);
  (allowlist?.entries ?? []).forEach((entry, i) => {
    if (typeof entry?.ghsa !== "string" || !isIsoDate(entry?.added)) return;
    const id = entry.ghsa.toUpperCase();
    const boundary = firstDays.get(id) ?? todayDay;
    if (firstDays.has(id) && boundary > todayDay) {
      problems.push(`entry[${i}] (${entry.ghsa} / ${entry.package ?? "no package"}): first history day (${boundary}) is after today (${todayDay})`);
    }
    if (entry.added > todayDay) {
      problems.push(`entry[${i}] (${entry.ghsa} / ${entry.package ?? "no package"}): "added" (${entry.added}) is after today (${todayDay})`);
    }
    if (entry.added <= boundary) return;
    const bound =
      firstDays.has(id)
        ? `the first day this advisory appears in the allowlist history (${boundary})`
        : `today (${boundary}), and the history search found no advisory id`;
    problems.push(
      `entry[${i}] (${entry.ghsa} / ${entry.package ?? "no package"}): "added" (${entry.added}) is later than ${bound}. ` +
        "A renewal, a re-key or a delete-then-re-add does not restart the lifetime.",
    );
  });
  return problems;
}

/** A real calendar date: the parsed day formats back to the same string. */
function isCalendarDate(s) {
  if (!isIsoDate(s)) return false;
  return new Date(Date.parse(s)).toISOString().slice(0, 10) === s;
}

/**
 * Problems with an over-cap entry's approval, exactly as the plan defines it:
 * all four members, non-blank names and reasons, real dates, `approvedOn` <= today
 * < its `expires`, the entry not outliving it, and the approval itself no longer
 * than the severity cap.
 */
export function overCapApprovalProblems(entry, today, cap) {
  const approval = entry?.overCapApproval;
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    return ["no overCapApproval is present"];
  }
  const problems = [];
  for (const field of ["approvedBy", "reason", "approvedOn", "expires"]) {
    if (typeof approval[field] !== "string" || approval[field].trim() === "") {
      problems.push(`"overCapApproval.${field}" is required and must be non-blank`);
    }
  }
  if (problems.length) return problems;
  for (const field of ["approvedOn", "expires"]) {
    if (!isCalendarDate(approval[field])) problems.push(`"overCapApproval.${field}" must be a real calendar date (YYYY-MM-DD)`);
  }
  if (problems.length) return problems;

  const todayDay = utcDay(today);
  if (approval.approvedOn > todayDay) problems.push(`"overCapApproval.approvedOn" (${approval.approvedOn}) is after today (${todayDay})`);
  if (todayDay >= approval.expires) problems.push(`the over-cap approval EXPIRED on ${approval.expires}`);
  if (entry.expires > approval.expires) {
    problems.push(`the entry expires ${entry.expires}, after the approval's expiry ${approval.expires}`);
  }
  const approvalDays = Math.round((Date.parse(approval.expires) - Date.parse(approval.approvedOn)) / DAY_MS);
  if (approvalDays <= 0) {
    problems.push(`"overCapApproval.expires" (${approval.expires}) must be after "approvedOn" (${approval.approvedOn})`);
  } else if (approvalDays > cap) {
    problems.push(`the approval lasts ${approvalDays}d, beyond the ${cap}d cap for this severity`);
  }
  return problems;
}

export function validateAllowlist(allowlist, today) {
  const problems = [];
  const caps = allowlist?.policy?.maxLifetimeDaysBySeverity ?? {};
  const seenKeys = new Map();
  const singleSourceOwner = new Map();

  allowlist.entries.forEach((entry, i) => {
    const where = `entry[${i}] (${entry?.ghsa ?? "no ghsa"} / ${entry?.package ?? "no package"})`;

    for (const f of REQUIRED_ENTRY_FIELDS) {
      const v = entry?.[f];
      if (v === undefined || v === null || String(v).trim() === "") {
        problems.push(`${where}: missing required field "${f}"`);
      } else if (f !== "sources" && typeof v !== "string") {
        // String({}) is "[object Object]", so presence alone admitted an object,
        // and the bun admission path, which does not check introducedBy, then let
        // such an entry cover an advisory.
        problems.push(`${where}: "${f}" must be a string (found ${Array.isArray(v) ? "an array" : typeof v})`);
      }
    }
    if (problems.some((p) => p.startsWith(where))) return;

    if (!/^GHSA-[a-z0-9-]+$/i.test(entry.ghsa)) {
      problems.push(`${where}: "ghsa" must be a GHSA id`);
    } else if (!/^GHSA-[a-z0-9-]+$/.test(entry.ghsa)) {
      problems.push(`${where}: "ghsa" must use canonical casing (uppercase GHSA- prefix, lowercase remainder)`);
    }
    const key = entryKey(entry);
    const duplicateKey = seenKeys.has(key);
    if (duplicateKey) {
      problems.push(
        `${where}: duplicate entry for ${entry.ghsa} (entry[${seenKeys.get(key)}] has the same package, sources and introducedBy)`,
      );
    } else {
      seenKeys.set(key, i);
    }

    if (!VALID_CLASSES.has(entry.class)) {
      problems.push(
        `${where}: unknown class "${entry.class}" (expected one of ${[...VALID_CLASSES].join(", ")})`,
      );
    }
    if (!Array.isArray(entry.sources) || entry.sources.length === 0) {
      problems.push(`${where}: "sources" must be a non-empty array of ${[...VALID_SOURCES].map((v) => `"${v}"`).join(", ")}`);
    } else {
      for (const s of entry.sources) {
        if (!VALID_SOURCES.has(s)) {
          problems.push(`${where}: unknown source "${s}" (expected one of ${[...VALID_SOURCES].join(", ")})`);
        }
      }
      // One entry per (ghsa, package) on a source whose advisories carry no
      // per-chain location: two would both cover the same report.
      for (const s of new Set(entry.sources)) {
        if (!SINGLE_ENTRY_SOURCES.has(s) || duplicateKey) continue;
        const owner = JSON.stringify([String(entry.ghsa).toUpperCase(), entry.package, s]);
        if (singleSourceOwner.has(owner)) {
          const j = singleSourceOwner.get(owner);
          problems.push(
            `${where}: duplicate coverage — ${entryLabel(allowlist.entries[j], j)} and ${entryLabel(entry, i)} ` +
              `both cover ${entry.ghsa} (${entry.package}) in source "${s}"; at most one entry per advisory and package may name that source.`,
          );
        } else {
          singleSourceOwner.set(owner, i);
        }
      }
      // bun.lock resolves through this repository's root overrides, so its copy
      // is never in a tree we do not control: vendor-pinned is false there.
      if (entry.class === "vendor-pinned" && entry.sources.includes("bun")) {
        problems.push(
          `${where}: class "vendor-pinned" cannot cover source "bun": bun.lock resolves through this ` +
            `repository's root overrides, so the bun copy is not in a tree we do not control. Give the bun ` +
            `copy its own entry classed remediation-available or no-patch-published.`,
        );
      }
    }
    if (!isIsoDate(entry.added)) problems.push(`${where}: "added" must be YYYY-MM-DD`);
    if (!isIsoDate(entry.expires)) problems.push(`${where}: "expires" must be YYYY-MM-DD`);
    if (!isIsoDate(entry.added) || !isIsoDate(entry.expires)) return;
    if (entry.added > utcDay(today)) problems.push(`${where}: "added" (${entry.added}) is after today (${utcDay(today)})`);

    // An exception with no meaningful deadline is the defect this gate exists
    // to prevent, so the deadline is capped by severity and the cap is enforced
    // here rather than trusted to review.
    const lifetimeDays = Math.round((Date.parse(entry.expires) - Date.parse(entry.added)) / DAY_MS);
    if (lifetimeDays <= 0) {
      problems.push(`${where}: "expires" (${entry.expires}) must be after "added" (${entry.added})`);
    }
    const cap = caps[entry.severity];
    if (typeof cap !== "number") {
      problems.push(
        `${where}: no lifetime cap is configured for severity "${entry.severity}". Add it to ` +
          `policy.maxLifetimeDaysBySeverity; an entry without a cap cannot be admitted.`,
      );
    } else if (lifetimeDays > cap || entry.overCapApproval !== undefined) {
      const approvalProblems = overCapApprovalProblems(entry, today, cap);
      if (approvalProblems.length) {
        problems.push(
          `${where}: ${lifetimeDays > cap ? `lifetime ${lifetimeDays}d exceeds the ${cap}d cap for severity "${entry.severity}" and ` : ""}` +
            `its overCapApproval is not valid — ${approvalProblems.join("; ")}.`,
        );
      }
    }
    if (String(entry.removeWhen).trim().length < 20) {
      problems.push(
        `${where}: "removeWhen" must state the concrete condition that retires this entry`,
      );
    }
  });

  return problems;
}

/* ------------------------------------------------------------------ *
 * Fixability drift (check 7)                                          *
 * ------------------------------------------------------------------ */

/**
 * `encodeURIComponent`, not `pkg.replace("/", "%2F")` — a string-pattern
 * `replace` rewrites only the FIRST match, so it was a half-escape that happened
 * to be right only because npm names carry at most one slash. Encoding the whole
 * segment is the tool that actually fits the job and covers every character that
 * needs escaping. Verified against the registry: the fully-encoded scoped form
 * (%40scope%2Fname) resolves identically to the literal one.
 */
export function registryUrlFor(pkg) {
  return `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
}

/** An npm audit node naming this package below harper's node_modules tree. */
function harperNodeRoot(node, pkg) {
  if (
    typeof node !== "string" ||
    !node.startsWith("node_modules/") ||
    node.split("/").some((part) => !part || part === "." || part === "..") ||
    node.includes("\\") ||
    !node.endsWith(`/node_modules/${pkg}`)
  ) return null;
  const marker = "node_modules/harper/";
  const index = node.indexOf(marker);
  if (index < 0 || !node.slice(index + marker.length).startsWith("node_modules/")) return null;
  return node.slice(0, index + "node_modules/harper".length);
}

/**
 * The package name at the top of harper's node_modules tree for a reported node.
 * `node_modules/harper/node_modules/@scope/name/node_modules/x` starts at
 * `@scope/name`; a hoisted leaf such as `.../fast-uri` starts at `fast-uri`.
 */
function topLevelPackageUnderHarper(node, harperRoot) {
  const prefix = `${harperRoot}/node_modules/`;
  if (!node.startsWith(prefix)) return null;
  const parts = node.slice(prefix.length).split("/");
  if (!parts[0]) return null;
  if (!parts[0].startsWith("@")) return parts[0];
  return parts[1] ? `${parts[0]}/${parts[1]}` : null;
}

/**
 * The real path of `path`, which must lie inside harper's installed tree
 * (`realHarper`, the real path of harper's package directory). `label` names
 * the path in the error.
 */
function realPathInsideHarper(path, realHarper, label) {
  const real = realpathSync(path);
  if (real !== realHarper && !real.startsWith(`${realHarper}${sep}`)) {
    throw new Error(`${label} resolves outside harper's installed tree`);
  }
  return real;
}

/**
 * Applies `realPathInsideHarper` to each directory on `relPath` below
 * `harperDir`, from its first segment to its last. `relPath` is relative to
 * `harperDir`, and the error names the directory relative to it. Returns the
 * real path of the last directory.
 */
function directoriesInsideHarper(harperDir, relPath, realHarper) {
  const segments = relPath.split(/[\\/]/);
  let real = realHarper;
  for (let i = 1; i <= segments.length; i++) {
    const label = segments.slice(0, i).join("/");
    real = realPathInsideHarper(join(harperDir, label), realHarper, label);
  }
  return real;
}

/**
 * The node_modules directories Node's resolver searches for a package required
 * from `fromDir`, a real path at or below `realHarper`, cut off at harper's
 * directory: walking from `fromDir` up to and including `realHarper`, each
 * directory not itself named node_modules contributes its node_modules child.
 */
export function harperSearchPaths(fromDir, realHarper) {
  if (fromDir !== realHarper && !fromDir.startsWith(`${realHarper}${sep}`)) {
    throw new Error("a dependency search started outside harper's installed tree");
  }
  const paths = [];
  let dir = fromDir;
  while (true) {
    if (basename(dir) !== "node_modules") paths.push(join(dir, "node_modules"));
    if (dir === realHarper) return paths;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("a dependency search did not reach harper's directory");
    dir = parent;
  }
}

/** True for a dependency name shaped like an npm package name: `name` or `@scope/name`. */
function isPackageName(name) {
  return /^(?:@[^@/\\]+\/)?[^@/\\][^@/\\]*$/.test(name) &&
    !name.split("/").some((part) => part === "." || part === "..");
}

/**
 * Look up the package `name` required from `fromDir` (a real path at or below
 * `realHarper`) in `harperSearchPaths(fromDir, realHarper)`, in order: the
 * first search directory that holds `<name>/package.json` wins. A name that is
 * not shaped like a package name resolves to nothing. Once a package.json is
 * found, it and each directory from harper's directory down to its package
 * directory must resolve inside harper's installed tree, or this throws.
 * Returns the real paths of the package directory and its package.json, or null.
 */
export function resolveHarperDependency(fromDir, realHarper, name) {
  if (typeof name !== "string" || !isPackageName(name)) return null;
  for (const searchDir of harperSearchPaths(fromDir, realHarper)) {
    const relPath = relative(realHarper, join(searchDir, name));
    // Walk installed manifests, not runtime imports: a package may export
    // subpaths without exporting its bare name.
    let manifest;
    try {
      manifest = realPathInsideHarper(join(realHarper, relPath, "package.json"), realHarper, `${relPath}/package.json`);
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") continue;
      throw e;
    }
    return { dir: directoriesInsideHarper(realHarper, relPath, realHarper), manifest };
  }
  return null;
}

/** Read and parse a package.json under harper; an unreadable or invalid one throws a named error. */
function readHarperManifest(manifestPath, name) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(`harper's package.json for ${JSON.stringify(name)} cannot be read or parsed: ${e.message}`);
  }
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
    throw new Error(`harper's package.json for ${JSON.stringify(name)} is not a JSON object`);
  }
  return pkg;
}

/**
 * Whether harper's top-level package `target` is one of the bundled packages
 * `roots` or in their dependency closure. npm ships each bundled package's
 * dependency closure inside the tarball too; closure members may be hoisted to
 * the top level of harper's tree (for example fast-uri through fastify) or
 * nested below it. Each dependency is resolved with `resolveHarperDependency`
 * from the real path of the package that requires it, before it is compared
 * with the target, and it matches only when it resolves to the real path of
 * `node_modules/<target>` at harper's top level. Missing dependencies are
 * skipped; their absence does not enlarge the bundled set. The walk makes at
 * most `limit` lookups, the bundled packages included, and throws past that.
 */
function harperBundleIncludes(harperDir, roots, target, limit = 5000) {
  const realHarper = realpathSync(harperDir);
  const targetDir = resolveHarperDependency(realHarper, realHarper, target)?.dir;
  if (!targetDir) return false;
  const seen = new Set();
  const queue = [];
  let lookups = 0;
  const reaches = (from, name) => {
    if (++lookups > limit) {
      throw new Error(`dependency closure for harper's bundled packages exceeded ${limit} lookups`);
    }
    const found = resolveHarperDependency(from, realHarper, name);
    if (!found) return false;
    if (name === target && found.dir === targetDir) {
      readHarperManifest(found.manifest, target);
      return true;
    }
    if (seen.has(found.dir)) return false;
    seen.add(found.dir);
    queue.push(found);
    return false;
  };
  for (const name of roots) {
    if (reaches(realHarper, name)) return true;
  }
  while (queue.length) {
    const { dir, manifest } = queue.shift();
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    for (const dep of Object.keys({ ...pkg.optionalDependencies, ...pkg.dependencies })) {
      if (reaches(dir, dep)) return true;
    }
  }
  return false;
}

/**
 * Evidence that harper shipped a node.
 * Releases that ship npm-shrinkwrap.json are checked against its pin, unchanged.
 * A release without one requires both the consumer install's package-lock
 * (`inBundle: true` plus the recorded version) and harper's installed
 * package.json `bundleDependencies` (or `bundledDependencies`; `true` means the
 * packages in harper's `dependencies`). Anything else throws, and the caller blocks.
 */
function harperShippedVersion(npmPrefix, harperRoot, node) {
  const pinKey = node.slice(harperRoot.length + 1);
  let shrinkwrapText = null;
  try {
    shrinkwrapText = readFileSync(join(npmPrefix, harperRoot, "npm-shrinkwrap.json"), "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (shrinkwrapText !== null) {
    const shrinkwrap = JSON.parse(shrinkwrapText);
    const pinned = shrinkwrap?.packages?.[pinKey]?.version;
    if (typeof pinned !== "string" || !pinned) throw new Error(`missing or invalid version for ${pinKey}`);
    return { version: pinned, label: "harper's shrinkwrap pins" };
  }

  const lock = JSON.parse(readFileSync(join(npmPrefix, "package-lock.json"), "utf8"));
  const entry = lock?.packages?.[node];
  if (!entry || typeof entry !== "object") {
    throw new Error(`the consumer package-lock has no entry for ${pinKey}`);
  }
  if (entry.inBundle !== true) {
    throw new Error(`the consumer package-lock does not mark ${pinKey} as inBundle`);
  }
  const recorded = entry.version;
  if (typeof recorded !== "string" || !recorded) throw new Error(`missing or invalid version for ${pinKey}`);

  const harperManifest = JSON.parse(readFileSync(join(npmPrefix, harperRoot, "package.json"), "utf8"));
  const declared = harperManifest?.bundleDependencies ?? harperManifest?.bundledDependencies;
  const topLevel = topLevelPackageUnderHarper(node, harperRoot);
  if (!topLevel) throw new Error(`cannot identify the top-level package under harper for ${pinKey}`);
  let roots;
  if (declared === true) {
    const dependencies = harperManifest.dependencies ?? {};
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
      throw new Error("harper's package.json sets bundleDependencies to true but its dependencies field is not an object");
    }
    roots = Object.keys(dependencies);
  } else if (Array.isArray(declared)) {
    roots = declared.filter((name) => typeof name === "string" && name);
  } else {
    throw new Error("harper's package.json declares no bundleDependencies");
  }
  const harperDir = join(npmPrefix, harperRoot);
  const realHarper = realpathSync(harperDir);
  if (!resolveHarperDependency(realHarper, realHarper, topLevel)) {
    throw new Error(`harper's tree has no package.json for ${JSON.stringify(topLevel)}`);
  }
  if (!harperBundleIncludes(harperDir, roots, topLevel)) {
    throw new Error(
      declared === true
        ? `${JSON.stringify(topLevel)} is not in harper's dependencies (bundleDependencies is true) and is not in their dependency closure`
        : `${JSON.stringify(topLevel)} is not listed in harper's bundleDependencies and is not in a bundled package's dependency closure`,
    );
  }
  return { version: recorded, label: "the consumer package-lock records" };
}

/** True unless harper's npm-shrinkwrap.json is missing; harperShippedVersion branches on the same read. */
function harperShrinkwrapDecides(npmPrefix, harperRoot) {
  try {
    readFileSync(join(npmPrefix, harperRoot, "npm-shrinkwrap.json"));
    return true;
  } catch (e) {
    return e.code !== "ENOENT";
  }
}

/**
 * For a vendor-pinned exception, reject any npm-audit-reported node path outside
 * harper. When all reported paths are under harper, compare each installed version
 * and any audit-reported version with the version harper shipped it at: the
 * shrinkwrap pin for releases that carry one, otherwise the bundle evidence in the
 * consumer install's package-lock and harper's package.json. Empty node lists,
 * a node package.json, package directory or directory between harper's and it
 * whose real path is outside harper's installed tree, unreadable required
 * metadata, and version mismatches block the gate; errors name a node when one
 * was reported.
 */
export function vendorPinnedNodeProblems(adv, npmPrefix) {
  const nodes = adv.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return [`${adv.ghsa} (${adv.package}): npm audit reported no nodes. Inspect the npm-install audit report; the vendor-pinned entry cannot cover unknown nodes.`];
  }
  const isHarperNode = (node) => harperNodeRoot(node, adv.package) !== null;
  if (!nodes.every(isHarperNode)) {
    return nodes.filter((node) => !isHarperNode(node)).map((node) =>
      `${adv.ghsa} (${adv.package}): node ${JSON.stringify(node)} is outside harper's dependency path. Fix the dependency, or extend the allowlist schema and add a separate, justified entry scoped to that node.`,
    );
  }

  const problems = [];
  for (const node of nodes.filter(isHarperNode)) {
    const harperRoot = harperNodeRoot(node, adv.package);
    const pinKey = node.slice(harperRoot.length + 1);
    try {
      const harperDir = join(npmPrefix, harperRoot);
      const realHarper = realpathSync(harperDir);
      const manifest = realPathInsideHarper(join(npmPrefix, node, "package.json"), realHarper, `${pinKey}/package.json`);
      directoriesInsideHarper(harperDir, pinKey, realHarper);
      const installed = JSON.parse(readFileSync(manifest, "utf8"))?.version;
      const reported = adv.nodeVersions?.[node];
      if (typeof installed !== "string" || !installed ||
          (reported !== undefined && (typeof reported !== "string" || !reported))) {
        throw new Error(`missing or invalid version for ${pinKey}`);
      }
      const shipped = harperShippedVersion(npmPrefix, harperRoot, node);
      if (installed !== shipped.version || (reported !== undefined && reported !== shipped.version)) {
        problems.push(
          `${adv.ghsa} (${adv.package}): node ${JSON.stringify(node)} has installed version ${installed}` +
            `${reported === undefined ? "" : `, audit version ${reported}`}, but ${shipped.label} ${shipped.version}. Fix the dependency, or extend the allowlist schema and add a separate, justified entry scoped to that node.`,
        );
      }
    } catch (e) {
      const remedy = harperShrinkwrapDecides(npmPrefix, harperRoot)
        ? "Restore readable package and shrinkwrap evidence, then rerun the gate."
        : "Without npm-shrinkwrap.json in harper, restore a readable installed package.json, a consumer package-lock that marks the node inBundle, and a harper package.json whose bundleDependencies (true for all of its dependencies) names the node's top-level package or a package whose dependency closure contains it, then rerun the gate.";
      problems.push(
        `${adv.ghsa} (${adv.package}): cannot verify node ${JSON.stringify(node)} against harper's npm-shrinkwrap.json or its bundleDependencies listing: ${e.message}. ${remedy}`,
      );
    }
  }
  return problems;
}

/**
 * The install-relative node that `entry.introducedBy` resolves to in the
 * consumer install at `npmPrefix` for `input`. The chain must start at the
 * input's package (then its `vendor`, when set) and end at `advPackage`; each
 * later link must be a declared dependency of the one before it and resolve on
 * disk, found by walking up from the requiring package's directory. Throws on
 * any break in the chain.
 */
function consumerChainNode(npmPrefix, entry, input, advPackage) {
  const chain = entry.introducedBy.split(" -> ");
  if (chain.length < 2 || chain[0] !== input.package ||
      (input.vendor !== undefined && chain[1] !== input.vendor) ||
      chain.at(-1) !== advPackage ||
      !chain.every((pkg) => /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pkg))) {
    throw new Error(`invalid ${input.package} dependency chain`);
  }
  const prefix = resolve(npmPrefix);
  let parent = prefix;
  let manifest;
  for (const pkg of chain) {
    if (manifest && !Object.hasOwn(manifest.dependencies ?? {}, pkg)) {
      throw new Error(`${manifest.name} does not depend on ${pkg}`);
    }
    let search = parent;
    while (!existsSync(join(search, "node_modules", pkg, "package.json"))) {
      if (search === prefix) throw new Error(`cannot resolve ${pkg}`);
      search = dirname(search);
    }
    parent = join(search, "node_modules", pkg);
    manifest = JSON.parse(readFileSync(join(parent, "package.json"), "utf8"));
    if (manifest.name !== pkg) throw new Error(`package name mismatch for ${pkg}`);
  }
  return relative(prefix, parent).split("\\").join("/");
}

/**
 * The version problems of `node`, a node an entry's chain resolves to: the
 * installed version must equal the entry's `version`, and an audit-reported
 * version must equal the installed one.
 */
function consumerNodeVersionProblems(adv, npmPrefix, entry, input, node) {
  const prefix = resolve(npmPrefix);
  try {
    const installed = JSON.parse(readFileSync(join(prefix, node, "package.json"), "utf8"))?.version;
    const reported = adv.nodeVersions?.[node];
    if (typeof entry.version !== "string" || !entry.version.trim()) {
      throw new Error("missing or invalid allowlist version");
    }
    if (typeof installed !== "string" || !installed.trim()) {
      throw new Error("missing or invalid installed version");
    }
    if (installed !== entry.version) {
      throw new Error(`installed version ${installed} differs from allowlist version ${entry.version}`);
    }
    if (reported !== undefined && reported !== installed) {
      throw new Error(`audit version ${JSON.stringify(reported)} conflicts with installed version ${installed}`);
    }
    return [];
  } catch (e) {
    return [`${adv.ghsa} (${adv.package}): cannot verify ${input.package} node ${JSON.stringify(node)} version: ${e.message}.`];
  }
}

/**
 * For a vendor-pinned entry on a consumer-install observation other than the
 * root tarball's, when it is the only entry for its advisory: the entry's
 * `introducedBy` chain must resolve (`consumerChainNode`), every reported node
 * must be the chain's resolved node, and the installed version must equal the
 * entry's `version` (`consumerNodeVersionProblems`).
 */
function consumerVendorPinnedNodeProblems(adv, npmPrefix, entry, input) {
  if (!Array.isArray(adv.nodes) || adv.nodes.length === 0) {
    return [`${adv.ghsa} (${adv.package}): npm audit reported no nodes.`];
  }
  let expected;
  try {
    expected = consumerChainNode(npmPrefix, entry, input, adv.package);
  } catch (e) {
    return [`${adv.ghsa} (${adv.package}): cannot verify ${input.package} dependency chain: ${e.message}.`];
  }
  return adv.nodes.flatMap((node) =>
    node !== expected
      ? [`${adv.ghsa} (${adv.package}): node ${JSON.stringify(node)} is outside the dependency chain ${entry.introducedBy} (resolved node ${expected}).`]
      : consumerNodeVersionProblems(adv, npmPrefix, entry, input, node));
}

async function latestPublishedVersion(pkg) {
  const url = registryUrlFor(pkg);
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`registry returned HTTP ${res.status} for ${pkg}`);
  const body = await res.json();
  if (!body?.version) throw new Error(`registry response for ${pkg} had no version field`);
  return body.version;
}

/* ------------------------------------------------------------------ *
 * Consumer-install prefix identity                                    *
 * ------------------------------------------------------------------ */

/**
 * The workspace manifest the job packs for `input` (`<repo>/<dir>/package.json`,
 * the file `npm pack` reads): its path, its version and its `dependencies` (an
 * empty object when it has none). Throws when that manifest cannot be read,
 * names a different package, has no version, or has a `dependencies` field
 * that is not an object of string specs.
 */
export function packedManifest(repoRoot, input) {
  const rel = join(input.dir, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(repoRoot, rel), "utf8"));
  } catch (e) {
    throw new Error(`cannot read the workspace manifest ${rel} the job packs for ${input.flag}: ${e.message}`);
  }
  if (manifest?.name !== input.package) {
    throw new Error(`the workspace manifest ${rel} names ${JSON.stringify(manifest?.name)}, expected ${input.package}`);
  }
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error(`the workspace manifest ${rel} has no version`);
  }
  const dependencies = manifest.dependencies === undefined ? {} : manifest.dependencies;
  if (!isObject(dependencies) || !Object.values(dependencies).every((spec) => typeof spec === "string")) {
    throw new Error(`the workspace manifest ${rel} has a "dependencies" field that is not an object of string specs`);
  }
  return { path: rel, version: manifest.version, dependencies };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The prefix's direct dependencies as its package-lock.json records them, for refusal messages. */
function directDependencies(lock) {
  const deps = Object.keys(lock?.packages?.[""]?.dependencies ?? {});
  return deps.length ? `direct dependencies ${deps.join(", ")}` : "no direct dependencies";
}

/** A spec that installs a local tarball, as npm records one in a consumer's package.json and lockfile. */
function isLocalTarballSpec(spec) {
  return typeof spec === "string" && spec.startsWith("file:") && spec.endsWith(".tgz");
}

/** The root dependency fields other than `dependencies`; the package must be in none of them. */
const NON_PRODUCTION_FIELDS = ["devDependencies", "optionalDependencies", "peerDependencies"];

/** Lock-row flags of a node that is not a production dependency of the root. */
const NON_PRODUCTION_FLAGS = ["dev", "optional", "devOptional", "peer", "extraneous"];

/**
 * What is wrong with `root` (the consumer's package.json, or the "" row of its
 * package-lock.json, named `where`) as a root that depends on `name` in
 * production from a local tarball.
 */
function productionLinkProblems(where, root, name) {
  if (!isObject(root)) return [`${where} has no root package record`];
  const problems = [];
  const spec = isObject(root.dependencies) && Object.hasOwn(root.dependencies, name)
    ? root.dependencies[name]
    : undefined;
  if (!isLocalTarballSpec(spec)) {
    problems.push(`${where} does not name it in "dependencies" from a local .tgz (found ${JSON.stringify(spec ?? null)})`);
  }
  for (const field of NON_PRODUCTION_FIELDS) {
    if (isObject(root[field]) && Object.hasOwn(root[field], name)) {
      problems.push(`${where} also names it in "${field}"`);
    }
  }
  return problems;
}

/**
 * How a `dependencies` field `found` differs from the workspace manifest's
 * `expected`, as a list (empty when both declare the same names with the same
 * specs). An absent field is an empty one.
 */
function dependencyDifferences(found, expected) {
  const actual = found === undefined ? {} : found;
  if (!isObject(actual)) return [`"dependencies" is ${JSON.stringify(actual)}, not an object`];
  const differences = [];
  for (const [dep, spec] of Object.entries(expected)) {
    if (!Object.hasOwn(actual, dep)) differences.push(`${dep} is missing (expected ${JSON.stringify(spec)})`);
    else if (actual[dep] !== spec) differences.push(`${dep} is ${JSON.stringify(actual[dep])} (expected ${JSON.stringify(spec)})`);
  }
  for (const dep of Object.keys(actual)) {
    if (!Object.hasOwn(expected, dep)) differences.push(`${dep} ${JSON.stringify(actual[dep])} is not in the workspace manifest`);
  }
  return differences;
}

/**
 * What is wrong with `prefix` as an npm install of the packed tarball of
 * `name`, against `packed` (the workspace manifest the job packs, from
 * `packedManifest`), as a list (empty when nothing is). The prefix must hold:
 *
 *   - `node_modules/<name>/package.json` with that name and version;
 *   - a package-lock.json (the tree `npm audit` reads) that records
 *     `node_modules/<name>` at that version, resolved from a local `.tgz`;
 *   - a package.json, and a package-lock.json "" row, that name the package in
 *     `dependencies` with a local `.tgz` spec and in none of
 *     `NON_PRODUCTION_FIELDS`, and a `node_modules/<name>` lock row with none
 *     of `NON_PRODUCTION_FLAGS`;
 *   - in both the installed package.json and that lock row, the same
 *     `dependencies` names and specs as the workspace manifest.
 *
 * An unreadable or unparseable file is a problem, never a pass.
 */
export function prefixIdentityProblems(prefix, name, packed) {
  const { version } = packed;
  const problems = [];
  let lock;
  try {
    lock = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8"));
  } catch (e) {
    problems.push(`no readable package-lock.json (${e.code ?? e.message})`);
  }
  let installed;
  try {
    installed = JSON.parse(readFileSync(join(prefix, "node_modules", name, "package.json"), "utf8"));
  } catch (e) {
    problems.push(`no readable node_modules/${name}/package.json (${e.code ?? e.message})`);
  }
  let consumer;
  try {
    consumer = JSON.parse(readFileSync(join(prefix, "package.json"), "utf8"));
  } catch (e) {
    problems.push(`no readable package.json (${e.code ?? e.message})`);
  }
  const row = lock?.packages?.[`node_modules/${name}`];
  if (installed !== undefined) {
    if (installed?.name !== name) {
      problems.push(`node_modules/${name}/package.json names ${JSON.stringify(installed?.name)}`);
    }
    if (installed?.version !== version) {
      problems.push(`node_modules/${name}/package.json has version ${JSON.stringify(installed?.version)}`);
    }
  }
  if (lock !== undefined) {
    if (!isObject(row)) {
      problems.push(`package-lock.json has no "node_modules/${name}" entry; found ${directDependencies(lock)}`);
    } else {
      if (row.version !== version) {
        problems.push(`package-lock.json records version ${JSON.stringify(row.version)}`);
      }
      if (!isLocalTarballSpec(row.resolved)) {
        problems.push(`package-lock.json resolves it from ${JSON.stringify(row.resolved ?? null)}, not a local .tgz`);
      }
    }
  }

  // Production linkage: the consumer depends on the package in production.
  if (consumer !== undefined) problems.push(...productionLinkProblems("package.json", consumer, name));
  if (lock !== undefined) {
    problems.push(...productionLinkProblems('package-lock.json\'s "" row', lock?.packages?.[""], name));
    if (isObject(row)) {
      for (const flag of NON_PRODUCTION_FLAGS) {
        if (row[flag] !== undefined && row[flag] !== false) {
          problems.push(`package-lock.json marks "node_modules/${name}" ${JSON.stringify(flag)}: ${JSON.stringify(row[flag])}`);
        }
      }
    }
  }

  // Dependency declarations: the installed package declares what the workspace manifest does.
  const declarations = [];
  if (isObject(installed)) declarations.push([`node_modules/${name}/package.json`, installed.dependencies]);
  if (isObject(row)) declarations.push([`package-lock.json's "node_modules/${name}" row`, row.dependencies]);
  for (const [where, found] of declarations) {
    const differences = dependencyDifferences(found, packed.dependencies);
    if (differences.length) {
      problems.push(`${where} declares dependencies that differ from ${packed.path}: ${differences.join(", ")}`);
    }
  }
  return problems;
}

/** A prefix's real path, or its resolved path when it does not exist (it then fails the identity check). */
function canonicalPrefix(prefix) {
  try {
    return realpathSync(prefix);
  } catch {
    return resolve(prefix);
  }
}

/* ------------------------------------------------------------------ *
 * Main                                                                *
 * ------------------------------------------------------------------ */

const SEVERITY_ORDER = { critical: 0, high: 1, moderate: 2, low: 3, info: 4, unknown: 5 };

async function main() {
  const today = new Date(process.env.AUDIT_GATE_TODAY || Date.now());
  if (Number.isNaN(today.getTime())) {
    console.error("AUDIT_GATE_TODAY is not a parseable date");
    process.exit(2);
  }
  const todayStr = today.toISOString().slice(0, 10);

  // Every consumer-install input is a MANDATORY flag. The gate refuses to run
  // without each one: a PR whose tarball lane is skipped or optional would merge
  // with that observation never made, and a check that can be skipped is not a
  // check.
  const prefixes = new Map();
  const missing = [];
  for (const input of CONSUMER_INSTALLS) {
    const idx = process.argv.indexOf(input.flag);
    const value = idx !== -1 ? process.argv[idx + 1] : undefined;
    if (!value || value.startsWith("--")) missing.push(input);
    else prefixes.set(input.source, value);
  }
  for (const input of missing) {
    console.error(
      input.source === "npm-install"
        ? `DEPENDENCY AUDIT GATE: missing --npm-install-prefix <dir> — the published ${input.package} package's npm-install observation is mandatory; the gate refuses to run bun-only.`
        : `DEPENDENCY AUDIT GATE: missing ${input.flag} <dir> — the published ${input.package} package's consumer-install observation is mandatory; the gate refuses to run without it.`,
    );
  }
  if (missing.length) process.exit(2);

  // Each prefix must be its own install and pass prefixIdentityProblems
  // against the workspace manifest the job packs for its flag. A prefix of
  // another package, a dev-only install, an archive whose dependencies differ
  // from that manifest, or one prefix passed twice is refused before any audit
  // runs.
  const identityProblems = [];
  const prefixOwner = new Map();
  for (const input of CONSUMER_INSTALLS) {
    const prefix = prefixes.get(input.source);
    const key = canonicalPrefix(prefix);
    if (prefixOwner.has(key)) {
      identityProblems.push(
        `${prefixOwner.get(key)} and ${input.flag} name the same prefix ${prefix}; each consumer-install input needs its own install.`,
      );
      continue;
    }
    prefixOwner.set(key, input.flag);
    let packed;
    try {
      packed = packedManifest(REPO_ROOT, input);
    } catch (e) {
      identityProblems.push(`${e.message}.`);
      continue;
    }
    const found = prefixIdentityProblems(prefix, input.package, packed);
    if (found.length) {
      identityProblems.push(
        `${input.flag} ${prefix} is not an npm install of the packed ${input.package}@${packed.version}: ${found.join("; ")}.`,
      );
    }
  }
  for (const problem of identityProblems) console.error(`DEPENDENCY AUDIT GATE: ${problem}`);
  if (identityProblems.length) process.exit(2);

  let allowlist;
  let firstDays;
  let advisories;
  try {
    allowlist = loadAllowlist();
  } catch (e) {
    console.error(`\n  DEPENDENCY AUDIT GATE: FAILED TO RUN\n\n  ${e.message}\n`);
    console.error("  The gate fails closed: an audit that cannot run is not an audit that passed.\n");
    process.exit(1);
  }
  try {
    firstDays = readAllowlistHistory(REPO_ROOT);
  } catch (e) {
    console.error(`\n  DEPENDENCY AUDIT GATE: FAILED TO READ ALLOWLIST HISTORY\n\n  ${e.message}\n`);
    console.error(
      "  The gate fails closed: an unknown history is not evidence that an advisory is new.\n" +
        "  Full history is required; the audit job checks out with fetch-depth: 0.\n",
    );
    process.exit(1);
  }
  try {
    advisories = flattenAdvisories(runBunAudit());
    for (const input of CONSUMER_INSTALLS) {
      advisories = advisories.concat(
        flattenNpmAdvisories(runNpmAudit(prefixes.get(input.source)), input.source),
      );
    }
  } catch (e) {
    console.error(`\n  DEPENDENCY AUDIT GATE: FAILED TO RUN\n\n  ${e.message}\n`);
    console.error("  The gate fails closed: an audit that cannot run is not an audit that passed.\n");
    process.exit(1);
  }

  advisories.sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
      a.package.localeCompare(b.package),
  );

  const schemaProblems = validateAllowlist(allowlist, today);
  for (const p of schemaProblems) fail(`allowlist is malformed — ${p}`);
  const historyProblems = validateAllowlistHistory(allowlist, firstDays, today);
  for (const p of historyProblems) fail(`allowlist history/date invalid — ${p}`);
  // Matching against a malformed allowlist can admit an entry the schema check
  // refused, and the summary would count it as allowlisted. Report and stop.
  if (schemaProblems.length || historyProblems.length) {
    console.log("\n  The allowlist is malformed; no advisory was matched against it.\n");
    reportFailuresAndExit();
  }

  // Every entry for a GHSA, in file order. A GHSA with one entry is matched as
  // it always was; one with several is matched per source and per location.
  const entriesByGhsa = new Map();
  allowlist.entries.forEach((entry, index) => {
    if (!entry?.ghsa) return;
    const g = String(entry.ghsa).toUpperCase();
    if (!entriesByGhsa.has(g)) entriesByGhsa.set(g, []);
    entriesByGhsa.get(g).push({ entry, index });
  });

  // The sources in which each entry (by index) covers a reported advisory.
  const coveredBy = new Map();
  const cover = (index, source) => {
    if (!coveredBy.has(index)) coveredBy.set(index, new Set());
    coveredBy.get(index).add(source);
  };
  const allowed = [];
  const blocked = [];

  /**
   * The checks every covering entry passes: package, severity, expiry, and the
   * vendor-pinned and harper evidence for its source. `chainChecked` skips the
   * consumer-install chain check when the caller already matched the node.
   * `index` is set when the entry's GHSA has sibling entries; diagnostics then
   * name the entry. Records each failure; returns whether the entry admits the
   * advisory.
   */
  const admit = (adv, entry, chainChecked = false, index = undefined) => {
    const named = index === undefined ? `allowlist entry ${entry.ghsa}` : `allowlist ${entryLabel(entry, index)}`;
    const namedPkg = index === undefined ? `allowlist entry ${entry.ghsa} (${entry.package})` : named;
    if (entry.package !== adv.package) {
      fail(
        `${named} says package "${entry.package}" but the advisory is against ` +
          `"${adv.package}". Correct the entry.`,
      );
      return false;
    }
    if (entry.severity !== adv.severity) {
      fail(
        `${named} records severity "${entry.severity}" but the advisory is now ` +
          `"${adv.severity}". Re-assess it against the severity expiry cap, then update the entry.`,
      );
      return false;
    }

    // Expiry. This is the mechanism working, not a malfunction.
    if (todayStr >= entry.expires) {
      fail(
        `${index === undefined ? `allowlist entry ${entry.ghsa} (${entry.package}, ${entry.severity})` : `${named} (${entry.severity})`} EXPIRED on ${entry.expires}.\n` +
          `      Original reason: ${entry.reason}\n` +
          `      Retires when:    ${entry.removeWhen}\n` +
          `      A human must now re-decide: fix it, or re-justify with a new date.`,
      );
      return false;
    }

    if (entry.class === "vendor-pinned" && adv.source !== "bun" && !chainChecked) {
      const nodeProblems = adv.source === "npm-install"
        ? vendorPinnedNodeProblems(adv, prefixes.get(adv.source))
        : consumerVendorPinnedNodeProblems(
            adv,
            prefixes.get(adv.source),
            entry,
            CONSUMER_INSTALLS.find((input) => input.source === adv.source),
          );
      if (nodeProblems.length) {
        for (const problem of nodeProblems) fail(problem);
        return false;
      }
    }

    // Classification — vendor-pinned under harper. An entry whose advisory the
    // npm observation reports under node_modules/harper/ must say so. Only an
    // entry classed vendor-pinned has its nodes checked against harper's
    // shipped evidence (above). The label is DERIVED from the nodes, not a
    // typed class: the entry's `class` stays whatever it is (vendor-pinned for
    // a patched-but-pinned leaf, no-patch-published for an unmaintained one
    // like validate.js).
    if (
      adv.source === "npm-install" &&
      (adv.nodes ?? []).some((n) => n.includes("node_modules/harper/"))
    ) {
      if (!String(entry.introducedBy ?? "").startsWith("harper -> ")) {
        fail(
          `${namedPkg} is vendor-pinned under harper but its ` +
            `introducedBy ("${entry.introducedBy}") does not start with "harper -> ". Fix it.`,
        );
        return false;
      }
      if (!/harper/i.test(String(entry.removeWhen ?? ""))) {
        fail(
          `${namedPkg} is vendor-pinned under harper but its ` +
            `removeWhen ("${entry.removeWhen}") does not name a harper version. Fix it.`,
        );
        return false;
      }
    }
    return true;
  };

  const allow = (adv, entry) => {
    allowed.push({ adv, entry });
    const daysLeft = Math.ceil((Date.parse(entry.expires) - today.getTime()) / DAY_MS);
    if (daysLeft <= 14) {
      warn(`${entry.ghsa} (${entry.package}) expires in ${daysLeft}d on ${entry.expires}.`);
    }
  };

  for (const adv of advisories) {
    if (!adv.ghsa) {
      fail(
        `${adv.package}: advisory "${adv.title}" has no GHSA id in its url (${adv.url || "none"}) ` +
          `and therefore cannot be allowlisted. Investigate manually.`,
      );
      blocked.push(adv);
      continue;
    }
    const candidates = entriesByGhsa.get(adv.ghsa.toUpperCase()) ?? [];
    if (candidates.length === 0) {
      blocked.push(adv);
      fail(
        `${adv.severity.toUpperCase()} ${adv.ghsa} in ${adv.package} (${adv.vulnerableVersions}) ` +
          `is NOT allowlisted.\n      ${adv.title}\n      ${adv.url}\n` +
          `      Fix it, or add a justified, dated entry to .github/audit-allowlist.json.`,
      );
      continue;
    }

    // One entry for this GHSA: it covers the advisory wherever it is observed,
    // and the source and package checks below report any mismatch.
    if (candidates.length === 1) {
      const { entry, index } = candidates[0];
      cover(index, adv.source);
      if (admit(adv, entry)) allow(adv, entry);
      else blocked.push(adv);
      continue;
    }

    // Several entries: only an entry for this package that names this source
    // can cover it.
    const named = candidates.filter(({ entry }) =>
      entry.package === adv.package && Array.isArray(entry.sources) && entry.sources.includes(adv.source));
    if (named.length === 0) {
      blocked.push(adv);
      fail(
        `${adv.severity.toUpperCase()} ${adv.ghsa} in ${adv.package} (${adv.vulnerableVersions}) ` +
          `is NOT allowlisted in source [${adv.source}]: none of the ${candidates.length} entries for ` +
          `${adv.ghsa} names that source for package "${adv.package}".\n      ${adv.title}\n      ${adv.url}\n` +
          `      Fix it, or add a justified, dated entry to .github/audit-allowlist.json.`,
      );
      continue;
    }

    // bun and the root npm-install observation: exactly one entry per
    // (ghsa, package) for the source.
    if (SINGLE_ENTRY_SOURCES.has(adv.source)) {
      if (named.length > 1) {
        blocked.push(adv);
        fail(
          `${adv.ghsa} (${adv.package}): duplicate coverage — ${named.map(({ entry, index }) => entryLabel(entry, index)).join(" and ")} ` +
            `all cover source "${adv.source}"; at most one entry per advisory and package may name it.`,
        );
        continue;
      }
      const { entry, index } = named[0];
      cover(index, adv.source);
      if (admit(adv, entry, false, index)) allow(adv, entry);
      else blocked.push(adv);
      continue;
    }

    // A consumer-install observation: each entry's chain resolves to one node,
    // and every reported node must be the node of exactly one entry.
    const input = CONSUMER_INSTALLS.find((i) => i.source === adv.source);
    const prefix = prefixes.get(adv.source);
    const problems = [];
    const resolved = [];
    for (const { entry, index } of named) {
      try {
        resolved.push({ entry, index, node: consumerChainNode(prefix, entry, input, adv.package) });
      } catch (e) {
        problems.push(
          `${adv.ghsa} (${adv.package}): ${entryLabel(entry, index)} cannot verify its ${input.package} dependency chain: ${e.message}.`,
        );
      }
    }
    const nodes = Array.isArray(adv.nodes) ? adv.nodes : [];
    if (nodes.length === 0) problems.push(`${adv.ghsa} (${adv.package}): npm audit reported no nodes.`);
    const covering = new Map();
    for (const node of nodes) {
      const matches = resolved.filter((r) => r.node === node);
      if (matches.length === 0) {
        problems.push(
          `${adv.ghsa} (${adv.package}): node ${JSON.stringify(node)} in ${adv.source} is covered by no allowlist entry ` +
            `(the entries' chains resolve to ${resolved.map((r) => r.node).join(", ") || "no node"}).`,
        );
        continue;
      }
      if (matches.length > 1) {
        problems.push(
          `${adv.ghsa} (${adv.package}): duplicate coverage — ${matches.map((m) => entryLabel(m.entry, m.index)).join(" and ")} ` +
            `all resolve to node ${JSON.stringify(node)} in ${adv.source}.`,
        );
        continue;
      }
      const [{ entry, index }] = matches;
      cover(index, adv.source);
      problems.push(...consumerNodeVersionProblems(adv, prefix, entry, input, node));
      covering.set(index, entry);
    }
    let admitted = problems.length === 0;
    for (const problem of problems) fail(problem);
    for (const [index, entry] of covering) {
      if (!admit(adv, entry, true, index)) admitted = false;
    }
    if (!admitted) {
      blocked.push(adv);
      continue;
    }
    for (const entry of covering.values()) allow(adv, entry);
  }

  // Check 6 — staleness + sources mismatch, per entry.
  //
  // A run that reaches this point has run `bun audit` and, on every
  // consumer-install prefix (each passed the identity check above), `npm audit
  // --omit=dev`, so each source an entry can declare has a report. An entry is
  // STALE when it covers a reported advisory in no source at all; a SOURCES
  // MISMATCH when the sources it covers and the sources it declares do not
  // agree in either direction. An entry whose GHSA has sibling entries covers
  // only the sources (and, on a consumer install, the nodes) it was matched
  // to, so a live sibling never keeps it.
  allowlist.entries.forEach((entry, index) => {
    if (!entry?.ghsa) return;
    const observed = coveredBy.get(index) ?? new Set();
    const declared = new Set(entry.sources ?? []);
    const siblings = (entriesByGhsa.get(String(entry.ghsa).toUpperCase()) ?? []).length > 1;
    if (siblings) {
      const label = `allowlist ${entryLabel(entry, index)}`;
      if (observed.size === 0) {
        fail(
          `${label} is STALE — it covers no reported advisory location in any source it declares ` +
            `(${[...declared].join(", ") || "none"}). Delete the entry, or correct its sources or introducedBy. ` +
            `An allowlist that only ever grows is the same failure with more ceremony.`,
        );
        return;
      }
      for (const s of declared) {
        if (!observed.has(s)) {
          fail(
            `${label} declares source [${s}] but covers no reported advisory location in it. ` +
              `STALE for that source — fix the entry's sources or introducedBy.`,
          );
        }
      }
      return;
    }
    if (observed.size === 0) {
      fail(
        `allowlist entry ${entry.ghsa} (${entry.package}) is STALE — that advisory no longer appears ` +
          `in any declared source (${[...declared].join(", ") || "none"}). Delete the entry. An ` +
          `allowlist that only ever grows is the same failure with more ceremony.`,
      );
    } else {
      for (const s of observed) {
        if (!declared.has(s)) {
          fail(
            `allowlist entry ${entry.ghsa} (${entry.package}) declares sources [${[...declared].join(", ")}] ` +
              `but the advisory was observed in [${s}]. SOURCES MISMATCH — fix the entry's sources.`,
          );
        }
      }
      for (const s of declared) {
        if (!observed.has(s)) {
          fail(
            `allowlist entry ${entry.ghsa} (${entry.package}) declares source [${s}] but the advisory was ` +
              `not observed in it. SOURCES MISMATCH — fix the entry's sources.`,
          );
        }
      }
    }
  });

  // NOT-REPORTED-BY-BUN — allowlisted advisories that this run's npm-install
  // observation reported, with every node under harper, and its bun lockfile
  // observation did not report.
  const notReportedByBun = [];
  allowlist.entries.forEach((entry, index) => {
    if (!entry?.ghsa) return;
    const g = entry.ghsa.toUpperCase();
    const observed = coveredBy.get(index) ?? new Set();
    if (!observed.has("npm-install")) return;
    if (advisories.some((a) => a.source === "bun" && a.ghsa?.toUpperCase() === g)) return;
    const npmAdv = advisories.find(
      (a) =>
        a.source === "npm-install" &&
        a.ghsa?.toUpperCase() === g &&
        allowed.some(({ adv, entry: e }) => adv === a && e === entry) &&
        (a.nodes ?? []).length > 0 &&
        a.nodes.every((n) => harperNodeRoot(n, a.package) !== null),
    );
    if (!npmAdv) return;
    notReportedByBun.push({ entry, npmAdv });
  });

  // Check 7 — fixability drift, per entry that covered a reported advisory.
  const drift = allowlist.entries.filter((e, index) => e?.ghsa && (coveredBy.get(index)?.size ?? 0) > 0);
  const pkgs = [...new Set(drift.map((e) => e.package))];
  const latest = new Map();
  let registryReachable = true;
  await Promise.all(
    pkgs.map(async (p) => {
      try {
        latest.set(p, await latestPublishedVersion(p));
      } catch (e) {
        registryReachable = false;
        warn(`could not check upstream versions for ${p}: ${e.message}`);
      }
    }),
  );

  for (const entry of drift) {
    const v = latest.get(entry.package);
    if (!v) continue;
    const g = String(entry.ghsa).toUpperCase();
    const adv = advisories.find((a) => a.ghsa?.toUpperCase() === g && a.package === entry.package) ??
      advisories.find((a) => a.ghsa?.toUpperCase() === g);
    if (!adv) continue;
    const stillVulnerable = isVulnerable(v, adv.vulnerableVersions);
    if (entry.class === "no-patch-published" && !stillVulnerable) {
      fail(
        `allowlist entry ${entry.ghsa} (${entry.package}) is classed "no-patch-published", but ` +
          `${entry.package}@${v} is published and is OUTSIDE the vulnerable range ` +
          `(${adv.vulnerableVersions}). The stated justification no longer holds — take the fix, or ` +
          `re-class the entry with an accurate reason.`,
      );
    } else if (!stillVulnerable) {
      notes.push(
        `${entry.package}@${v} is published and not vulnerable to ${entry.ghsa} ` +
          `(class "${entry.class}" — blocked on ${entry.removeWhen}).`,
      );
    }
  }
  if (!registryReachable) {
    warn(
      "Upstream fixability re-check was incomplete (registry unreachable). The enumerated, expiry " +
        "and staleness checks above still ran and still gate this build.",
    );
  }

  /* ---------------- report ---------------- */

  const counts = advisories.reduce((m, a) => ((m[a.severity] = (m[a.severity] ?? 0) + 1), m), {});
  const countStr =
    Object.entries(counts)
      .sort((a, b) => (SEVERITY_ORDER[a[0]] ?? 9) - (SEVERITY_ORDER[b[0]] ?? 9))
      .map(([s, n]) => `${n} ${s}`)
      .join(", ") || "none";

  console.log(`\nDependency audit gate — ${todayStr}`);
  console.log(`  advisories reported: ${advisories.length} (${countStr})`);
  console.log(`  allowlisted (justified + dated):  ${new Set(allowed.map(({ adv }) => adv)).size}`);
  console.log(`  blocking:                         ${blocked.length}\n`);

  const caps = allowlist.policy?.maxLifetimeDaysBySeverity ?? {};
  const overCap = allowlist.entries.filter((entry) => {
    const cap = caps[entry?.severity];
    if (typeof cap !== "number" || !isIsoDate(entry?.added) || !isIsoDate(entry?.expires)) return false;
    return Math.round((Date.parse(entry.expires) - Date.parse(entry.added)) / DAY_MS) > cap;
  });
  for (const entry of overCap) {
    const approval = entry.overCapApproval;
    const lifetimeDays = Math.round((Date.parse(entry.expires) - Date.parse(entry.added)) / DAY_MS);
    console.log(
      `  OVER-CAP: ${entry.ghsa} ${entry.package} — cumulative ${lifetimeDays}d lifetime, ` +
        `${caps[entry.severity]}d ${entry.severity} cap, approval recorded for ${approval.approvedBy} until ` +
        `${approval.expires}: ${approval.reason}`,
    );
  }
  if (overCap.length) console.log("");

  for (const { entry } of notReportedByBun) {
    console.log(
      `  NOT-REPORTED-BY-BUN: ${entry.ghsa} ${entry.package} — npm reports it under harper; retire when ${entry.removeWhen}`,
    );
  }
  if (notReportedByBun.length) console.log("");

  if (allowed.length) {
    console.log("  Allowlisted:");
    for (const { adv, entry } of allowed) {
      const daysLeft = Math.ceil((Date.parse(entry.expires) - today.getTime()) / DAY_MS);
      console.log(
        `    - ${adv.ghsa}  ${adv.package.padEnd(30)} ${adv.severity.padEnd(9)} ` +
          `${entry.class.padEnd(22)} expires ${entry.expires} (${daysLeft}d)`,
      );
      if (EXPLAIN) {
        console.log(`        via:      ${entry.introducedBy}`);
        console.log(`        reason:   ${entry.reason}`);
        console.log(`        retires:  ${entry.removeWhen}`);
      }
    }
    console.log("");
  }

  notes.unshift(
    "the Fabric hub runs harper-pro, a tree this gate cannot install; ops-h351 carries a standing step to audit the hub's installed tree before each deploy.",
  );
  for (const n of notes) console.log(`  note: ${n}`);
  if (notes.length) console.log("");

  for (const w of warnings) {
    console.log(`::warning::audit-gate: ${w}`);
    console.log(`  warning: ${w}`);
  }
  if (warnings.length) console.log("");

  if (failures.length) reportFailuresAndExit();

  console.log("  PASS — every reported advisory is enumerated, justified and dated.\n");
}

// Only run when executed directly, so the unit tests can import the helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // A crash must not hide the problems the gate had already recorded.
    if (failures.length) {
      console.error(`audit-gate: ${failures.length} problem(s) were recorded before the crash:`);
      for (const m of failures) console.error(`::error::audit-gate: ${m}`);
    }
    console.error(`audit-gate crashed: ${e?.stack || e}`);
    process.exit(1);
  });
}
