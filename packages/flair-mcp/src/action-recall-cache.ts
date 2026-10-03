/**
 * Action recall (flair#2067 slice 2) — the on-disk cache.
 *
 * Owns the location, the atomic write, the access rules and the integrity
 * checks for the reader-specific cache of the agent's own lessons. The pure
 * format and grammar live in ./action-recall.ts; this module only touches the
 * filesystem. The hot path (./action-recall-hook.ts) uses the READ half and
 * must never let a bad cache, a slow read or a missing file produce output: a
 * refusal here is a silent no-op there.
 *
 * Location: `<root>/<H(url)>/<H(principal)>/<H(session)>/`, where root is
 * installer/env-resolved (`FLAIR_ACTION_RECALL_DIR`, else `~/.flair/action-recall`)
 * — never taken from hook input. Directories are 0700, files 0600; writes use
 * exclusive temp creation and atomic rename, publishing the binding last.
 */

import { constants as fsConstants } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, chmod, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  BINDING_MAX_BYTES,
  CACHE_MAX_BYTES,
  CACHE_VERSION,
  MAX_SESSION_CACHES,
  decodeBinding,
  decodeEnvelope,
  encodeBinding,
  encodeEnvelope,
  sha256Hex,
  type CacheBinding,
  type CachePayload,
} from "./action-recall.js";

/** The cache root: env override, else `~/.flair/action-recall`. */
export function resolveCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FLAIR_ACTION_RECALL_DIR;
  if (typeof override === "string" && override.trim() !== "" && isAbsolute(override)) return override;
  const home = (process.platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  return join(home, ".flair", "action-recall");
}

/** `<root>/<H(url)>/<H(principal)>/<H(session)>/`. */
export function sessionDir(root: string, url: string, principal: string, session: string): string {
  return join(root, sha256Hex(url), sha256Hex(principal), sha256Hex(session));
}

/** The binding file for a session directory. */
export function bindingPath(dir: string): string {
  return join(dir, "current.json");
}

/** A generation file: `<session>/<H(instance)>/<generation>.json`. */
export function generationPath(dir: string, instance: string, generation: string): string {
  return join(dir, sha256Hex(instance), `${generation}.json`);
}

export type SecureRead = { ok: true; text: string } | { ok: false; reason: string };

const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

async function lstatOrNull(p: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

/** No component of `filePath` may be a symlink. */
async function noSymlinkComponents(filePath: string): Promise<boolean> {
  const parts = resolve(filePath).split(sep).filter(Boolean);
  let cur: string = sep;
  for (const part of parts) {
    cur = join(cur, part);
    const st = await lstatOrNull(cur);
    if (!st || st.isSymbolicLink()) return false;
  }
  return true;
}

/** A directory we created: 0700 and owned by us. */
async function isPrivateDir(dir: string): Promise<boolean> {
  const st = await lstatOrNull(dir);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return false;
  if ((Number(st.mode) & 0o777) !== 0o700) return false;
  if (uid !== undefined && st.uid !== uid) return false;
  return true;
}

/**
 * Read a regular file of at most `maxBytes` with no symlink component, an
 * owner-only mode, a single link and a stable size. Any failure is a refusal,
 * never an empty result. The open is no-follow and non-blocking; the opened
 * descriptor is re-checked, and a file that grows during the read is refused.
 */
export async function readSecureFile(filePath: string, maxBytes: number): Promise<SecureRead> {
  if (!(await noSymlinkComponents(filePath))) return { ok: false, reason: "symlink-component" };
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return { ok: false, reason: "open" };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { ok: false, reason: "not-regular" };
    if ((Number(st.mode) & 0o777) !== 0o600) return { ok: false, reason: "mode" };
    if (uid !== undefined && st.uid !== uid) return { ok: false, reason: "owner" };
    if (st.nlink !== 1) return { ok: false, reason: "hardlink" };
    if (st.size > maxBytes) return { ok: false, reason: "oversized" };
    const buf = Buffer.alloc(st.size + 1);
    let length = 0;
    while (length < buf.length) {
      const { bytesRead } = await handle.read(buf, length, buf.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > st.size) return { ok: false, reason: "growing" };
    return { ok: true, text: buf.subarray(0, length).toString("utf8") };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Read and validate the session binding. Returns the binding only when the
 * session directory is private, the file is secure and its content decodes.
 * A missing, unreadable or malformed binding is null (silence).
 */
export async function readBinding(
  dir: string,
  expected: { url: string; principal: string; session: string },
): Promise<CacheBinding | null> {
  if (!(await isPrivateDir(dir))) return null;
  const read = await readSecureFile(bindingPath(dir), BINDING_MAX_BYTES);
  if (!read.ok) return null;
  const binding = decodeBinding(read.text);
  if (!binding) return null;
  if (binding.url !== expected.url || binding.principal !== expected.principal || binding.session !== expected.session) {
    return null;
  }
  return binding;
}

/**
 * Read and validate the generation a binding points at, then verify the
 * payload's bindings and age. Returns null on any failure (missing, corrupt,
 * digest mismatch, wrong bindings, expired).
 */
export async function readGeneration(dir: string, binding: CacheBinding, now: number): Promise<CachePayload | null> {
  const file = generationPath(dir, binding.instance, binding.generation);
  if (!(await isPrivateDir(join(dir, sha256Hex(binding.instance))))) return null;
  const read = await readSecureFile(file, CACHE_MAX_BYTES);
  if (!read.ok) return null;
  const payload = decodeEnvelope(read.text);
  if (!payload) return null;
  if (
    payload.url !== binding.url ||
    payload.principal !== binding.principal ||
    payload.session !== binding.session ||
    payload.instance !== binding.instance ||
    payload.generation !== binding.generation
  ) {
    return null;
  }
  if (payload.refreshStart > now + 60_000) return null; // future refresh stamp
  if (payload.expiry <= now) return null; // expired generation
  return payload;
}

/** Create `dir` (and parents) as 0700, fixing the mode if it already exists loose. */
async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/** Write one file atomically (exclusive temp, fsync, rename), mode 0600. */
async function writeFileAtomic(filePath: string, text: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
  await rename(tmp, filePath);
}

export interface PublishResult {
  ok: boolean;
  generation?: string;
  reason?: string;
}

/**
 * Publish a generation and bind the session to it. Writes the generation file
 * first, then the binding file LAST, so a failed write leaves no usable
 * binding. `generation` and `instance` come from the caller (both from the
 * refresh).
 */
export async function publishGeneration(dir: string, payload: CachePayload): Promise<PublishResult> {
  try {
    await ensurePrivateDir(join(dir, sha256Hex(payload.instance)));
    await writeFileAtomic(generationPath(dir, payload.instance, payload.generation), encodeEnvelope(payload));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "write" };
  }
  const binding: CacheBinding = {
    v: CACHE_VERSION,
    url: payload.url,
    principal: payload.principal,
    session: payload.session,
    instance: payload.instance,
    generation: payload.generation,
  };
  try {
    await writeFileAtomic(bindingPath(dir), encodeBinding(binding));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "bind" };
  }
  return { ok: true, generation: payload.generation };
}

/** Invalidate the session binding before a refresh begins reading. */
export async function invalidateBinding(dir: string): Promise<void> {
  await rm(bindingPath(dir), { force: true }).catch(() => {});
}

/**
 * Take an exclusive per-session lock for the duration of a refresh. Returns a
 * release function, or null when another refresh holds it (this refresh then
 * does nothing). Serializes same-session refreshes.
 */
export async function acquireRefreshLock(dir: string): Promise<(() => Promise<void>) | null> {
  const lockPath = join(dir, "refresh.lock");
  try {
    await ensurePrivateDir(dir);
    const handle = await open(lockPath, "wx", 0o600);
    await handle.close();
  } catch {
    return null;
  }
  return async () => {
    await rm(lockPath, { force: true }).catch(() => {});
  };
}

/** Remove generation files (and their instance dirs) other than the current one. */
export async function cleanupOldGenerations(dir: string, instance: string, generation: string): Promise<void> {
  const keepInstance = sha256Hex(instance);
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "current.json" || name === "refresh.lock" || name === keepInstance) continue;
    const target = join(dir, name);
    try {
      const st = await lstat(target);
      if (st.isDirectory()) await rm(target, { recursive: true, force: true });
    } catch {
      // off the hot path; a failed cleanup is not an error
    }
  }
  try {
    const instDir = join(dir, keepInstance);
    for (const name of await readdir(instDir)) {
      if (name === `${generation}.json`) continue;
      await rm(join(instDir, name), { force: true });
    }
  } catch {
    // ignore
  }
}

/** Retain at most MAX_SESSION_CACHES session directories per principal, oldest evicted. */
export async function pruneSessionCaches(root: string, url: string, principal: string): Promise<void> {
  const principalDir = join(root, sha256Hex(url), sha256Hex(principal));
  let entries;
  try {
    entries = await readdir(principalDir);
  } catch {
    return;
  }
  const withTime: Array<{ name: string; mtime: number }> = [];
  for (const name of entries) {
    const st = await lstatOrNull(join(principalDir, name));
    if (st && st.isDirectory()) withTime.push({ name, mtime: Number(st.mtimeMs) });
  }
  withTime.sort((a, b) => b.mtime - a.mtime);
  for (const stale of withTime.slice(MAX_SESSION_CACHES)) {
    await rm(join(principalDir, stale.name), { recursive: true, force: true }).catch(() => {});
  }
}

/** Whether the session directory exists (best-effort; used by doctor/status). */
export async function sessionDirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
