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
 * THIS SCRIPT IS THE CLI ENTRY POINT. It imports the pure gate logic from
 * scripts/lib/check-dep-ages-collect.mjs and always runs the gate.
 * There is no "am I the main module" check: the gate ALWAYS executes.
 *
 * Override for the repo root this script scans (for test fixtures):
 *   FLAIR_CHECK_DEP_AGES_ROOT=/path/to/fixture node scripts/check-dep-ages.mjs
 *
 * Exit codes:
 *   0 — all checked deps older than the threshold (or nothing to check)
 *   1 — at least one dep too fresh
 *   2 — registry fetch failure (treated as fail, not warn — better safe)
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectDeps } from "./lib/check-dep-ages-collect.mjs";

const REPO_ROOT = process.env.FLAIR_CHECK_DEP_AGES_ROOT ??
  join(dirname(fileURLToPath(import.meta.url)), "..");

function readPkg(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ── Main gate logic (always runs — no main-detection guard) ──────────────────

async function main() {
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

  // Build the set of (name, version) pairs to check
  const allPkgs = [];
  allPkgs.push({ pkg: readPkg(join(REPO_ROOT, "package.json")), path: "package.json" });

  const packagesDir = join(REPO_ROOT, "packages");
  const { readdirSync } = await import("node:fs");
  for (const entry of readdirSync(packagesDir)) {
    const p = join(packagesDir, entry, "package.json");
    try {
      allPkgs.push({ pkg: readPkg(p), path: `packages/${entry}/package.json` });
    } catch {
      // not a directory with a package.json — skip
    }
  }

  const toCheck = collectDeps(allPkgs, KEEP_CURRENT);

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
    const publishedAt = Date.parse(time);
    if (Number.isNaN(publishedAt)) {
      // Present but not a valid date: the registry handed back a value we
      // cannot trust. Fail closed like a fetch failure — never compare it to
      // the cutoff (NaN comparisons are always false and would slip through).
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
  if (tooFresh.length > 0) {
    console.error("Pinned production deps younger than the bake-time policy:");
    console.error("");
    for (const f of tooFresh.sort((a, b) => b.publishedAt - a.publishedAt)) {
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
      "To bypass for a known-good fresh dep: set FLAIR_DEP_MIN_AGE_DAYS=0 for this CI run, OR pin to an older version, OR document the exception in docs/supply-chain-policy.md.",
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

  console.log(
    `All ${toCheck.size} external pinned production deps are at least ${MIN_AGE_DAYS} days old.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
