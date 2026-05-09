#!/usr/bin/env node
/**
 * check-dep-ages.mjs — supply-chain bake-time guard.
 *
 * Fails CI if any production dep declared in any workspace package was
 * published to the npm registry less than MIN_AGE_DAYS ago. Defends against
 * the "compromised package not yet detected" window — Mini Shai-Hulud
 * (Intercom npm Apr 30 2026), Ruby/Go sleeper packages (May 1), NuGet
 * typosquats (May 6), all in the past two weeks.
 *
 * Why we don't just rely on Socket.dev / npm audit:
 * - Socket scans declared deps against known-bad signatures. Doesn't catch
 *   the *new* compromise that nobody has flagged yet.
 * - npm audit has the same lag.
 * - The bake-time defense complements both: even if a freshly-published
 *   package is malicious, it has to survive N days in the wild before we'll
 *   pull it. By then, multiple security tools have had a chance to flag.
 *
 * pnpm 11 (May 4 2026) shipped this as a default at 1 day. We go with 7 as
 * the conservative start; can be tuned via FLAIR_DEP_MIN_AGE_DAYS env or
 * the policy doc.
 *
 * Internal `@tpsdev-ai/*` deps are exempt — we publish ourselves and the
 * 0.8.0 / 0.8.1 patch sequence already shipped same-day.
 *
 * Allow-list a one-off via the `// flair-deps:allow-fresh` comment in
 * package.json's nearby line — used sparingly for known-trusted vendors
 * we intentionally pull early. (Not implemented yet; deferred until first
 * real conflict.)
 *
 * Usage:
 *   node scripts/check-dep-ages.mjs
 *   FLAIR_DEP_MIN_AGE_DAYS=14 node scripts/check-dep-ages.mjs
 *
 * Exit codes:
 *   0 — all checked deps older than the threshold (or workspace-internal)
 *   1 — at least one dep too fresh
 *   2 — registry fetch failure (treated as fail, not warn — better safe)
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_AGE_DAYS = Number(process.env.FLAIR_DEP_MIN_AGE_DAYS ?? "7");
const REGISTRY = process.env.FLAIR_NPM_REGISTRY ?? "https://registry.npmjs.org";

if (!Number.isFinite(MIN_AGE_DAYS) || MIN_AGE_DAYS < 0) {
  console.error(`❌ Invalid FLAIR_DEP_MIN_AGE_DAYS: ${process.env.FLAIR_DEP_MIN_AGE_DAYS}`);
  process.exit(2);
}

/**
 * Keep-current allow-list — packages we deliberately want at the latest
 * published version regardless of bake time. The expectation: deps in this
 * list are tightly coupled to Flair's runtime correctness (Harper bug fixes
 * and security patches land here), and we'd rather take the bake-time risk
 * than miss a needed fix. The package owners are also high-trust — if any
 * of these is compromised, the broader ecosystem is in a bad state, and
 * our 7-day delay wouldn't have saved us anyway.
 *
 * Add a package here only when:
 *   - the upstream is well-known and high-volume (gets eyeballs fast)
 *   - we have a direct reason to want patches as soon as published (security,
 *     correctness, or a known bug we're tracking)
 *   - we accept that a freshly-malicious version could land in our build
 *     before broader detection
 *
 * Not a long list. Document in docs/supply-chain-policy.md alongside any
 * additions — the doc is the audit trail.
 *
 * Override per-run via FLAIR_DEP_KEEP_CURRENT="pkg1,pkg2,@scope/pkg3" env.
 */
const DEFAULT_KEEP_CURRENT = new Set([
  "@harperfast/harper",
  "harper-fabric-embeddings",
]);
const KEEP_CURRENT = new Set([
  ...DEFAULT_KEEP_CURRENT,
  ...(process.env.FLAIR_DEP_KEEP_CURRENT ?? "").split(",").map((s) => s.trim()).filter(Boolean),
]);

function readPkg(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ── Build the set of (name, version) pairs to check ─────────────────────────
const allPkgs = [];
allPkgs.push({ pkg: readPkg(join(REPO_ROOT, "package.json")), path: "package.json" });

const packagesDir = join(REPO_ROOT, "packages");
for (const entry of readdirSync(packagesDir)) {
  const path = join(packagesDir, entry, "package.json");
  try {
    allPkgs.push({ pkg: readPkg(path), path: `packages/${entry}/package.json` });
  } catch {
    // not a directory with a package.json — skip
  }
}

// Collect (name → exact-version) — only production deps; devDependencies and
// peerDependencies don't ship in the published tarball, so they don't add
// supply-chain risk to consumers.
const toCheck = new Map(); // key: "name@version", value: { name, version, declaredIn[] }
for (const { pkg, path } of allPkgs) {
  const deps = pkg.dependencies ?? {};
  for (const [name, version] of Object.entries(deps)) {
    if (name.startsWith("@tpsdev-ai/")) continue; // workspace-internal — exempt
    if (KEEP_CURRENT.has(name)) continue;          // explicitly kept-current — exempt
    if (typeof version !== "string") continue;
    if (version.startsWith("workspace:")) continue;
    if (version.startsWith("file:") || version.startsWith("link:")) continue;
    if (version.startsWith("git+") || version.startsWith("github:")) continue;
    // Only check exact-pinned. Range specifiers (^, ~, >=) are a different
    // class of risk — flagged separately by other tools — and resolving them
    // to a concrete version would require running an install, which is too
    // heavy for a fast CI gate.
    const exactVersion = /^\d/.test(version) ? version : null;
    if (!exactVersion) continue;
    const key = `${name}@${exactVersion}`;
    if (!toCheck.has(key)) {
      toCheck.set(key, { name, version: exactVersion, declaredIn: [] });
    }
    toCheck.get(key).declaredIn.push(path);
  }
}

if (toCheck.size === 0) {
  console.log("✓ No external pinned production deps to check.");
  if (KEEP_CURRENT.size > 0) {
    console.log(`(${KEEP_CURRENT.size} packages on the keep-current allow-list: ${[...KEEP_CURRENT].sort().join(", ")})`);
  }
  process.exit(0);
}

console.log(`Checking ${toCheck.size} pinned production deps against ${MIN_AGE_DAYS}-day bake-time policy...`);
if (KEEP_CURRENT.size > 0) {
  console.log(`Keep-current allow-list (${KEEP_CURRENT.size} packages, exempt from bake-time): ${[...KEEP_CURRENT].sort().join(", ")}`);
}
console.log("");

// ── Fetch publish dates from the npm registry ────────────────────────────────
const now = Date.now();
const cutoff = now - MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
const tooFresh = [];
const fetchFails = [];

async function getPublishTime(name, version) {
  // Registry endpoint: /<name> returns full document with a `time` map of
  // version → ISO timestamp. Cheap; ~1 request per package, parallel.
  // NB: the abbreviated `application/vnd.npm.install-v1+json` accept header
  // does NOT include the `time` map. Use default JSON for the full doc.
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
  return Date.parse(time);
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

// ── Report ──────────────────────────────────────────────────────────────────
if (tooFresh.length > 0) {
  console.error("❌ Pinned production deps younger than the bake-time policy:");
  console.error("");
  for (const f of tooFresh.sort((a, b) => b.publishedAt - a.publishedAt)) {
    const days = f.ageDays.toFixed(1);
    console.error(`  ${f.name}@${f.version}  — published ${days} days ago (policy: ≥${MIN_AGE_DAYS} days)`);
    for (const p of f.declaredIn) console.error(`    declared in ${p}`);
  }
  console.error("");
  console.error("Why this matters: Mini Shai-Hulud (Intercom npm, Apr 30 2026), Mini Shai-Hulud Composer/PHP (Apr 30), Ruby gem + Go module sleeper packages (May 1) — all compromises that survived N hours-to-days before detection. The bake-time policy keeps us out of the early-discovery window.");
  console.error("");
  console.error("To bypass for a known-good fresh dep (use sparingly): set FLAIR_DEP_MIN_AGE_DAYS=0 for this CI run, OR pin to an older version, OR document the exception in docs/supply-chain-policy.md.");
  process.exit(1);
}

if (fetchFails.length > 0) {
  console.error("❌ Failed to fetch publish times for some deps:");
  for (const f of fetchFails) {
    console.error(`  ${f.name}@${f.version}: ${f.error}`);
  }
  console.error("");
  console.error("Treating as fail. If the registry is genuinely down, retry; don't bypass.");
  process.exit(2);
}

console.log(`✓ All ${toCheck.size} external pinned production deps are at least ${MIN_AGE_DAYS} days old.`);
