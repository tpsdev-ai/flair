"use strict";
/**
 * redirect-upgrade-registry.cjs — test-only NODE_OPTIONS preload for the macOS
 * launchd adopt-then-upgrade lane (flair#1671), GATED on the baseline version.
 *
 * WHY THIS EXISTS. `flair upgrade`'s update check fetched
 * `https://registry.npmjs.org/@tpsdev-ai/<pkg>/latest` with a HARDCODED host in
 * releases before 0.54.2 (#1688/#1692 added the resolver). A baseline CLI older
 * than 0.54.2 therefore bypasses the `@tpsdev-ai:registry` npm config the lane
 * sets: the update check sees the public `latest` dist-tag, reports "current",
 * and no-ops, so the PR build is never installed and the flair#1683 path is
 * never exercised. This shim is the test double for that pre-resolver update
 * check.
 *
 * WHEN IT IS USED. The lane applies it only while the derived baseline is
 * strictly older than `FIRST_RESOLVER_RELEASE` (0.54.2). Once the baseline is
 * >= 0.54.2 the lane skips the shim and the product resolver itself is what the
 * run accepts — the self-retiring half of the fix (flint decision, PR #1684).
 * The PR build's own resolver is never shimmed.
 *
 * WHAT IT DOES. Rewrites only requests under the `@tpsdev-ai` scope on
 * `registry.npmjs.org` to the lane's shim (LOCAL_NPM_REGISTRY_URL). The actual
 * `npm install -g` still uses the scoped npm config, so the tarball install is
 * unchanged. This is a CI shim, NOT a product change: the product's hardcoded
 * registry host is the root cause and was fixed by #1692.
 *
 * Loaded via NODE_OPTIONS=--require. A no-op when LOCAL_NPM_REGISTRY_URL is
 * unset. It writes one `active` line to stderr so the lane can assert, from the
 * upgrade log, that the baseline really did go through the shim.
 */
const UPSTREAM = "https://registry.npmjs.org";
const shim = process.env.LOCAL_NPM_REGISTRY_URL;

if (shim && typeof globalThis.fetch === "function") {
  process.stderr.write(
    `[redirect-upgrade-registry] active: rewriting ${UPSTREAM}/@tpsdev-ai/* -> ${shim}\n`,
  );
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    try {
      const url =
        typeof input === "string"
          ? input
          : input && typeof input.url === "string"
            ? input.url
            : "";
      if (url.startsWith(`${UPSTREAM}/@tpsdev-ai/`)) {
        return original(`${shim}${url.slice(UPSTREAM.length)}`, init);
      }
    } catch {
      /* fall through to the original request */
    }
    return original(input, init);
  };
}
