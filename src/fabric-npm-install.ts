/**
 * fabric-npm-install.ts — node-side `npm install` for Fabric deploys (flair#886).
 *
 * Harper's default component install writes every fetched tarball into the
 * node's `~/.npm/_cacache` and never evicts it. A month of `flair deploy` /
 * `flair upgrade --target` therefore leaves a growing cache on the hub —
 * hundreds of MB per install once `node-llama-cpp` prebuilds are in the
 * tree — while `get_components` and `system_information` never show it.
 *
 * This file is the `install_command` those two CLI paths pass to
 * `harper deploy`. It runs `npm install` against a disposable cache
 * directory and deletes that directory afterwards, so cache lifetime
 * matches the deploy rather than the node.
 *
 * Harper splits `install_command` on spaces and spawns without a shell
 * (`Application.installApplication`), so the command must be a single
 * executable plus a path — no `sh -c`, no `&& rm`. The flags after
 * `install` match Harper's own default when `install.command` is unset
 * (`--force --ignore-scripts`); a custom command replaces that default
 * entirely, and dropping either flag would change what the node runs.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Path Harper runs, relative to the extracted component directory. */
export const FABRIC_NPM_INSTALL_ENTRY = "dist/fabric-npm-install.js";

/**
 * Passed as `install_command=…` to `harper deploy`. Harper's
 * `buildRequest` JSON-parses values that look like JSON; this string
 * does not, so it stays a string. `split(" ")` must yield exactly
 * `["node", FABRIC_NPM_INSTALL_ENTRY]`.
 */
export const FABRIC_NPM_INSTALL_COMMAND = `node ${FABRIC_NPM_INSTALL_ENTRY}`;

/** Harper's default argv when `install.command` is unset, plus `--cache`. */
export const FABRIC_NPM_INSTALL_ARGS_BEFORE_CACHE = [
  "install",
  "--force",
  "--ignore-scripts",
] as const;

export interface EphemeralNpmInstallSpawnResult {
  status: number | null;
  error?: Error;
}

export interface EphemeralNpmInstallDeps {
  spawn?: (
    command: string,
    args: string[],
    opts: { cwd: string; stdio: "inherit" },
  ) => EphemeralNpmInstallSpawnResult;
  mkdtemp?: (prefix: string) => string;
  rm?: (path: string) => void;
  cwd?: string;
  tmpdir?: string;
}

/**
 * Run `npm install` with `--cache` pointed at a fresh temp directory,
 * then remove that directory on success or failure.
 *
 * Returns npm's exit status. Throws only when the spawn itself fails
 * to start (ENOENT on `npm`, etc.) — the same split `fabric-upgrade`'s
 * local staging install uses.
 */
export function installWithEphemeralNpmCache(deps: EphemeralNpmInstallDeps = {}): number {
  const spawn =
    deps.spawn ??
    ((command, args, opts) => spawnSync(command, args, opts));
  const mkdtemp = deps.mkdtemp ?? ((prefix) => mkdtempSync(prefix));
  const rm = deps.rm ?? ((path) => rmSync(path, { recursive: true, force: true }));
  const cwd = deps.cwd ?? process.cwd();
  const tmp = deps.tmpdir ?? tmpdir();

  const cacheDir = mkdtemp(join(tmp, "flair-npm-"));
  try {
    const result = spawn(
      "npm",
      [...FABRIC_NPM_INSTALL_ARGS_BEFORE_CACHE, "--cache", cacheDir],
      { cwd, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    rm(cacheDir);
  }
}

function invokedAsMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  try {
    process.exit(installWithEphemeralNpmCache());
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
