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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
];

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

/**
 * `bun audit --json` writes clean JSON to stdout and its banner to stderr.
 * It exits non-zero when advisories exist, so a non-zero exit is expected and
 * is NOT itself the failure signal — unparseable stdout is.
 */
export function runBunAudit() {
  const res = spawnSync("bun", ["audit", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (res.error) {
    throw new Error(`could not execute \`bun audit\`: ${res.error.message}`);
  }

  const stdout = (res.stdout || "").trim();
  if (!stdout) {
    throw new Error(
      `\`bun audit\` produced no output on stdout (exit ${res.status}). ` +
        `stderr: ${(res.stderr || "").trim().slice(0, 500) || "<empty>"}`,
    );
  }

  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(
      `\`bun audit\` stdout was not valid JSON (exit ${res.status}): ${e.message}. ` +
        `First 300 chars: ${stdout.slice(0, 300)}`,
    );
  }
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

export function validateAllowlist(allowlist, today) {
  const problems = [];
  const caps = allowlist?.policy?.maxLifetimeDaysBySeverity ?? {};
  const seen = new Set();

  allowlist.entries.forEach((entry, i) => {
    const where = `entry[${i}] (${entry?.ghsa ?? "no ghsa"} / ${entry?.package ?? "no package"})`;

    for (const f of REQUIRED_ENTRY_FIELDS) {
      const v = entry?.[f];
      if (v === undefined || v === null || String(v).trim() === "") {
        problems.push(`${where}: missing required field "${f}"`);
      }
    }
    if (problems.some((p) => p.startsWith(where))) return;

    if (!/^GHSA-[a-z0-9-]+$/i.test(entry.ghsa)) {
      problems.push(`${where}: "ghsa" must be a GHSA id`);
    }
    if (seen.has(entry.ghsa)) {
      problems.push(`${where}: duplicate entry for ${entry.ghsa}`);
    }
    seen.add(entry.ghsa);

    if (!VALID_CLASSES.has(entry.class)) {
      problems.push(
        `${where}: unknown class "${entry.class}" (expected one of ${[...VALID_CLASSES].join(", ")})`,
      );
    }
    if (!isIsoDate(entry.added)) problems.push(`${where}: "added" must be YYYY-MM-DD`);
    if (!isIsoDate(entry.expires)) problems.push(`${where}: "expires" must be YYYY-MM-DD`);
    if (!isIsoDate(entry.added) || !isIsoDate(entry.expires)) return;

    // An exception with no meaningful deadline is the defect this gate exists
    // to prevent, so the deadline is capped by severity and the cap is enforced
    // here rather than trusted to review.
    const lifetimeDays = Math.round((Date.parse(entry.expires) - Date.parse(entry.added)) / DAY_MS);
    if (lifetimeDays <= 0) {
      problems.push(`${where}: "expires" (${entry.expires}) must be after "added" (${entry.added})`);
    }
    const cap = caps[entry.severity];
    if (typeof cap === "number" && lifetimeDays > cap) {
      problems.push(
        `${where}: lifetime ${lifetimeDays}d exceeds the ${cap}d cap for severity "${entry.severity}". ` +
          `Shorten "expires", or fix the advisory.`,
      );
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

async function latestPublishedVersion(pkg) {
  const url = registryUrlFor(pkg);
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`registry returned HTTP ${res.status} for ${pkg}`);
  const body = await res.json();
  if (!body?.version) throw new Error(`registry response for ${pkg} had no version field`);
  return body.version;
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

  let allowlist;
  let advisories;
  try {
    allowlist = loadAllowlist();
    advisories = flattenAdvisories(runBunAudit());
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

  const byGhsa = new Map();
  for (const e of allowlist.entries) if (e?.ghsa) byGhsa.set(e.ghsa.toUpperCase(), e);

  const matchedGhsa = new Set();
  const allowed = [];
  const blocked = [];

  for (const adv of advisories) {
    if (!adv.ghsa) {
      fail(
        `${adv.package}: advisory "${adv.title}" has no GHSA id in its url (${adv.url || "none"}) ` +
          `and therefore cannot be allowlisted. Investigate manually.`,
      );
      blocked.push(adv);
      continue;
    }
    const entry = byGhsa.get(adv.ghsa.toUpperCase());
    if (!entry) {
      blocked.push(adv);
      fail(
        `${adv.severity.toUpperCase()} ${adv.ghsa} in ${adv.package} (${adv.vulnerableVersions}) ` +
          `is NOT allowlisted.\n      ${adv.title}\n      ${adv.url}\n` +
          `      Fix it, or add a justified, dated entry to .github/audit-allowlist.json.`,
      );
      continue;
    }
    matchedGhsa.add(adv.ghsa.toUpperCase());

    if (entry.package !== adv.package) {
      fail(
        `allowlist entry ${entry.ghsa} says package "${entry.package}" but the advisory is against ` +
          `"${adv.package}". Correct the entry.`,
      );
      blocked.push(adv);
      continue;
    }
    if (entry.severity !== adv.severity) {
      fail(
        `allowlist entry ${entry.ghsa} records severity "${entry.severity}" but the advisory is now ` +
          `"${adv.severity}". Re-assess it against the severity expiry cap, then update the entry.`,
      );
      blocked.push(adv);
      continue;
    }

    // Expiry. This is the mechanism working, not a malfunction.
    if (todayStr >= entry.expires) {
      fail(
        `allowlist entry ${entry.ghsa} (${entry.package}, ${entry.severity}) EXPIRED on ${entry.expires}.\n` +
          `      Original reason: ${entry.reason}\n` +
          `      Retires when:    ${entry.removeWhen}\n` +
          `      A human must now re-decide: fix it, or re-justify with a new date.`,
      );
      blocked.push(adv);
      continue;
    }

    allowed.push({ adv, entry });
    const daysLeft = Math.ceil((Date.parse(entry.expires) - today.getTime()) / DAY_MS);
    if (daysLeft <= 14) {
      warn(`${entry.ghsa} (${entry.package}) expires in ${daysLeft}d on ${entry.expires}.`);
    }
  }

  // Check 6 — staleness.
  for (const entry of allowlist.entries) {
    if (!entry?.ghsa) continue;
    if (!matchedGhsa.has(entry.ghsa.toUpperCase())) {
      fail(
        `allowlist entry ${entry.ghsa} (${entry.package}) is STALE — that advisory no longer appears ` +
          `in \`bun audit\` output. Delete the entry. An allowlist that only ever grows is the same ` +
          `failure with more ceremony.`,
      );
    }
  }

  // Check 7 — fixability drift.
  const drift = allowlist.entries.filter((e) => matchedGhsa.has(String(e.ghsa).toUpperCase()));
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
    const adv = advisories.find((a) => a.ghsa?.toUpperCase() === String(entry.ghsa).toUpperCase());
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
  console.log(`  advisories reported by bun audit: ${advisories.length} (${countStr})`);
  console.log(`  allowlisted (justified + dated):  ${allowed.length}`);
  console.log(`  blocking:                         ${blocked.length}\n`);

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

  for (const n of notes) console.log(`  note: ${n}`);
  if (notes.length) console.log("");

  for (const w of warnings) {
    console.log(`::warning::audit-gate: ${w}`);
    console.log(`  warning: ${w}`);
  }
  if (warnings.length) console.log("");

  if (failures.length) {
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

  console.log("  PASS — every reported advisory is enumerated, justified and dated.\n");
}

// Only run when executed directly, so the unit tests can import the helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`audit-gate crashed: ${e?.stack || e}`);
    process.exit(1);
  });
}
