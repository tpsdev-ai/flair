/**
 * Ed25519 request signing for Flair.
 *
 * Signs requests with: agentId:timestamp:nonce:METHOD:/path
 * Produces: TPS-Ed25519 agentId:timestamp:nonce:base64(signature)
 */

import { randomUUID, sign as ed25519Sign, createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readEnvOrUnset } from "./env-guard.js";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Resolve an Ed25519 private key from a file (base64 PKCS8 DER or raw 32-byte seed). */
export function loadPrivateKey(path: string): KeyObject {
  const raw = readFileSync(path);
  // Try as base64-encoded PKCS8 DER first
  const decoded = raw.length === 32 ? raw : Buffer.from(raw.toString("utf-8").trim(), "base64");
  const der = decoded.length === 32
    ? Buffer.concat([PKCS8_ED25519_PREFIX, decoded])
    : decoded;
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/**
 * Homes to probe, computed at CALL TIME (flair#1271).
 *
 * MCP hosts (npx under Cursor / Grok Bot / Claude Code) often have a different
 * env than the shell that ran `flair agent add`. `os.homedir()` is the
 * documented resolver — called here, not cached at module load — and we also
 * keep `$HOME` and `os.userInfo().homedir` when they differ so a sanitized
 * MCP `HOME` still finds `~/.flair/keys/<id>.key` on the real account home.
 *
 * Empty / relative values are dropped: `path.resolve("")` is cwd, which is
 * exactly the footgun this function exists to refuse.
 */
export function callTimeHomes(): string[] {
  const homes: string[] = [];
  const push = (h: string | undefined) => {
    if (h && isAbsolute(h) && !homes.includes(h)) homes.push(h);
  };
  push(homedir());
  push(process.env.HOME);
  try {
    push(userInfo().homedir);
  } catch {
    // No passwd entry (some containers). Skip — do not fall back to cwd.
  }
  return homes;
}

/** Expand a leading `~/` against `home`. Unexpanded `~` with no home is left intact. */
export function expandHomePrefix(p: string, home: string): string {
  if (p === "~") return home || p;
  if ((p.startsWith("~/") || p.startsWith("~\\")) && home) {
    return join(home, p.slice(2));
  }
  return p;
}

/**
 * Make `p` absolute without turning an unexpanded `~` into a cwd-relative path.
 * Operator-supplied relative paths (no `~`) still resolve against cwd.
 */
function toAbsoluteKeyPath(p: string): string | null {
  if (!p) return null;
  if (isAbsolute(p)) return p;
  if (p.startsWith("~")) return null;
  return resolve(p);
}

/** Candidate key files for `agentId`, in probe order. Deduplicated. */
export function keyPathCandidates(agentId: string, keyPath?: string): string[] {
  const homes = callTimeHomes();
  const primaryHome = homes[0] ?? "";

  if (keyPath) {
    const abs = toAbsoluteKeyPath(expandHomePrefix(keyPath, primaryHome));
    return abs ? [abs] : [];
  }

  const out: string[] = [];
  // flair#1254: an unsubstituted `${FLAIR_KEY_DIR}` literal reads as unset, so
  // key resolution falls through to the standard locations below instead of
  // probing a directory literally named "${FLAIR_KEY_DIR}".
  const keyDir = readEnvOrUnset("FLAIR_KEY_DIR");
  if (keyDir) {
    const absDir = toAbsoluteKeyPath(expandHomePrefix(keyDir, primaryHome));
    if (absDir) out.push(join(absDir, `${agentId}.key`));
  }
  for (const home of homes) {
    out.push(join(home, ".flair", "keys", `${agentId}.key`));
    out.push(join(home, ".tps", "secrets", "flair", `${agentId}-priv.key`));
  }
  return [...new Set(out)];
}

/** Snapshot of a key-file lookup — attached to 401/403 so the error can name paths. */
export interface KeyLookupState {
  agentId: string;
  /** `os.homedir()` at lookup time (may be empty if it was unusable). */
  home: string;
  candidates: { path: string; exists: boolean }[];
  resolvedPath: string | null;
  /** True when this request carried an Ed25519 Authorization header. */
  signed: boolean;
}

/** Inspect standard key locations. Does not cache — call at request time (flair#1271). */
export function inspectKeyLookup(agentId: string, keyPath?: string): Omit<KeyLookupState, "signed"> {
  const candidates = keyPathCandidates(agentId, keyPath).map((path) => ({
    path,
    exists: existsSync(path),
  }));
  return {
    agentId,
    home: callTimeHomes()[0] ?? "",
    candidates,
    resolvedPath: candidates.find((c) => c.exists)?.path ?? null,
  };
}

/** Find the agent's private key file from standard locations. */
export function resolveKeyPath(agentId: string, keyPath?: string): string | null {
  return inspectKeyLookup(agentId, keyPath).resolvedPath;
}

/** Actor + state + remedy for a 401/403 (flair#1271). */
export function formatKeyLookup(state: KeyLookupState): string {
  const actor = state.agentId
    ? `agent '${state.agentId}'`
    : "this agent (FLAIR_AGENT_ID unset)";
  const stateLine = state.signed
    ? `${actor} signed with ${state.resolvedPath}.`
    : `${actor} sent this request without a signing key.`;
  const homeLine = `os.homedir() at lookup: ${state.home || "(empty — refused to fall back to cwd)"}`;
  const looked = state.candidates.length === 0
    ? "Looked for a key at: (no candidate paths — home could not be resolved)."
    : [
        "Looked for a key at:",
        ...state.candidates.map((c) => `  ${c.path} (${c.exists ? "found" : "missing"})`),
      ].join("\n");
  const remedy = state.signed
    ? "The server rejected the signature. Confirm the agent is registered (`flair agent add <id>`) and this key matches the Agent record. A daemon restart can also produce this — check `flair status`."
    : "If `flair agent add` wrote the key, this process's home may differ from that shell, or the file appeared after an earlier lookup. Retry the tool (misses are no longer cached). Still missing? Set FLAIR_KEY_PATH to the absolute path of the .key file.";
  return `${stateLine}\n${homeLine}\n${looked}\n${remedy}`;
}

/** Build an Authorization header for a Flair request. */
export function signRequest(
  agentId: string,
  privateKey: KeyObject,
  method: string,
  path: string,
): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agentId}:${ts}:${nonce}:${method}:${path}`;
  const sig = ed25519Sign(null, Buffer.from(payload), privateKey);
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sig.toString("base64")}`;
}
