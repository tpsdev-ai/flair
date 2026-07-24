/**
 * version.ts — shared runtime-version resolver.
 *
 * Reads the running @tpsdev-ai/flair version from the bundled package.json.
 * `process.env.npm_package_version` is only populated inside `npm run`, so
 * reading package.json relative to THIS running module is the only way to
 * report the version of the code that's actually executing.
 *
 * Extracted from the duplicated copies in resources/Presence.ts and
 * resources/AdminInstance.ts (flair#831). Those modules still carry their
 * own copies for now — migrating them is a follow-up.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "package.json"),
      join(here, "..", "package.json"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf-8"));
        if (pkg.version) return pkg.version;
      }
    }
  } catch { /* fall through */ }
  return process.env.npm_package_version ?? "dev";
}
