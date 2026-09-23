/**
 * Home-isolation guard (flair#1853).
 *
 * The lane sandboxes every test process in a throwaway HOME (bunfig.toml
 * preload + `scripts/test-unit.ts` child env). This is the backstop: it
 * fingerprints the REAL user's client config files before and after the lane and
 * fails if any of them changed, so a test that reaches around the sandbox is
 * caught rather than silently rewriting a developer's real config.
 *
 * The real home is resolved ONCE from `os.userInfo().homedir`, NOT from
 * `process.env.HOME` — the lane deliberately sets HOME to a sandbox, so reading
 * home out of the environment is exactly the mistake this guard exists to
 * catch.
 *
 * `~/.claude.json` is fingerprinted on its `mcpServers` subtree only: Claude
 * Code rewrites the rest of that file constantly, so a whole-file hash would
 * fire on unrelated churn.
 *
 * Only hashes are produced — never file contents — so this never echoes a
 * config that may embed a secret.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

/** Client config files the guard fingerprints, relative to the home dir. */
export const REAL_CLIENT_CONFIGS = [
  ".codex/config.toml",
  ".claude/settings.json",
  ".gemini/settings.json",
  ".gemini/config/mcp_config.json",
  ".cursor/mcp.json",
  ".pi/agent/settings.json",
] as const;

/** Sentinel path for the `~/.claude.json` `mcpServers` subtree fingerprint. */
export const CLAUDE_JSON_SUBTREE = ".claude.json#mcpServers";

export interface ConfigFingerprint {
  /** Path relative to the home dir, or CLAUDE_JSON_SUBTREE. */
  path: string;
  state: "absent" | "present" | "unreadable";
  /** sha256 hex of the fingerprinted bytes, or null when absent/unreadable. */
  hash: string | null;
}

/** The real user's home directory, resolved from the passwd database. */
export function realHomeDir(): string {
  return userInfo().homedir;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Deterministic serialization with object keys sorted at every level. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprintFile(full: string, rel: string): ConfigFingerprint {
  if (!existsSync(full)) return { path: rel, state: "absent", hash: null };
  try {
    return { path: rel, state: "present", hash: sha256(readFileSync(full)) };
  } catch {
    return { path: rel, state: "unreadable", hash: null };
  }
}

function fingerprintClaudeJson(full: string): ConfigFingerprint {
  if (!existsSync(full)) return { path: CLAUDE_JSON_SUBTREE, state: "absent", hash: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(full, "utf8"));
    // A parsed object with no OWN `mcpServers` property fingerprints as ABSENT —
    // the same subtree (none) as a file that does not exist. Claude Code
    // creates ~/.claude.json with only a `projects` key long before it writes
    // any mcpServers; treating that as "present" made an UNCHANGED subtree read
    // as a change and fail the lane (flair#1853 round 3).
    const hasMcpServers =
      parsed !== null &&
      typeof parsed === "object" &&
      Object.prototype.hasOwnProperty.call(parsed, "mcpServers");
    if (!hasMcpServers) return { path: CLAUDE_JSON_SUBTREE, state: "absent", hash: null };
    const sub = (parsed as Record<string, unknown>).mcpServers;
    return { path: CLAUDE_JSON_SUBTREE, state: "present", hash: sha256(canonical(sub ?? null)) };
  } catch {
    // A file we cannot parse is neither absent nor readable; record it so a
    // change from "unparseable" to anything else still registers.
    return { path: CLAUDE_JSON_SUBTREE, state: "unreadable", hash: null };
  }
}

/** Fingerprint the listed client configs under `home`. */
export function snapshotClientConfigs(home: string): ConfigFingerprint[] {
  const out = REAL_CLIENT_CONFIGS.map((rel) => fingerprintFile(join(home, rel), rel));
  out.push(fingerprintClaudeJson(join(home, ".claude.json")));
  return out;
}

/** Paths whose fingerprint differs between two snapshots (order-stable). */
export function changedConfigs(
  before: ConfigFingerprint[],
  after: ConfigFingerprint[],
): string[] {
  const afterByPath = new Map(after.map((f) => [f.path, f]));
  const changed: string[] = [];
  for (const b of before) {
    const a = afterByPath.get(b.path);
    if (!a || a.state !== b.state || a.hash !== b.hash) changed.push(b.path);
  }
  for (const a of after) {
    if (!before.some((b) => b.path === a.path)) changed.push(a.path);
  }
  return changed;
}

/**
 * Fingerprint the real client configs, run `body`, then re-fingerprint and
 * return the paths that changed. `home` is injectable so tests can point the
 * guard at a stand-in home instead of the real one.
 */
export function runGuarded(home: string, body: () => void): string[] {
  const before = snapshotClientConfigs(home);
  body();
  const after = snapshotClientConfigs(home);
  return changedConfigs(before, after);
}
