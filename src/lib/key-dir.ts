/**
 * key-dir.ts — the keys-directory walk shared by `flair keys prune`,
 * `flair doctor` and `flair status` (flair#3077).
 *
 * Prune retains its entry classification; mode checks use the Agent ID rule
 * because signing can read a .key without a .pub sibling.
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isValidAgentId } from "./agent-id-rule.js";
import { resolveHome } from "./home.js";

export type KeyDirEntryKind = "dir" | "other" | "key";

export interface KeyDirEntry {
  name: string;
  kind: KeyDirEntryKind;
}

export type KeyDirScan =
  | { state: "ok"; entries: KeyDirEntry[] }
  | { state: "unreadable"; error: unknown };

/** Read the keys directory, following a symlink at keysDir. The caller owns the
 *  "directory absent" decision; this reports only what readdir returned. */
export function scanKeyDir(keysDir: string): KeyDirScan {
  let dirents;
  try {
    dirents = readdirSync(keysDir, { withFileTypes: true });
  } catch (error) {
    return { state: "unreadable", error };
  }
  return {
    state: "ok",
    entries: dirents.map((dirent): KeyDirEntry => {
      if (dirent.isDirectory()) return { name: dirent.name, kind: "dir" };
      if (!dirent.name.endsWith(".key")) return { name: dirent.name, kind: "other" };
      return { name: dirent.name, kind: "key" };
    }),
  };
}

export type KeyModeFinding =
  | { kind: "wide"; path: string; mode: string }
  | { kind: "not-checked"; path: string; reason: string };

const KEY_SUFFIX = ".key";

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "lstat failed";
}

/** After the directory read, lstat each valid-id .key, including directories.
 * Non-regular entries are reported as not checked; entry symlinks are not
 * followed. No key content is read and no file is changed. */
export function keyModeFindings(keysDir: string, entries: KeyDirEntry[]): KeyModeFinding[] {
  const names = entries.map((e) => e.name).filter((name) =>
    name.endsWith(KEY_SUFFIX) && isValidAgentId(name.slice(0, -KEY_SUFFIX.length)),
  ).sort();
  const findings: KeyModeFinding[] = [];
  for (const name of names) {
    const path = join(keysDir, name);
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      findings.push({ kind: "not-checked", path, reason: errorCode(error) });
      continue;
    }
    if (!stats.isFile()) {
      findings.push({
        kind: "not-checked",
        path,
        reason: stats.isSymbolicLink() ? "symbolic link" : "not a regular file",
      });
      continue;
    }
    if (stats.mode & 0o077) {
      findings.push({ kind: "wide", path, mode: (stats.mode & 0o777).toString(8).padStart(4, "0") });
    }
  }
  return findings;
}

/** The one rendering of a finding, so doctor and status cannot word it
 *  differently. `chmod 600 <path>` is the exact remedy. */
export function formatKeyModeFinding(finding: KeyModeFinding): string {
  if (finding.kind === "wide") {
    return `agent key file ${finding.path} has mode ${finding.mode}, wider than owner-only — fix: chmod 600 ${finding.path}`;
  }
  return `agent key file ${finding.path} not checked (${finding.reason})`;
}

/** Mode bits carry no owner-only meaning on Windows. */
export function keyModesUnsupported(): boolean {
  return process.platform === "win32";
}

export const KEY_MODES_UNSUPPORTED_MESSAGE = "key file modes are not checked on Windows";

/** The keys directory `~/.flair/keys`, resolved at CALL time. */
export function defaultKeysDir(): string {
  return join(resolveHome(), ".flair", "keys");
}

/** Node-shaped file ids. */
const NODE_KEY_ID_RE = /^flair_[0-9a-f]{8}$/;

/** Match node-shaped ids without a sibling .pub; file type is unproven. */
export function isNodeKeyId(id: string, keysDir: string): boolean {
  if (!NODE_KEY_ID_RE.test(id)) return false;
  return !existsSync(join(keysDir, `${id}.pub`));
}

/**
 * Partition `.key`-derived ids into agent signing keys and node-scoped
 * federation keys (see isNodeKeyId). Node keys must never feed agent handling —
 * Ed25519 parsing, registration checks, or connector-identity inference
 * (flair#1193) — so callers keep only `agentKeyIds` for those paths and report
 * `nodeKeyIds` informatively.
 */
export function partitionKeyIds(
  ids: string[],
  keysDir: string,
): { agentKeyIds: string[]; nodeKeyIds: string[] } {
  const agentKeyIds: string[] = [];
  const nodeKeyIds: string[] = [];
  for (const id of ids) {
    (isNodeKeyId(id, keysDir) ? nodeKeyIds : agentKeyIds).push(id);
  }
  return { agentKeyIds, nodeKeyIds };
}
