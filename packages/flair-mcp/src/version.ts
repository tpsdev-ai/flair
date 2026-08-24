/**
 * version.ts — the version advertised in MCP `initialize` `serverInfo`.
 *
 * `process.env.npm_package_version` is only populated inside `npm run`, so
 * reading this package's own package.json relative to THIS running module is
 * the only way to report the version of the code that's actually executing
 * (same reason as resources/version.ts). Walk-by-name rather than a fixed
 * number of `..` hops, matching src/lib/mcp-spec.ts: this file compiles to
 * dist/version.js, tests import the .ts next to src/, and a hardcoded depth
 * is one move away from silently advertising the wrong package — or "dev".
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The published package whose version `initialize` must report. */
export const FLAIR_MCP_PACKAGE = "@tpsdev-ai/flair-mcp";

/** What we advertise when package.json cannot be read. */
export const UNKNOWN_VERSION = "dev";

/**
 * Walk up from `startDir` looking for `@tpsdev-ai/flair-mcp`'s own package.json.
 * Exported for tests, which need to exercise the not-found path without
 * corrupting a real install.
 */
export function resolvePackageVersionFrom(startDir: string): string {
  let dir = startDir;
  // 8 levels is far more than any real layout needs (dist/ → package root is 1)
  // while still terminating on a pathological symlink loop.
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (pkg?.name === FLAIR_MCP_PACKAGE && typeof pkg.version === "string" && pkg.version) {
        return pkg.version;
      }
    } catch {
      // No package.json here, or unreadable/malformed — keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.env.npm_package_version ?? UNKNOWN_VERSION;
}

/** This package's version — what `initialize` puts in `serverInfo.version`. */
export function resolvePackageVersion(): string {
  return resolvePackageVersionFrom(dirname(fileURLToPath(import.meta.url)));
}

/** The `serverInfo` object passed to `McpServer` (and thus returned on initialize). */
export function serverInfo(): { name: "flair"; version: string } {
  return { name: "flair", version: resolvePackageVersion() };
}
