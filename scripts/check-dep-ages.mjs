#!/usr/bin/env node
/**
 * check-dep-ages.mjs — supply-chain bake-time gate.
 *
 * Fails CI if any production dep declared in any workspace package was
 * published to the npm registry less than MIN_AGE_DAYS ago. Defends against
 * the "compromised package not yet detected" window — Mini Shai-Hulud
 * (Intercom npm Apr 30 2026), Ruby/Go sleeper packages (May 1), NuGet
 * typosquats (May 6), all in the past two weeks.
 *
 * The checked fields are `dependencies`, `optionalDependencies` and
 * `overrides` (root and every workspace package.json). An `overrides` entry
 * pins the version a transitive dep resolves to, so it can put a fresh
 * version in the tree without appearing in any `dependencies`.
 *
 * A known-good fresh SECURITY pin is exempted by a DATED entry naming the
 * advisory, in .github/dep-age-allowlist.json; an expired entry fails the
 * gate. Policy narrative: docs/supply-chain-policy.md.
 *
 * THIS SCRIPT IS THE CLI ENTRY POINT. It imports the pure gate logic from
 * scripts/lib/check-dep-ages-collect.mjs and always runs the gate.
 * There is no "am I the main module" check: the gate ALWAYS executes.
 *
 * Override for the repo root this script scans (for TEST FIXTURES only):
 *   FLAIR_CHECK_DEP_AGES_ROOT=/path/to/fixture node scripts/check-dep-ages.mjs
 *
 * `--ci` marks THIS invocation as the CI gate (the workflow passes it). The CI
 * gate scans the checked-out repository whatever the environment says, so it
 * REFUSES to run (exit 2, naming FLAIR_CHECK_DEP_AGES_ROOT) when that override
 * is PRESENT (even empty) alongside `--ci`.
 *
 * The gate accepts ONLY no arguments or exactly `--ci`; any other argument
 * exits 2, so a typo cannot silently run WITHOUT the CI guard.
 *
 * An explicit flag is used rather than a sniffed `CI=true`: the flag is the
 * invocation's OWN statement of intent, it cannot be set by accident in a
 * developer shell, and it is visible in the workflow file — unlike an ambient
 * variable any environment can set.
 *
 * Exit codes:
 *   0 — all checked deps older than the threshold (or nothing to check)
 *   1 — at least one dep too fresh
 *   2 — registry fetch failure (treated as fail, not warn — better safe), a
 *       REFUSED CI run (the fixture-root override present together with `--ci`),
 *       an unexpected argument, an unsupported `overrides` form, a manifest
 *       that cannot be read or parsed, or an invalid or expired exemption
 *       allowlist entry
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectDeps,
  collectNonExactDeps,
  collectUnsupportedOverrides,
} from "./lib/check-dep-ages-collect.mjs";

const ARGS = process.argv.slice(2);

// Accept ONLY no arguments (tests, local use) or exactly `--ci` (the CI gate).
// Anything else exits 2 BEFORE scanning: a typo must not silently run without
// the CI guard.
const IS_CI_GATE = ARGS.length === 1 && ARGS[0] === "--ci";
if (ARGS.length > 0 && !IS_CI_GATE) {
  console.error(`check-dep-ages: unexpected argument(s): ${ARGS.join(" ")}`);
  console.error("Accepted: no arguments, or exactly --ci (the CI gate's own flag).");
  process.exit(2);
}

const REPO_ROOT = process.env.FLAIR_CHECK_DEP_AGES_ROOT ??
  join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Read and parse a manifest. `label` names it in every error. A missing file
 * returns null (the caller decides whether it was required); any other read or
 * parse failure throws, naming the file — a manifest the gate cannot read is
 * never silently treated as absent.
 */
function readManifest(path, label) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new Error(`cannot read ${label}: ${err?.message ?? err}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err?.message ?? err}`);
  }
}

// ── Dated exemption allowlist ──────────────────────────────────────────────
//
// A security fix can need a version younger than the bake window (a patch
// release pinned through `overrides`, say). Those are enumerated with a hard
// expiry in .github/dep-age-allowlist.json — one dated entry per pin, each
// naming the advisory it fixes. An expired entry fails the gate: re-read the
// reason before re-dating, or remove the entry.
const ALLOWLIST_REL = join(".github", "dep-age-allowlist.json");
const GHSA_RE = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The UTC midnight of a calendar date written as YYYY-MM-DD, or null. Only a
 * string that names a real day passes: the parsed date must format back to the
 * same string, so "2099-13-01" and "2026-02-30" are refused.
 */
function parseCalendarDate(value) {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

/**
 * Read and validate the exemption allowlist at <root>/.github/dep-age-allowlist.json.
 * A MISSING file means "no exemptions" — test fixtures and downstream adopters
 * have none. An unreadable or malformed file is an error, never a silent pass.
 * Returns the unexpired entries and the expired ones separately.
 */
function readAllowlist(root) {
  const path = join(root, ALLOWLIST_REL);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { entries: [], expired: [] };
    throw new Error(`cannot read ${path}: ${err?.message ?? err}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err?.message ?? err}`);
  }
  if (!Array.isArray(parsed?.entries)) {
    throw new Error(`${path} must have an "entries" array.`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const entries = [];
  const expired = [];
  const problems = [];
  parsed.entries.forEach((entry, i) => {
    const where = `${path} entries[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${where} must be an object.`);
      return;
    }
    const ghsa = Array.isArray(entry.ghsa) ? entry.ghsa : [entry.ghsa];
    const bad = [];
    if (typeof entry.package !== "string" || entry.package === "") bad.push(`"package" must be a non-empty string`);
    if (typeof entry.version !== "string" || entry.version === "") bad.push(`"version" must be a non-empty string`);
    if (ghsa.length === 0 || !ghsa.every((g) => typeof g === "string" && GHSA_RE.test(g))) {
      bad.push(`"ghsa" must name at least one GHSA advisory id`);
    }
    const added = parseCalendarDate(entry.added);
    const expires = parseCalendarDate(entry.expires);
    if (added === null) bad.push(`"added" must be a calendar date string, YYYY-MM-DD`);
    if (expires === null) {
      bad.push(`"expires" must be a calendar date string, YYYY-MM-DD`);
    } else if (added !== null && expires <= added) {
      bad.push(`"expires" (${entry.expires}) must be after "added" (${entry.added})`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") bad.push(`"reason" must be a non-empty string`);
    if (bad.length > 0) {
      problems.push(`${where}: ${bad.join("; ")}`);
      return;
    }
    const normalized = {
      package: entry.package,
      version: entry.version,
      ghsa,
      added: entry.added,
      expires: entry.expires,
      reason: entry.reason,
    };
    if (today >= entry.expires) expired.push(normalized);
    else entries.push(normalized);
  });
  if (problems.length > 0) {
    throw new Error(`Invalid ${path}:\n  - ${problems.join("\n  - ")}`);
  }
  return { entries, expired };
}

// ── Main gate logic (always runs — no main-detection guard) ──────────────────

async function main() {
  // The CI gate scans the CHECKED-OUT repository, whatever the environment
  // says. FLAIR_CHECK_DEP_AGES_ROOT exists so tests can point the gate at a
  // fixture repository; honouring it on a CI run would let a stray variable
  // divert the gate away from the tree under review. The workflow declares
  // itself with an explicit --ci flag, and we refuse when the override is
  // PRESENT (even empty) before scanning or fetching. A PRESENCE test, not a
  // truthiness test: an empty value would otherwise slip through and resolve
  // the root to "".
  if (IS_CI_GATE && process.env.FLAIR_CHECK_DEP_AGES_ROOT !== undefined) {
    console.error(
      "FLAIR_CHECK_DEP_AGES_ROOT is present, but the CI gate must scan the checked-out repository.",
    );
    console.error(
      "Refusing to run. Unset FLAIR_CHECK_DEP_AGES_ROOT: it is for tests, which point the gate at a fixture repository and do not pass --ci.",
    );
    process.exit(2);
  }

  const MIN_AGE_DAYS = Number(process.env.FLAIR_DEP_MIN_AGE_DAYS ?? "7");
  const REGISTRY = process.env.FLAIR_NPM_REGISTRY ?? "https://registry.npmjs.org";

  if (!Number.isFinite(MIN_AGE_DAYS) || MIN_AGE_DAYS < 0) {
    console.error(`Invalid FLAIR_DEP_MIN_AGE_DAYS: ${process.env.FLAIR_DEP_MIN_AGE_DAYS}`);
    process.exit(2);
  }

  // Keep-current allow-list — packages we deliberately want at the latest
  // published version regardless of bake time.
  const DEFAULT_KEEP_CURRENT = new Set([
    "harper",
    "harper-fabric-embeddings",
    "@harperfast/oauth",
  ]);
  const KEEP_CURRENT = new Set([
    ...DEFAULT_KEEP_CURRENT,
    ...(process.env.FLAIR_DEP_KEEP_CURRENT ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ]);

  // Build the set of (name, version) pairs to check. Every manifest the gate
  // reads is named in any error: a workspace manifest it cannot read or parse
  // fails the gate rather than being skipped.
  const allPkgs = [];
  const rootManifest = readManifest(join(REPO_ROOT, "package.json"), "package.json");
  if (rootManifest === null) {
    throw new Error("cannot read package.json: no such file");
  }
  allPkgs.push({ pkg: rootManifest, path: "package.json" });

  const packagesDir = join(REPO_ROOT, "packages");
  const { readdirSync } = await import("node:fs");
  let workspaceEntries = [];
  try {
    workspaceEntries = readdirSync(packagesDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code !== "ENOENT") throw new Error(`cannot read ${packagesDir}: ${err?.message ?? err}`);
  }
  for (const entry of workspaceEntries) {
    const label = `packages/${entry.name}/package.json`;
    const manifest = readManifest(join(packagesDir, entry.name, "package.json"), label);
    // A workspace without a package.json is not a manifest — skip it.
    if (manifest !== null) allPkgs.push({ pkg: manifest, path: label });
  }

  const unsupportedOverrides = collectUnsupportedOverrides(allPkgs);
  if (unsupportedOverrides.length > 0) {
    console.error("Unsupported `overrides` entries:");
    console.error("");
    for (const u of unsupportedOverrides) {
      console.error(`    ${u.declaredIn} ${u.at}: ${u.reason}`);
    }
    process.exit(2);
  }

  const toCheck = collectDeps(allPkgs, KEEP_CURRENT);
  const nonExact = collectNonExactDeps(allPkgs);

  const allowlist = readAllowlist(REPO_ROOT);
  if (allowlist.expired.length > 0) {
    console.error("Expired bake-time exemption(s) in .github/dep-age-allowlist.json:");
    console.error("");
    for (const e of allowlist.expired) {
      console.error(`    ${e.package}@${e.version} — expired ${e.expires} (${e.ghsa.join(", ")})`);
    }
    console.error("");
    console.error("Re-read the reason, then remove the entry or re-date it in a new one.");
    process.exit(2);
  }

  if (nonExact.length > 0) {
    console.log("Not age-checked (ranges):");
    for (const o of nonExact) {
      console.log(`    ${o.name} "${o.spec}" (declared in ${o.declaredIn})`);
    }
    console.log("");
  }

  if (toCheck.size === 0) {
    console.log("✓ No external pinned production deps to check.");
    if (KEEP_CURRENT.size > 0) {
      console.log(
        `(${KEEP_CURRENT.size} packages on the keep-current allow-list: ${[...KEEP_CURRENT].sort().join(", ")})`,
      );
    }
    process.exit(0);
  }

  console.log(
    `Checking ${toCheck.size} pinned production deps against ${MIN_AGE_DAYS}-day bake-time policy...`,
  );
  if (KEEP_CURRENT.size > 0) {
    console.log(
      `Keep-current allow-list (${KEEP_CURRENT.size} packages, exempt from bake-time): ${[...KEEP_CURRENT].sort().join(", ")}`,
    );
  }
  console.log("");

  // Fetch publish dates from the npm registry
  const now = Date.now();
  const cutoff = now - MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
  const tooFresh = [];
  const fetchFails = [];

  // Transient registry/network errors retry; missing data and 4xx do not.
  function isRetryablePublishTimeError(err) {
    const msg = String(err?.message ?? err);
    if (msg.startsWith("no publish time")) return false;
    // A malformed value is not transient; retrying fetches the same bad body.
    if (msg.startsWith("unparseable publish time")) return false;
    if (/^HTTP 4\d\d/.test(msg) && !/^HTTP 408/.test(msg) && !/^HTTP 429/.test(msg)) {
      return false;
    }
    return true;
  }

  async function getPublishTimeOnce(name, version) {
    const url = `${REGISTRY}/${encodeURIComponent(name).replace(/^%40/, "@")}`;
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = await res.json();
    const time = body?.time?.[version];
    if (!time) {
      throw new Error(`no publish time for ${name}@${version}`);
    }
    // Validate the SHAPE before parsing. The publish time must be a STRING.
    // Date.parse coerces a number to a finite date (Date.parse(1) is not an
    // error, so a non-string would be silently accepted) and THROWS on an
    // object whose toString is not callable — and a thrown error here would be
    // RETRIED. Both are registry failures, not age comparisons, so fail closed
    // with the same non-retryable error.
    if (typeof time !== "string") {
      throw new Error(`unparseable publish time for ${name}@${version}: ${JSON.stringify(time)}`);
    }
    const publishedAt = Date.parse(time);
    if (Number.isNaN(publishedAt)) {
      // A present STRING that is not a valid date is equally untrustworthy:
      // fail closed like a fetch failure — never compare it to the cutoff (NaN
      // comparisons are always false and would slip through).
      throw new Error(`unparseable publish time for ${name}@${version}: ${JSON.stringify(time)}`);
    }
    return publishedAt;
  }

  async function getPublishTime(name, version) {
    // One undici fetch failure on a single package used to fail the whole
    // matrix leg. Still fail-closed after retries — don't bypass.
    const attempts = 3;
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await getPublishTimeOnce(name, version);
      } catch (err) {
        lastErr = err;
        if (!isRetryablePublishTimeError(err) || i === attempts) break;
        await new Promise((r) => setTimeout(r, 200 * 2 ** (i - 1)));
      }
    }
    throw lastErr;
  }

  // Parallelize but cap concurrency to be polite to the registry.
  const tasks = [...toCheck.values()];
  const CONCURRENCY = 10;
  async function runChecks() {
    const cursor = { i: 0 };
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (cursor.i < tasks.length) {
        const t = tasks[cursor.i++];
        try {
          const publishedAt = await getPublishTime(t.name, t.version);
          if (publishedAt > cutoff) {
            const ageDays = (now - publishedAt) / (24 * 60 * 60 * 1000);
            tooFresh.push({ ...t, publishedAt, ageDays });
          }
        } catch (err) {
          fetchFails.push({ ...t, error: String(err?.message ?? err) });
        }
      }
    });
    await Promise.all(workers);
  }

  await runChecks();

  // ── Report ────────────────────────────────────────────────────────
  // Partition the too-fresh pins into those named by an unexpired dated
  // exemption and those that are not. Expired entries were refused above.
  const exempted = [];
  const stillFresh = [];
  for (const f of tooFresh) {
    const entry = allowlist.entries.find((e) => e.package === f.name && e.version === f.version);
    if (entry) exempted.push({ ...f, entry });
    else stillFresh.push(f);
  }

  if (exempted.length > 0) {
    console.log("Exempted fresh pins (dated exemption, see docs/supply-chain-policy.md):");
    console.log("");
    for (const f of exempted.sort((a, b) => b.publishedAt - a.publishedAt)) {
      const days = f.ageDays.toFixed(1);
      console.log(
        `    ${f.name}@${f.version}    — published ${days} days ago (policy: >=${MIN_AGE_DAYS} days); exempt until ${f.entry.expires} (${f.entry.ghsa.join(", ")})`,
      );
      for (const p of f.declaredIn) console.log(`    declared in ${p}`);
    }
    console.log("");
  }

  if (stillFresh.length > 0) {
    console.error("Pinned production deps younger than the bake-time policy:");
    console.error("");
    for (const f of stillFresh.sort((a, b) => b.publishedAt - a.publishedAt)) {
      const days = f.ageDays.toFixed(1);
      console.error(`    ${f.name}@${f.version}    — published ${days} days ago (policy: >=${MIN_AGE_DAYS} days)`);
      for (const p of f.declaredIn) console.error(`    declared in ${p}`);
    }
    console.error(
      "",
      "Why this matters: supply chain bake-time policy keeps us out of the early-discovery window.",
    );
    console.error(
      "",
      "To exempt a known-good fresh security pin: add a dated entry to .github/dep-age-allowlist.json naming the advisory (see docs/supply-chain-policy.md), OR pin to an older version.",
    );
    process.exit(1);
  }

  if (fetchFails.length > 0) {
    console.error("Failed to fetch publish times for some deps:");
    for (const f of fetchFails) {
      console.error(`   ${f.name}@${f.version}: ${f.error}`);
    }
    console.error("");
    console.error("Treating as fail. If the registry is genuinely down, retry; don't bypass.");
    process.exit(2);
  }

  if (exempted.length === 0) {
    console.log(
      `All ${toCheck.size} external pinned production deps are at least ${MIN_AGE_DAYS} days old.`,
    );
  } else {
    const names = exempted
      .map((f) => `${f.name}@${f.version}`)
      .sort()
      .join(", ");
    console.log(
      `${toCheck.size - exempted.length} of ${toCheck.size} external pinned production deps are at least ${MIN_AGE_DAYS} days old; ${exempted.length} exemption(s) applied: ${names}.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
