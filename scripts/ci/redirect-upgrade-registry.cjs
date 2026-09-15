"use strict";
/**
 * redirect-upgrade-registry.cjs — test-only NODE_OPTIONS preload for the macOS
 * launchd adopt-then-upgrade lane (flair#1671).
 *
 * WHY THIS EXISTS. `flair upgrade`'s update check fetches
 * `https://registry.npmjs.org/@tpsdev-ai/<pkg>/latest` with a HARDCODED host
 * (src/commands/upgrade.ts), so it bypasses the `@tpsdev-ai:registry` npm
 * config the lane sets. The lane's local registry shim
 * (scripts/ci/local-npm-registry.mjs) therefore never influenced the update
 * check: `flair upgrade` compared the installed 0.53.0 against the public
 * latest dist-tag (also 0.53.0) and no-op'd, so the PR build was never
 * installed and the flair#1683 path was never exercised.
 *
 * WHAT IT DOES. Rewrites only requests under the `@tpsdev-ai` scope on
 * `registry.npmjs.org` to the lane's shim (LOCAL_NPM_REGISTRY_URL). The actual
 * `npm install -g` still uses the scoped npm config, so the tarball install is
 * unchanged. This is a CI shim, NOT a product change: the product's hardcoded
 * registry host is the root cause and needs its own issue.
 *
 * Loaded via NODE_OPTIONS=--require. A no-op when LOCAL_NPM_REGISTRY_URL is
 * unset, so it is safe to leave in NODE_OPTIONS.
 */
const UPSTREAM = "https://registry.npmjs.org";
const shim = process.env.LOCAL_NPM_REGISTRY_URL;

if (shim && typeof globalThis.fetch === "function") {
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
