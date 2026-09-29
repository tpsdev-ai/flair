/**
 * node-alias-path.ts — the node binary path to write into a generated service
 * unit or shim (flair#2034 §2).
 *
 * A version manager exposes each installed runtime under a path that carries
 * its exact version (`…/installs/node/24.19.0/bin/node`). Some also expose a
 * FLOATING alias that resolves to one of them. This module writes such an alias
 * instead of the exact path when, and only when, the alias resolves (realpath)
 * to the very binary we would otherwise write. When no alias resolves to the
 * same binary, the exact path is written unchanged: a path that points at a
 * DIFFERENT runtime would be worse than the bug.
 *
 * Where an alias exists, and where it does not:
 *
 *   - mise: `$MISE_DATA_DIR | ~/.local/share/mise` + `/installs/node/<major>/bin/node`.
 *     mise keeps `installs/node/<major>` as a symlink to the newest installed
 *     runtime of that major, so it resolves to the same binary and is written.
 *   - Volta: `$VOLTA_HOME | ~/.volta` + `/bin/node`. Considered, but a standard
 *     Volta install makes that path a link to `volta-shim`, whose realpath is
 *     not a node binary, so the equality check rejects it and the exact path is
 *     written. It is chosen only on a setup where it really is the same binary.
 *   - nvm, fnm, asdf: no alias path of this kind (nvm's default alias is a text
 *     file; asdf's `shims/node` is a script), so the exact path is written.
 *
 * WHAT A FLOATING ALIAS DOES LATER. The alias is a moving pointer, by design:
 * when mise retargets `installs/node/24` to a newer 24.x, a unit holding the
 * alias runs THAT runtime from then on, without flair being re-run. That keeps
 * the unit's node path from dangling after a patch/minor bump, but it is a
 * different runtime than the one that was in use when the unit was written.
 *
 * WHAT IT DOES NOT DO. Only the node binary floats. The install tree a unit
 * serves (its working directory, the Harper entry, the launcher, the flair
 * script a shim runs) lives under the exact runtime's global prefix
 * (`…/installs/node/24.19.0/lib/node_modules/@tpsdev-ai/flair`), and is written
 * as that exact path. After a Node bump, `npm i -g @tpsdev-ai/flair` under the
 * new runtime installs a NEW tree; the unit keeps serving the old one until it
 * is re-pointed (`flair init && flair restart`).
 */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "./home.js";

export type AliasManager = "mise" | "volta";

export interface AliasCandidate {
  manager: AliasManager;
  /** Candidate absolute path to a floating node alias under this manager's layout. */
  path: string;
}

export interface AliasHooks {
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
  home?: string;
  env?: NodeJS.Dict<string>;
}

/** `24.19.0` / `v24.19.0` → `24.19.0`; null when no version is present. */
export function parseNodeVersion(nodePath: string): string | null {
  const m = /(?:^|[/\\])v?(\d+\.\d+\.\d+)(?:[/\\]|$)/.exec(nodePath);
  return m ? m[1]! : null;
}

/**
 * The floating aliases a version manager might expose for `nodeBin`'s runtime.
 * Pure: derived from the path + env only, no filesystem access. Callers filter
 * by existence + realpath equality.
 */
export function aliasCandidates(nodeBin: string, hooks: AliasHooks = {}): AliasCandidate[] {
  const home = hooks.home ?? resolveHome();
  const env = hooks.env ?? process.env;
  const version = parseNodeVersion(nodeBin);
  const out: AliasCandidate[] = [];
  if (!version || !home) return out;
  const major = version.split(".")[0]!;

  const miseData = env.MISE_DATA_DIR ?? join(home, ".local", "share", "mise");
  out.push({ manager: "mise", path: join(miseData, "installs", "node", major, "bin", "node") });

  const voltaHome = env.VOLTA_HOME ?? join(home, ".volta");
  out.push({ manager: "volta", path: join(voltaHome, "bin", "node") });

  return out;
}

/**
 * The node path to WRITE into a generated unit: a floating alias whose realpath
 * is the same binary as `nodeBin`, when one exists; otherwise `nodeBin`
 * unchanged. mise's major alias is preferred over Volta's when both match.
 */
export function preferVersionManagerAlias(nodeBin: string, hooks: AliasHooks = {}): string {
  const exists = hooks.exists ?? existsSync;
  const realpath = hooks.realpath ?? ((p: string) => realpathSync(p));
  let target: string;
  try {
    target = realpath(nodeBin);
  } catch {
    return nodeBin; // the resolved binary is not readable — write it as given
  }
  for (const c of aliasCandidates(nodeBin, hooks)) {
    try {
      if (c.path === nodeBin) continue;
      if (!exists(c.path)) continue;
      if (realpath(c.path) === target) return c.path;
    } catch {
      /* an unreadable candidate is not a match */
    }
  }
  return nodeBin;
}
