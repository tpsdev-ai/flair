/**
 * doctor-config-path.ts — resolve config.yaml the way the runtime does (flair#1514).
 *
 * Harper loads the component's `config.yaml` from the directory it was
 * started in (`harper run .` → `./config.yaml`). `flair mcp enable` already
 * walks `./config.yaml` then `~/.flair/config.yaml`. Doctor used to consult
 * ONLY `~/.flair/config.yaml`, so a wrapper-launched component dir
 * (`~/agents/flair/config.yaml`) printed "No config file at ~/.flair/config.yaml
 * — using defaults" while the running instance was on the real file.
 *
 * One resolver, used by doctor's config line and by the federation-driver
 * peer-gate (the gate must see the same file Harper sees, or a peered
 * install whose peers live only in the component config would be treated
 * as "no peers" and the driver check would be silenced — the #1514 hazard).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ResolveFlairConfigYamlOpts {
  cwd?: string;
  homeDir?: string;
  /** Package / component root (e.g. flairPackageDir()). Tried after cwd. */
  componentDir?: string;
}

const CONFIG_BASENAMES = ["config.yaml", "config.yml"] as const;

function configFilesIn(dir: string): string[] {
  return CONFIG_BASENAMES.map((name) => join(dir, name));
}

/**
 * Candidate paths in runtime order: cwd, then the component dir (if distinct),
 * then `~/.flair`. Existence is not checked — callers that want the first
 * existing file use `resolveFlairConfigYaml`.
 */
export function flairConfigYamlCandidates(opts: ResolveFlairConfigYamlOpts = {}): string[] {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const homeDir = opts.homeDir ?? homedir();
  const out: string[] = [...configFilesIn(cwd)];
  if (opts.componentDir) {
    const componentDir = resolve(opts.componentDir);
    if (componentDir !== cwd) out.push(...configFilesIn(componentDir));
  }
  out.push(...configFilesIn(join(homeDir, ".flair")));
  return out;
}

/**
 * First existing config.yaml along the runtime resolution order, or null.
 */
export function resolveFlairConfigYaml(opts: ResolveFlairConfigYamlOpts = {}): string | null {
  for (const p of flairConfigYamlCandidates(opts)) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** `port:` from a YAML file, same regex `readPortFromConfig` uses on ~/.flair. */
export function readPortFromYamlFile(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    const m = readFileSync(path, "utf-8").match(/port:\s*(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
