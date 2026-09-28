/**
 * package-dir.ts — the tree THIS process's code was loaded from.
 *
 * flair#2034 §2: `flair status`/`upgrade`/`doctor` must be able to say which
 * install tree the CLI itself runs from, without importing src/cli.ts (the
 * command modules are forbidden from doing that — see status.ts's header). This
 * resolves the package root from the module's own location: a file under
 * `dist/lib/`, `dist/commands/`, `src/lib/` or `src/commands/` all sit two
 * levels below the package root that holds `package.json`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The CLI's own package dir, resolved from this module's location. */
export function cliPackageDir(fromUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the two-levels-up convention (dist/lib → package root).
  return join(dirname(fileURLToPath(fromUrl)), "..", "..");
}

/** The version declared by the package.json at `dir`, or "" when unreadable. */
export function readPackageVersion(dir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}
