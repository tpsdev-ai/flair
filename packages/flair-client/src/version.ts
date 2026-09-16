/**
 * This package's published version, for the `X-Flair-Client` request header
 * (flair#1383). Read from the nearest `@tpsdev-ai/flair-client` package.json
 * so a release bump is picked up without a second constant to forget.
 *
 * npm always publishes package.json, so `dist/version.js` can walk one
 * directory up. Workspace runs resolve the same file from `src/`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FLAIR_CLIENT_PACKAGE = "@tpsdev-ai/flair-client";
export const FLAIR_CLIENT_VERSION_HEADER = "X-Flair-Client";

function readOwnVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    try {
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8"));
        if (pkg?.name === FLAIR_CLIENT_PACKAGE && typeof pkg.version === "string" && pkg.version) {
          return pkg.version;
        }
      }
    } catch {
      // unreadable — keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
}

let cached: string | undefined;

export function flairClientVersion(): string {
  if (cached === undefined) cached = readOwnVersion();
  return cached;
}

/** Value of `X-Flair-Client`, e.g. `flair-client/0.54.2`. */
export function flairClientVersionToken(version = flairClientVersion()): string {
  return `flair-client/${version}`;
}
