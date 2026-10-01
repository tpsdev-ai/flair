/**
 * is-direct-run.ts — whether a flair-mcp module is the process entry point.
 *
 * `import.meta.main` answers where the runtime provides it (Bun; Node 22.18+).
 * Otherwise compare filesystem paths, both resolved through symlinks: the
 * module URL is percent-encoded (a space is `%20`) and an npm bin shim is a
 * symlink, so a string comparison of the URL with `argv[1]` misses both.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isDirectRun(
  moduleUrl: string,
  argv1: string | undefined,
  metaMain: boolean | undefined,
  realpath: (p: string) => string = realpathSync,
): boolean {
  // Where the runtime provides import.meta.main, its answer decides, true or false.
  if (metaMain !== undefined) return metaMain;
  if (argv1 == null || argv1 === "") return false;
  try {
    return realpath(fileURLToPath(moduleUrl)) === realpath(argv1);
  } catch {
    return false;
  }
}
