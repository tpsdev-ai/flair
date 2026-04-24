/**
 * Trust allow-list for npm code-plugin bridges.
 *
 * A Shape B bridge is arbitrary JavaScript fetched from npm. The spec §7
 * requires explicit operator opt-in on first use: `flair bridge allow <name>`
 * records the approval; subsequent invocations see the bridge on the
 * allow-list and skip the prompt. `flair bridge revoke <name>` removes it.
 *
 * This file is the persistence + query layer. CLI wiring lives in cli.ts.
 *
 * Design notes:
 *  - YAML (Shape A) + built-in bridges skip this gate entirely. They don't
 *    execute arbitrary JS.
 *  - The store is a simple JSON file at ~/.flair/bridges-allowed.json with
 *    an `allowed: [{name, allowedAt}]` shape. No separate DB, no Harper
 *    dependency — the trust decision should work even when Flair's own
 *    service is down.
 *  - Each entry records when it was allowed. Future slice-3d can add
 *    `allowedVersion` to pin approval to a specific package version,
 *    but 1.0 just needs presence/absence.
 */

import { promises as fsp } from "node:fs";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface AllowEntry {
  name: string;
  allowedAt: string;
}

export interface AllowList {
  allowed: AllowEntry[];
}

export interface AllowListOptions {
  /** Override for the allow-list file path. Defaults to ~/.flair/bridges-allowed.json. */
  path?: string;
}

function resolvePath(opts: AllowListOptions | undefined): string {
  return opts?.path ?? join(homedir(), ".flair", "bridges-allowed.json");
}

async function read(path: string): Promise<AllowList> {
  if (!existsSync(path)) return { allowed: [] };
  try {
    const raw = await fsp.readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.allowed)) return { allowed: [] };
    return { allowed: parsed.allowed.filter((e: any): e is AllowEntry => typeof e?.name === "string" && typeof e?.allowedAt === "string") };
  } catch {
    return { allowed: [] };
  }
}

async function write(path: string, data: AllowList): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true });
  // Stage + rename for atomicity
  const tmp = `${path}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await fsp.rename(tmp, path);
}

export async function isAllowed(name: string, opts?: AllowListOptions): Promise<boolean> {
  const list = await read(resolvePath(opts));
  return list.allowed.some((e) => e.name === name);
}

export async function allow(name: string, opts?: AllowListOptions): Promise<{ alreadyAllowed: boolean }> {
  const path = resolvePath(opts);
  const list = await read(path);
  if (list.allowed.some((e) => e.name === name)) {
    return { alreadyAllowed: true };
  }
  list.allowed.push({ name, allowedAt: new Date().toISOString() });
  // Sort by name for deterministic file contents.
  list.allowed.sort((a, b) => a.name.localeCompare(b.name));
  await write(path, list);
  return { alreadyAllowed: false };
}

export async function revoke(name: string, opts?: AllowListOptions): Promise<{ wasAllowed: boolean }> {
  const path = resolvePath(opts);
  const list = await read(path);
  const before = list.allowed.length;
  list.allowed = list.allowed.filter((e) => e.name !== name);
  if (list.allowed.length === before) {
    return { wasAllowed: false };
  }
  await write(path, list);
  return { wasAllowed: true };
}

export async function list(opts?: AllowListOptions): Promise<AllowEntry[]> {
  const data = await read(resolvePath(opts));
  return data.allowed;
}
