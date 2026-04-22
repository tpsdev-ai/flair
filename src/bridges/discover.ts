/**
 * Bridge discovery — scans the four conventional sources defined in
 * FLAIR-BRIDGES.md §7:
 *
 *   1. Project YAML:   <cwd>/.flair-bridge/*.yaml
 *   2. User YAML:      ~/.flair/bridges/*.yaml
 *   3. npm packages:   node_modules/flair-bridge-*  |  node_modules/@*\/flair-bridge-*
 *   4. Built-ins:      bundled adapters inside @tpsdev-ai/flair
 *
 * Discovery is metadata-only — it reads names, versions, and kinds without
 * executing any code plugin. Runtime execution is slice 2.
 */

import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import type { BridgeKind, DiscoveredBridge } from "./types.js";

// Exported for tests. Consumers should prefer `discover()`.
export interface DiscoverOptions {
  cwd?: string;
  home?: string;
  /** Extra npm module search roots. Defaults to <cwd>/node_modules + <home>/.flair/node_modules. */
  moduleRoots?: string[];
  /** Built-in adapters — explicit list, in-tree. Slice 1 ships none. */
  builtins?: DiscoveredBridge[];
}

async function exists(path: string): Promise<boolean> {
  try { await fsp.stat(path); return true; } catch { return false; }
}

async function readYamlBridge(path: string): Promise<DiscoveredBridge | null> {
  try {
    const raw = await fsp.readFile(path, "utf-8");
    // Lightweight parse — we only pull the top-level fields we advertise.
    // Avoids pulling in a YAML dep just for discovery; a real parse happens
    // later when the bridge runs. Tolerates single-quoted values, unquoted,
    // or no value at all.
    const get = (field: string): string | undefined => {
      const re = new RegExp(`^${field}\\s*:\\s*(.*)$`, "m");
      const m = raw.match(re);
      if (!m) return undefined;
      return m[1].trim().replace(/^["']|["']$/g, "");
    };
    const name = get("name");
    if (!name) return null;
    const kindStr = get("kind") ?? "file";
    const kind: BridgeKind = kindStr === "api" ? "api" : "file";
    const versionRaw = get("version");
    const version = versionRaw ? parseInt(versionRaw, 10) : undefined;
    const description = get("description");
    return {
      name,
      kind,
      source: path.includes(join(".flair", "bridges")) ? "user-yaml" : "project-yaml",
      path,
      description,
      version: Number.isFinite(version) ? version : undefined,
    };
  } catch {
    return null;
  }
}

async function scanYamlDir(dir: string): Promise<DiscoveredBridge[]> {
  if (!(await exists(dir))) return [];
  let names: string[];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out: DiscoveredBridge[] = [];
  for (const name of names) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const parsed = await readYamlBridge(join(dir, name));
    if (parsed) out.push(parsed);
  }
  return out;
}

async function readNpmBridge(pkgDir: string): Promise<DiscoveredBridge | null> {
  const pkgPath = join(pkgDir, "package.json");
  if (!(await exists(pkgPath))) return null;
  try {
    const raw = await fsp.readFile(pkgPath, "utf-8");
    const json = JSON.parse(raw);
    // Convention: the bridge's public name is what ends with `flair-bridge-<name>`.
    // Package name may be `flair-bridge-foo` or `@scope/flair-bridge-foo`.
    const pkgName = String(json.name ?? "");
    const match = pkgName.match(/flair-bridge-([^/]+)$/);
    if (!match) return null;
    const flairMeta = json.flair ?? {};
    const kind: BridgeKind = flairMeta.kind === "file" ? "file" : "api"; // npm bridges default to api
    return {
      name: match[1],
      kind,
      source: "npm-package",
      path: pkgDir,
      description: json.description,
      version: typeof flairMeta.version === "number" ? flairMeta.version : 1,
    };
  } catch {
    return null;
  }
}

async function scanModuleRoot(base: string): Promise<DiscoveredBridge[]> {
  if (!(await exists(base))) return [];
  let entries: string[];
  try { entries = await fsp.readdir(base); } catch { return []; }
  const results: DiscoveredBridge[] = [];
  for (const entry of entries) {
    const full = join(base, entry);
    if (entry.startsWith("flair-bridge-")) {
      const b = await readNpmBridge(full);
      if (b) results.push(b);
    } else if (entry.startsWith("@")) {
      // Scoped dir — enumerate one level deeper
      let scoped: string[];
      try { scoped = await fsp.readdir(full); } catch { continue; }
      for (const s of scoped) {
        if (s.startsWith("flair-bridge-")) {
          const b = await readNpmBridge(join(full, s));
          if (b) results.push(b);
        }
      }
    }
  }
  return results;
}

/**
 * Discover all installed bridges across the four conventional sources.
 * Results are deduped by name; built-ins win, then project, then user,
 * then npm (shadowing a more-specific adapter with a less-specific one
 * is never desirable).
 */
export async function discover(opts: DiscoverOptions = {}): Promise<DiscoveredBridge[]> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const moduleRoots = opts.moduleRoots ?? [
    join(cwd, "node_modules"),
    join(home, ".flair", "node_modules"),
  ];

  const [projectYaml, userYaml, ...moduleResults] = await Promise.all([
    scanYamlDir(join(cwd, ".flair-bridge")),
    scanYamlDir(join(home, ".flair", "bridges")),
    ...moduleRoots.map((r) => scanModuleRoot(r)),
  ]);

  const all: DiscoveredBridge[] = [
    ...(opts.builtins ?? []),
    ...projectYaml,
    ...userYaml,
    ...moduleResults.flat(),
  ];

  // Dedup by name with source precedence (earlier wins since all[] is ordered).
  const seen = new Map<string, DiscoveredBridge>();
  for (const b of all) {
    if (!seen.has(b.name)) seen.set(b.name, b);
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// Exported helpers for tests & for the scaffold command, which needs to
// confirm a bridge name isn't already taken.
export const __test = { readYamlBridge, readNpmBridge, scanYamlDir, scanModuleRoot };
// Suppress "unused" warnings in strict builds — dirname/basename kept for future expansion.
void dirname; void basename;
