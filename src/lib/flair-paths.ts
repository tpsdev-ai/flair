/**
 * flair-paths.ts — the home-derived paths every subsystem must agree on (flair#1858).
 *
 * Each of these used to compute `~` itself (`os.homedir()` in cli.ts and
 * backup.ts). `os.homedir()` is cached at process START, so a `HOME` set later in
 * the process — which the keystore and the client writers now honour — was
 * invisible to them, and doctor could inspect a different home from the one the
 * writers used. They all resolve through `resolveHome()` now, with an explicit
 * `home` argument available to tests and callers that already resolved one.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "./home.js";

/** `~/.flair/data` — the instance data dir. */
export function flairDataDir(home: string = resolveHome()): string {
  return join(home, ".flair", "data");
}

/** `~/.flair/config.yaml`, or `config.yml` when only that exists. */
export function flairConfigPath(home: string = resolveHome()): string {
  const yamlPath = join(home, ".flair", "config.yaml");
  const ymlPath = join(home, ".flair", "config.yml");
  if (existsSync(ymlPath) && !existsSync(yamlPath)) return ymlPath;
  return yamlPath;
}

/** Default `flair backup` output: `~/.flair/backups/flair-backup-<timestamp>.json`. */
export function flairBackupOutputPath(timestamp: string, home: string = resolveHome()): string {
  return join(home, ".flair", "backups", `flair-backup-${timestamp}.json`);
}
