/**
 * node-alias-path.ts — prefer a version-manager-STABLE node path.
 *
 * flair#2034 §2: after a Node minor bump, every absolute path baked into a
 * launchd plist / systemd unit / shim moves, because a version manager exposes
 * each installed runtime under a path that carries the exact version
 * (`…/installs/node/24.19.0/bin/node`). Re-pointing a service at the runtime
 * in use now fixes today's break and re-breaks on the next bump.
 *
 * A version manager that also exposes an ALIAS path — a path that carries the
 * MAJOR (or a floating name) and resolves to the same runtime — lets a
 * generated unit survive the exact-minor bump that caused this issue. This
 * module prefers such an alias when (and only when) its realpath is the SAME
 * binary as the runtime we would otherwise write. When no alias resolves to the
 * same runtime, the resolved path is written unchanged: a path that is stable
 * but points at a DIFFERENT runtime would be worse than the bug.
 *
 * Supported layouts (fixtures for each live in the unit tests):
 *   - mise:  $MISE_DATA_DIR | ~/.local/share/mise/installs/node/<major>/bin/node
 *   - nvm:   $NVM_DIR       | ~/.nvm/versions/node/v<version>/bin/node
 *   - fnm:   $FNM_DIR       | ~/.local/share/fnm/node-versions/v<version>/installation/bin/node
 *   - volta: $VOLTA_HOME    | ~/.volta/bin/node
 *   - asdf:  $ASDF_DATA_DIR | ~/.asdf/installs/nodejs/<version>/bin/node
 */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

export type VersionManager = "mise" | "nvm" | "fnm" | "volta" | "asdf";

export interface AliasCandidate {
  manager: VersionManager;
  /** Candidate absolute path to a node binary under this manager's layout. */
  path: string;
  /**
   * True when the path carries only the MAJOR version (e.g. `…/node/24/bin`),
   * so it survives an exact-minor bump. Majors are preferred over exact paths.
   */
  stableAcrossMinors: boolean;
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
  return m ? m[1] : null;
}

/**
 * Every alias candidate a version manager MIGHT expose for `nodeBin`'s runtime.
 * Pure: derived from the path + env only, no filesystem access. Callers filter
 * by existence + realpath equality.
 */
export function aliasCandidates(nodeBin: string, hooks: AliasHooks = {}): AliasCandidate[] {
  const home = hooks.home ?? (hooks.env?.HOME ?? process.env.HOME ?? "");
  const env = hooks.env ?? process.env;
  const version = parseNodeVersion(nodeBin);
  const out: AliasCandidate[] = [];
  if (!version || !home) return out;
  const major = version.split(".")[0]!;
  const bin = "bin/node";

  // mise — installs/node/<version>/, and (when `mise use` pins a major) an
  // installs/node/<major> alias that resolves to the newest patch of that major.
  const miseData = env.MISE_DATA_DIR ?? join(home, ".local", "share", "mise");
  out.push({ manager: "mise", path: join(miseData, "installs", "node", major, bin), stableAcrossMinors: true });
  out.push({ manager: "mise", path: join(miseData, "installs", "node", version, bin), stableAcrossMinors: false });

  // nvm — one directory per exact version, `v` prefix.
  const nvmDir = env.NVM_DIR ?? join(home, ".nvm");
  out.push({ manager: "nvm", path: join(nvmDir, "versions", "node", `v${version}`, bin), stableAcrossMinors: false });

  // fnm — node-versions/<vX.Y.Z>/installation/bin/node.
  const fnmDir = env.FNM_DIR ?? join(home, ".local", "share", "fnm");
  out.push({ manager: "fnm", path: join(fnmDir, "node-versions", `v${version}`, "installation", bin), stableAcrossMinors: false });
  out.push({ manager: "fnm", path: join(home, ".fnm", "node-versions", `v${version}`, "installation", bin), stableAcrossMinors: false });

  // volta — a single stable bin dir whose `node` shims whichever toolchain is pinned.
  const voltaHome = env.VOLTA_HOME ?? join(home, ".volta");
  out.push({ manager: "volta", path: join(voltaHome, bin), stableAcrossMinors: true });

  // asdf — installs/nodejs/<version>/bin/node.
  const asdfData = env.ASDF_DATA_DIR ?? join(home, ".asdf");
  out.push({ manager: "asdf", path: join(asdfData, "installs", "nodejs", version, bin), stableAcrossMinors: false });

  return out;
}

/**
 * The node path to WRITE into a generated unit: an alias from a known
 * version-manager layout whose realpath is the same runtime as `nodeBin`, when
 * one exists; otherwise `nodeBin` unchanged. Among matching aliases, a
 * stable-across-minors path is preferred, then the shortest.
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
  const matches: AliasCandidate[] = [];
  for (const c of aliasCandidates(nodeBin, hooks)) {
    try {
      if (!exists(c.path)) continue;
      if (realpath(c.path) === target) matches.push(c);
    } catch {
      /* an unreadable candidate is not a match */
    }
  }
  if (matches.length === 0) return nodeBin;
  matches.sort((a, b) => {
    if (a.stableAcrossMinors !== b.stableAcrossMinors) return a.stableAcrossMinors ? -1 : 1;
    return a.path.length - b.path.length;
  });
  return matches[0]!.path;
}

/** Human-readable list of the layouts this module understands, for doctor output. */
export function describeSupportedLayouts(): string[] {
  return [
    "mise: ~/.local/share/mise/installs/node/<major>/bin/node (or $MISE_DATA_DIR)",
    "nvm: ~/.nvm/versions/node/v<version>/bin/node (or $NVM_DIR)",
    "fnm: ~/.local/share/fnm/node-versions/v<version>/installation/bin/node (or $FNM_DIR)",
    "volta: ~/.volta/bin/node (or $VOLTA_HOME)",
    "asdf: ~/.asdf/installs/nodejs/<version>/bin/node (or $ASDF_DATA_DIR)",
  ];
}
