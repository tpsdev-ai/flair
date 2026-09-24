/**
 * Home-isolation guard (flair#1853).
 *
 * The lane sandboxes every test process in a throwaway HOME (bunfig.toml
 * preload + `scripts/test-unit.ts` child env). This is the backstop: it
 * fingerprints the REAL user's client config files before and after the lane and
 * fails if any of them changed, so a test that reaches around the sandbox is
 * caught rather than silently rewriting a developer's real config.
 *
 * The real home is resolved from the PASSWD entry for the current uid, NOT from
 * `process.env.HOME` — the lane deliberately sets HOME to a sandbox, so reading
 * home out of the environment is exactly the mistake this guard exists to catch.
 * Node's `os.userInfo()` reads the passwd database and ignores HOME, but BUN's
 * `os.userInfo().homedir` follows the HOME the process STARTED with, so the guard
 * asks a `node` child (HOME/USERPROFILE removed) rather than reading it
 * in-process. See realHomeDir().
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
import { join } from "node:path";
import { execFileSync } from "node:child_process";

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

/**
 * The real user's home directory, resolved from the passwd entry for the current
 * uid — never from `process.env.HOME`.
 *
 * In-process would not be enough: Node's `os.userInfo()` reads the passwd
 * database and ignores HOME, but Bun's `os.userInfo().homedir` follows the HOME
 * the process STARTED with, and the lane runs under Bun with a swapped HOME — so
 * reading it here could return the SANDBOX and fingerprint nothing at all. Ask a
 * `node` child with HOME/USERPROFILE removed instead. NEVER falls back to the
 * in-process `os.userInfo()`: under Bun that is exactly the value that can be the
 * sandbox, and a guard that silently fingerprints the sandbox passes after a real
 * config change. If node cannot answer, throw, so the lane fails loudly (fail closed).
 */
export function realHomeDir(): string {
  const env = { ...process.env };
  delete env.HOME;
  delete env.USERPROFILE;
  let out: string;
  try {
    out = execFileSync("node", ["-p", "require('node:os').userInfo().homedir"], {
      encoding: "utf8",
      env,
        // A hung `node` would hang the whole unit lane. Bound the probe so it
        // throws the same fail-closed "cannot resolve" error instead — never
        // fall back to the in-process value (flair#1865).
      timeout: 10_000,
         // A node child (or a preload) that traps/ignores SIGTERM would outlive the
         // default SIGTERM kill and keep the call blocked past the 10 s bound. SIGKILL
         // cannot be trapped, so the 10 s timeout is a real bound (flair#1865).
      killSignal: "SIGKILL",
    }).trim();
  } catch (err) {
    throw new Error(
      `home-isolation guard: cannot resolve the real home directory — running \`node\` to read the passwd entry failed (${(err as Error).message.split("\n")[0]}). ` +
        "Refusing to fall back to os.userInfo(), which follows HOME under Bun and would make this guard check the sandbox instead of the real client configs. Put node on PATH and re-run.",
    );
  }
  if (!out) {
    throw new Error(
      "home-isolation guard: `node` returned an empty home directory for the current user — refusing to guess. Check the passwd entry for this uid.",
    );
  }
  return out;
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
