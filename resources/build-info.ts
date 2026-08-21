/**
 * build-info.ts — read back the build-identity stamp the build wrote
 * (flair#1076; the stamp itself is written by scripts/write-build-info.mjs
 * at the end of both `build` and `build:cli`).
 *
 * WHY THE PATH IS MODULE-RELATIVE. The point of the stamp (Kern's ruling on
 * #1076) is that the RUNNING server reports its own build identity — a
 * file-only check proves the artifact on disk, not what the server loaded
 * (the 0.25.0 stale-dist incident class). Compiled, this module executes as
 * `dist/resources/build-info.js`, so `../build-info.json` is the stamp
 * emitted by the very build whose modules Harper loaded (config.yaml's
 * `jsResource: dist/resources/*.js`) — the same "resolve relative to THIS
 * running module" idiom as resolveVersion() in resources/version.ts.
 *
 * When this module runs from SOURCE (a bun test importing resources/*.ts
 * directly), `../build-info.json` is the repo root, where no stamp exists —
 * the resolver returns null and callers fall back honestly (version from
 * package.json, buildCommit served as null). A source run has no build, so
 * it HAS no build identity; reaching over into dist/ would report someone
 * else's.
 *
 * Read per call, not cached: identical lifecycle to resolveVersion()'s
 * package.json read, and /Health stays a truthful view of the file rather
 * than of whichever request happened to arrive first.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  version: string | null;
  /** Full 40-hex sha, or null — an honest "built outside a git work tree"
   *  (tarball builds). Never fabricated, never omitted (Sherlock, #1076). */
  commit: string | null;
  builtAt: string | null;
  builder: string | null;
}

export function resolveBuildInfo(): BuildInfo | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const stampPath = join(here, "..", "build-info.json");
    if (!existsSync(stampPath)) return null;
    const raw = JSON.parse(readFileSync(stampPath, "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    // Per-field validation, not a whole-object trust: a malformed stamp
    // degrades field-by-field to null rather than inventing values.
    return {
      version: typeof raw.version === "string" && raw.version.length > 0 ? raw.version : null,
      commit: typeof raw.commit === "string" && /^[0-9a-f]{40}$/.test(raw.commit) ? raw.commit : null,
      builtAt: typeof raw.builtAt === "string" ? raw.builtAt : null,
      builder: typeof raw.builder === "string" ? raw.builder : null,
    };
  } catch {
    return null; // unreadable/corrupt stamp — same honest fallback as absent
  }
}
