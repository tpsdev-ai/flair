#!/usr/bin/env node
/**
 * registry-latest-skew.mjs — refuse to leave the lockstep set skewed on `latest`
 * (flair#1781).
 *
 * Reads `dist-tags.latest` for EVERY lockstep package (lockstep-packages.mjs) and
 * exits non-zero naming the packages that disagree. Three modes:
 *
 *   - no argument — skew is "the packages do not all agree on one `latest`".
 *     This is the PRE-promote check: the canary runs it before the verdict so a
 *     pre-existing skew (a prior partial promote, or an older flow) is visible;
 *     the all-or-none promote below is what resolves it.
 *   - `<expected-version>` — skew is "any package's `latest` != expected". One
 *     read per package, as in the no-argument mode.
 *   - `<expected-version> --await <seconds> [--previous <package>=<version>]...` —
 *     the wait mode (flair#2140), the POST-promote check the promote block runs
 *     straight after its last `npm dist-tag add`. Each `--previous` names a
 *     package's `latest` from BEFORE the promote.
 *
 * Why a wait mode (flair#2140). The other two modes read `npm view <pkg>
 * dist-tags.latest`, which fetches the package document. The public registry
 * serves that document from its CDN (`cache-control: public, max-age=300`,
 * `cf-cache-status: HIT`; a request `Cache-Control: no-cache` header still got a
 * HIT, measured 2026-09-30), so a read straight after a move can return the
 * previous `latest`. After the v0.57.0 and v0.58.0 promotes the check read a stale
 * `latest` for `@tpsdev-ai/flair` (the package the block moves last), reported
 * skew and printed RESTORE lines for a promote that had succeeded; a later re-run
 * reported convergence.
 *
 * So the wait mode reads each `latest` from the registry's dist-tags endpoint
 * (`GET /-/package/<pkg>/dist-tags`; `npm dist-tag add` writes
 * `PUT /-/package/<pkg>/dist-tags/<tag>`), through
 * `npm dist-tag ls <pkg> --prefer-online`:
 *   - the CDN does not cache that endpoint (`cf-cache-status: DYNAMIC`, measured
 *     2026-09-30);
 *   - `--prefer-online` makes npm revalidate every read with the registry. Without
 *     it, npm 11.19's `dist-tag ls` answered a second read from its local cache
 *     with no request at all when the response carried a freshness lifetime
 *     (measured against a local registry stub); with it, every read reached the
 *     server.
 * Every package not yet at the expected version is re-read with backoff until it
 * is, or until the wait ends. The first read of each package is such a read too,
 * so in this mode a "converged" verdict rests only on these reads.
 *
 * Usage:
 *   node scripts/ci/registry-latest-skew.mjs [expected-version]
 *   node scripts/ci/registry-latest-skew.mjs <expected-version> --await <seconds> [--previous <package>=<version>]...
 *
 * Exit codes:
 *   0 — the set agrees (wait mode: every package read the expected version)
 *   1 — skew (the offender packages are named on stderr). In wait mode: when the
 *       wait ended, at least one package not at the expected version read a
 *       value other than its `--previous` (or has no `--previous`)
 *   2 — DID NOT RUN (a `latest` could not be read, a usage error, or no packages
 *       found) — an unmeasurable check is never green
 *   3 — wait mode only: NOT YET VISIBLE. When the wait ended, every package not at
 *       the expected version still read its `--previous` value. The message tells
 *       the operator to re-run the check before restoring anything.
 */
import { execFileSync } from "node:child_process";
import { lockstepPackages } from "./lockstep-packages.mjs";

/** The expected-version shape (unchanged from flair#1781). */
const EXPECTED_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;
/**
 * A `latest` value the wait mode accepts, from `--previous` or from a read: the
 * SAME shape the promote block's step 2 requires of the previous `latest` it
 * records, so every value the block records is accepted here.
 */
const VERSION_VALUE_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
/** Upper bound for `--await`, in seconds. */
const AWAIT_MAX_S = 600;
/** Backoff between wait-mode read passes: 1 s, doubling, capped at 16 s. */
const AWAIT_FIRST_DELAY_MS = 1_000;
const AWAIT_MAX_DELAY_MS = 16_000;
/** A wait-mode read that has not returned after this long is unreadable. */
const AWAIT_READ_TIMEOUT_MS = 30_000;

const argv = process.argv.slice(2);
const hasPositional = argv.length > 0 && !argv[0].startsWith("--");
const expected = hasPositional ? argv[0] : "";
const flagArgs = hasPositional ? argv.slice(1) : argv;
if (expected && !EXPECTED_RE.test(expected)) {
  console.error(`usage: node scripts/ci/registry-latest-skew.mjs [expected-version] (got '${expected}')`);
  process.exit(2);
}

function usageError(reason) {
  console.error(
    `usage: node scripts/ci/registry-latest-skew.mjs [expected-version] [--await <seconds> [--previous <package>=<version>]...] — ${reason}`,
  );
  process.exit(2);
}

let awaitSeconds = null;
/** package -> its `latest` before the promote (wait mode only). */
const previous = new Map();
for (let i = 0; i < flagArgs.length; i++) {
  const arg = flagArgs[i];
  let name;
  let value;
  if (arg === "--await" || arg === "--previous") {
    name = arg;
    value = flagArgs[i + 1];
    i++;
  } else if (arg.startsWith("--await=") || arg.startsWith("--previous=")) {
    name = arg.slice(0, arg.indexOf("="));
    value = arg.slice(arg.indexOf("=") + 1);
  } else {
    usageError(`unexpected argument '${arg}'`);
  }
  if (value === undefined) usageError(`${name} needs a value`);
  if (name === "--await") {
    if (awaitSeconds !== null) usageError("--await was given more than once");
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > AWAIT_MAX_S) {
      usageError(`--await takes whole seconds from 1 to ${AWAIT_MAX_S} (got '${value}')`);
    }
    awaitSeconds = Number(value);
  } else {
    const eq = value.indexOf("=");
    const pkg = eq > 0 ? value.slice(0, eq) : "";
    const ver = eq > 0 ? value.slice(eq + 1) : "";
    if (!pkg || !VERSION_VALUE_RE.test(ver)) {
      usageError(`--previous takes <package>=<version> (got '${value}')`);
    }
    if (previous.has(pkg)) usageError(`--previous names '${pkg}' more than once`);
    previous.set(pkg, ver);
  }
}
if (awaitSeconds !== null && !expected) usageError("--await needs an expected version");
if (previous.size > 0 && awaitSeconds === null) usageError("--previous is read only with --await");

const packages = (() => {
  try {
    return lockstepPackages();
  } catch (err) {
    console.error(`registry-latest-skew: DID NOT RUN — ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
})();
if (packages.length === 0) {
  console.error("registry-latest-skew: DID NOT RUN — no lockstep packages found");
  process.exit(2);
}
for (const pkg of previous.keys()) {
  if (!packages.includes(pkg)) usageError(`--previous names '${pkg}', which is not a lockstep package`);
}

function readLatest(pkg) {
  try {
    const raw = execFileSync("npm", ["view", pkg, "dist-tags.latest"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // `npm view <pkg> dist-tags.latest` prints the bare version; tolerate quotes.
    const value = raw.replace(/^"(.*)"$/, "$1").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * The wait mode's read: `latest` from the registry's dist-tags endpoint, through
 * `npm dist-tag ls <pkg> --prefer-online` (see the header for why). Returns null —
 * unreadable — when npm fails or times out, or when its output does not carry
 * exactly one `latest: <version>` line.
 */
function readLatestUncached(pkg) {
  let raw;
  try {
    raw = execFileSync("npm", ["dist-tag", "ls", pkg, "--prefer-online"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: AWAIT_READ_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  const values = raw
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.startsWith("latest: "))
    .map((line) => line.slice("latest: ".length).trim());
  if (values.length !== 1 || !VERSION_VALUE_RE.test(values[0])) return null;
  return values[0];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait mode (flair#2140). Returns the exit code. */
async function awaitConvergence() {
  const deadline = performance.now() + awaitSeconds * 1000;
  let delay = AWAIT_FIRST_DELAY_MS;
  const current = new Map();
  let pending = [...packages];
  for (;;) {
    const unreadable = [];
    for (const pkg of pending) {
      const v = readLatestUncached(pkg);
      if (v === null) unreadable.push(pkg);
      else current.set(pkg, v);
    }
    if (unreadable.length > 0) {
      console.error(`registry-latest-skew: DID NOT RUN — could not read dist-tags.latest for: ${unreadable.join(", ")}`);
      return 2;
    }
    pending = pending.filter((p) => current.get(p) !== expected);
    if (pending.length === 0) {
      console.log(`✓ all ${packages.length} lockstep packages are at latest ${expected}`);
      return 0;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, AWAIT_MAX_DELAY_MS);
  }

  // The wait ended with packages not at the expected version. Lag explains a
  // package only while it still reads the `latest` it had before the promote.
  const onPrevious = (p) => previous.has(p) && current.get(p) === previous.get(p);
  if (pending.every(onPrevious)) {
    console.error(
      `… lockstep latest not yet visible after ${awaitSeconds} s — expected ${expected}; these packages still read their PREVIOUS latest:`,
    );
    for (const p of pending) console.error(`   ${p}: latest ${current.get(p)}`);
    console.error(
      "The registry can serve the previous latest for a while after a move. Re-run this check with the same arguments before restoring anything.",
    );
    return 3;
  }
  console.error(`✗ lockstep latest skew — expected ${expected}:`);
  for (const p of pending) console.error(`   ${p}: latest ${current.get(p)}`);
  return 1;
}

if (awaitSeconds !== null) {
  process.exit(await awaitConvergence());
}

const latest = new Map();
const unreadable = [];
for (const pkg of packages) {
  const v = readLatest(pkg);
  if (v === null) unreadable.push(pkg);
  else latest.set(pkg, v);
}
if (unreadable.length > 0) {
  console.error(`registry-latest-skew: DID NOT RUN — could not read dist-tags.latest for: ${unreadable.join(", ")}`);
  process.exit(2);
}

if (expected) {
  const offenders = packages.filter((p) => latest.get(p) !== expected);
  if (offenders.length === 0) {
    console.log(`✓ all ${packages.length} lockstep packages are at latest ${expected}`);
    process.exit(0);
  }
  console.error(`✗ lockstep latest skew — expected ${expected}:`);
  for (const p of offenders) console.error(`   ${p}: latest ${latest.get(p)}`);
  process.exit(1);
}

const values = new Set(packages.map((p) => latest.get(p)));
if (values.size === 1) {
  console.log(`✓ all ${packages.length} lockstep packages agree on latest ${[...values][0]}`);
  process.exit(0);
}

// Name the minority: whichever `latest` the most packages share is the value to
// converge on; the rest are the offenders.
const counts = new Map();
for (const p of packages) counts.set(latest.get(p), (counts.get(latest.get(p)) ?? 0) + 1);
let modal = null;
let best = -1;
for (const [v, c] of counts) if (c > best) { best = c; modal = v; }
const offenders = packages.filter((p) => latest.get(p) !== modal);
console.error(`✗ lockstep latest skew — ${packages.length - offenders.length}/${packages.length} are at ${modal}; these differ:`);
for (const p of offenders) console.error(`   ${p}: latest ${latest.get(p)} (expected ${modal})`);
process.exit(1);
