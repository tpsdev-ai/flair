/**
 * agent-key-file.ts — the shared agent private-key file helper for the five
 * provisioning paths (flair#3077 slice A): `flair agent add`, local
 * `flair init --agent/--agent-id`, remote `flair init --target ... --agent-id`,
 * `flair principal add`, and `flair import`. `flair agent rotate-key` (slice B)
 * stages and replaces through this helper; `flair mcp grant` creates its key
 * files through it (slice C).
 *
 * POSIX policy:
 *   - every ancestor of the keys directory's resolved path, up to `/`, must be
 *     owned by root or the current user and must not be group- or
 *     world-writable unless it carries the sticky bit; a failing ancestor is
 *     refused with its owner and mode, the first failing one named. This runs
 *     before the keys directory is created or its mode is changed. Inside
 *     flair's home (`~/.flair`, the parent of the default keys directory, when
 *     it is a directory and not a symlink) an ancestor the current user owns
 *     has its group and world write bits removed instead, with one notice
 *     naming it and its old and new modes, and the walk continues; an ancestor
 *     there that the current user does not own is never tightened; it is
 *     checked by the rule above.
 *   - the keys directory is requested with mode 0700 (the umask may make it
 *     narrower); an existing directory owned by the current user is tightened
 *     to 0700 when it has group or world bits, with one notice line; a symlink,
 *     a non-directory, or a directory owned by another user is refused.
 *   - provisioning writes a new key to a unique temp file in the keys directory
 *     (O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600), fsynced, then published with a
 *     hard link at the final path, so an occupied path is never overwritten.
 *     The checked keys directory is opened once and its device and inode are
 *     held: the key path's parent is compared with that descriptor after the
 *     link, and the sync uses the held descriptor.
 *   - an existing key is checked on the OPENED DESCRIPTOR: a regular file,
 *     owned by the current user, with no group/world bits. It is read and left
 *     untouched; a file with group or world bits is refused before its bytes
 *     are read.
 *
 * win32: mode bits do not establish owner-only there; the create path sets the
 * mode and the reuse path neither checks nor sets it.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { defaultKeysDir } from "./key-dir.js";

/** A refusal is operator-facing: the caller prints the message and exits 1. */
export class AgentKeyFileRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentKeyFileRefusal";
  }
}

/** Test hooks; production leaves these unset. */
export interface AgentKeyFileTestHooks {
  /** Runs with the created key's descriptor before the first byte is written. */
  beforeFirstWrite?: (fd: number) => void;
  /** Replaces the seed write and returns the byte count a real write would. */
  writeSeedFile?: (fd: number, bytes: Buffer) => number;
  /** Runs before the keys directory is created, to stand in for another process. */
  beforeKeysDirCreate?: (dir: string) => void;
  /** Runs after the keys directory is created, before anything else touches it. */
  afterKeysDirCreate?: (dir: string) => void;
  /** Runs after the keys directory is checked and before it is opened and held. */
  beforeKeysDirOpen?: (dir: string) => void;
  /** Runs after the keys directory is checked and held, before the key is written. */
  afterKeysDirCheck?: (dir: string) => void;
  /** Runs with the opened key descriptor immediately before its bytes are read. */
  beforeKeyRead?: (fd: number) => void;
  /** Runs after the temp key is complete and before it is linked into place. */
  beforePublish?: (tempPath: string, finalPath: string) => void;
  /** Runs with the final path immediately after the hard link is made. */
  afterPublish?: (finalPath: string) => void;
  syncKeysDir?: (fd: number) => void;
}

let testHooks: AgentKeyFileTestHooks | undefined;

export function setAgentKeyFileTestHooks(hooks: AgentKeyFileTestHooks | undefined): void {
  testHooks = hooks;
}

/**
 * Device + inode of a key file, recorded from the temp file's own descriptor
 * before it is published. Cleanup removes a path only if, when checked, it
 * still names the file this grant created; a path swapped between that check
 * and the unlink can still be removed, which a POSIX unlink by name cannot
 * prevent. On POSIX the keys directory has no group or world permissions: a new
 * directory requests 0700, and an existing narrower one keeps its mode.
 */
export interface KeyFileIdentity {
  dev: number;
  ino: number;
}

export interface AgentKeysDirHandle {
  path: string;
  /** Descriptor held on the checked keys directory. */
  fd: number;
  dev: number;
  ino: number;
}

export interface AgentKeyFileContents {
  /** The raw bytes stored in (or read from) the key file. */
  bytes: Uint8Array;
  /** True when this call created the file. */
  created: boolean;
}

export interface AgentKeyForRotation {
  /** The raw bytes of the key being replaced. */
  bytes: Uint8Array;
  /** True when the key had group or world permission bits. */
  widerThanOwnerOnly: boolean;
}

const WIN32 = process.platform === "win32";
const NOFOLLOW = WIN32 ? 0 : constants.O_NOFOLLOW;
const O_NONBLOCK = WIN32 ? 0 : constants.O_NONBLOCK;

function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" ? code : undefined;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function modeText(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/**
 * Refuse a symlink, a non-directory or another owner; tighten an owned
 * directory with group or world bits. Shared by an existing directory and one
 * this call just created, so neither is trusted on the strength of its path.
 */
function checkAgentKeysDir(keysDir: string): Stats {
  const st = lstatSync(keysDir);
  if (st.isSymbolicLink()) {
    throw new AgentKeyFileRefusal(
      `keys directory ${keysDir} is a symlink; replace it with a real directory you own (mode 700)`,
    );
  }
  if (!st.isDirectory()) {
    throw new AgentKeyFileRefusal(
      `keys directory ${keysDir} is not a directory; move it aside and run again so flair can create a directory (mode 700)`,
    );
  }
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) {
    throw new AgentKeyFileRefusal(
      `keys directory ${keysDir} is not owned by the current user; move it aside and run again so flair can create a directory (mode 700)`,
    );
  }
  if ((st.mode & 0o077) !== 0) {
    chmodSync(keysDir, 0o700);
    console.log(`Keys directory ${keysDir} was accessible to other users; permissions tightened to 0700.`);
  }
  return st;
}

function modeWithSpecial(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/**
 * Real path of flair's home (`~/.flair`), read once per ancestor walk; none
 * when it is absent, a symlink or not a directory, so nothing is tightened.
 */
function flairHomeDir(): string | undefined {
  const home = dirname(defaultKeysDir());
  let st: Stats;
  try {
    st = lstatSync(home);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return undefined;
  return realpathSync(home);
}

/**
 * Real path of the first directory the ancestor walk checks: the parent of the
 * keys directory's resolved path, or, when the keys directory does not exist
 * yet, its nearest existing ancestor.
 */
function firstKeysDirAncestor(keysDir: string): string {
  let path = resolve(keysDir);
  try {
    return dirname(realpathSync(path));
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
  for (;;) {
    const parent = dirname(path);
    if (parent === path) return path;
    path = parent;
    try {
      return realpathSync(path);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
  }
}

/** True when `path` is `dir` or below it. Both are real paths. */
function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

/**
 * On POSIX, refuse a keys directory with an ancestor that another user can
 * change: every ancestor of the keys directory's resolved path up to `/` must
 * be owned by root or the current user and must not be group- or
 * world-writable unless it carries the sticky bit.
 * Inside flair's home (when `~/.flair` is a directory, not a symlink), an
 * ancestor owned by the current user has its group and world write bits
 * removed instead, with one notice, because an existing install can carry them
 * from a umask 002 host.
 * A refusal names the first failing ancestor (nearest the keys directory) with
 * its owner and mode.
 */
function assertAgentKeysDirAncestors(keysDir: string): void {
  if (WIN32) return;
  const uid = currentUid();
  const home = flairHomeDir();
  let ancestor = firstKeysDirAncestor(keysDir);
  for (;;) {
    const st = lstatSync(ancestor);
    const otherWritable = (st.mode & 0o022) !== 0;
    const sticky = (st.mode & 0o1000) !== 0;
    const foreignOwner = uid !== undefined && st.uid !== 0 && st.uid !== uid;
    if (foreignOwner) {
      throw new AgentKeyFileRefusal(
        `keys directory ${keysDir} has ancestor ${ancestor} owned by uid ${st.uid} with mode ${modeWithSpecial(st.mode)}; ` +
          `another user can change that ancestor, so the keys directory cannot be trusted. ` +
          `Move the keys directory, or make ${ancestor} owned by root or the current user and not group- or world-writable ` +
          `(or set its sticky bit), then retry`,
      );
    }
    if (otherWritable) {
      if (uid !== undefined && st.uid === uid && home !== undefined && isInside(ancestor, home)) {
        const oldMode = st.mode & 0o7777;
        const newMode = oldMode & ~0o022;
        chmodSync(ancestor, newMode);
        console.log(
          `Directory ${ancestor} in the flair home was accessible to other users; permissions tightened from ${modeWithSpecial(oldMode)} to ${modeWithSpecial(newMode)}.`,
        );
      } else if (!sticky) {
        throw new AgentKeyFileRefusal(
          `keys directory ${keysDir} has ancestor ${ancestor} owned by uid ${st.uid} with mode ${modeWithSpecial(st.mode)}; ` +
            `another user can change that ancestor, so the keys directory cannot be trusted. ` +
            `Move the keys directory, or make ${ancestor} owned by root or the current user and not group- or world-writable ` +
            `(or set its sticky bit), then retry`,
        );
      }
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
}

/**
 * On POSIX, check the keys directory and then open it once, holding the
 * descriptor for the write. The held descriptor's device and inode must match
 * the directory that was checked; a directory swapped in between is refused.
 */
function openCheckedAgentKeysDir(keysDir: string): AgentKeysDirHandle {
  assertAgentKeysDirAncestors(keysDir);
  const checked = checkAgentKeysDir(keysDir);
  testHooks?.beforeKeysDirOpen?.(keysDir);
  let fd: number;
  try {
    fd = openSync(keysDir, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
  } catch (error) {
    if (errnoCode(error) === "ELOOP") {
      throw new AgentKeyFileRefusal(
        `keys directory ${keysDir} is a symlink; replace it with a real directory you own (mode 700)`,
      );
    }
    throw error;
  }
  try {
    const held = fstatSync(fd);
    if (!held.isDirectory() || held.dev !== checked.dev || held.ino !== checked.ino) {
      throw new AgentKeyFileRefusal(
        `keys directory ${keysDir} changed while it was being checked; retry the command once the directory is stable`,
      );
    }
    return { path: keysDir, fd, dev: held.dev, ino: held.ino };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * On POSIX, refuse when the key path's parent is no longer the keys directory
 * whose descriptor was held. Called after the key is linked into place.
 */
function assertKeyPathStillBound(
  handle: AgentKeysDirHandle,
  privateKeyPath: string,
  identity: KeyFileIdentity,
): void {
  const parent = dirname(privateKeyPath);
  let matches = false;
  try {
    const st = lstatSync(parent);
    matches = st.isDirectory() && st.dev === handle.dev && st.ino === handle.ino;
  } catch {
    matches = false;
  }
  if (!matches) {
    const removed = removePublishedKey(privateKeyPath, identity);
    const keyState = removed
      ? `the key it wrote at ${privateKeyPath} was removed`
      : `the key path no longer names the file this command wrote, so a key linked into the checked directory before it moved was not removed`;
    throw new AgentKeyFileRefusal(
      `keys directory ${handle.path} changed after the key was written; ${keyState}. ` +
        `Retry once the directory is stable`,
    );
  }
}

/** Remove a published key path only when it still names the file this call wrote. */
function removePublishedKey(privateKeyPath: string, identity: KeyFileIdentity): boolean {
  try {
    const st = lstatSync(privateKeyPath);
    if (st.isFile() && st.dev === identity.dev && st.ino === identity.ino) {
      unlinkSync(privateKeyPath);
      return true;
    }
    return false;
  } catch {
    /* best effort: the path may already be gone or replaced */
    return false;
  }
}

/**
 * On POSIX, request mode 0700 for a missing `keysDir` (the umask may make it
 * narrower), check the path after creation like an existing directory, sync
 * the created directory's parent, and tighten an owned directory; a symlink, a
 * non-directory or another owner is refused. The ancestor rule runs first,
 * before the directory is created or its mode is changed. A retry with
 * `keysDir` already present repeats the parent sync. On Windows the directory
 * is created and returned unchecked.
 */
export function ensureAgentKeysDir(keysDir: string): void {
  if (WIN32) {
    mkdirSync(keysDir, { recursive: true });
    return;
  }

  assertAgentKeysDirAncestors(keysDir);
  let missing = false;
  try {
    lstatSync(keysDir);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
    missing = true;
  }

  if (missing) {
    // The directory is owner-only from creation: the umask can only narrow the
    // mode, never widen it past 0700. No later chmod is involved.
    testHooks?.beforeKeysDirCreate?.(keysDir);
    const firstCreated = mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    testHooks?.afterKeysDirCreate?.(keysDir);
    // A recursive mkdir also succeeds when another process created the path
    // first, so the path is checked like any existing directory before use.
    checkAgentKeysDir(keysDir);
    if (firstCreated !== undefined) {
      for (let created = keysDir; ; created = dirname(created)) {
        if ([".", ".."].includes(basename(created))) continue;
        syncKeysParent(created, `new keys directory ${keysDir}`);
        if (resolve(created) === resolve(firstCreated)) break;
      }
    } else {
      // Another process created the directory between the check and this
      // mkdir; its entry in its parent still needs the same sync.
      syncKeysParent(keysDir, `keys directory ${keysDir}`);
    }
    return;
  }

  checkAgentKeysDir(keysDir);
  // A retry repeats the sync of the keys directory's own entry in its parent.
  // Upper levels a recursive first run created are synced only by that first run.
  syncKeysParent(keysDir, `keys directory ${keysDir}`);
}

/**
 * On POSIX, sync the parent of a directory entry so the entry survives a
 * crash; a failure refuses with `subject` named as unconfirmed durable.
 */
function syncKeysParent(created: string, subject: string): void {
  let parent = dirname(created);
  try {
    parent = realpathSync(parent);
    syncAgentKeysDir(parent);
  } catch (error) {
    throw new AgentKeyFileRefusal(
      `flair could not sync parent directory ${parent} (${error instanceof Error ? error.message : String(error)}); ` +
        `${subject} is not confirmed durable; check the directory and filesystem, then retry`,
    );
  }
}

/**
 * Read an existing key, or return null when the path does not exist. On POSIX,
 * check the opened descriptor and refuse symlinks. Windows reads by path.
 */
export function readExistingAgentKey(privateKeyPath: string): Uint8Array | null {
  if (WIN32) {
    try {
      return new Uint8Array(readFileSync(privateKeyPath));
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  // O_NOFOLLOW covers the last component; lstat gives the clearer refusal for
  // a link that was already there when the command started.
  try {
    if (lstatSync(privateKeyPath).isSymbolicLink()) {
      throw new AgentKeyFileRefusal(
        `key file ${privateKeyPath} is a symlink; remove it and run again so flair can create a new owner-only key`,
      );
    }
  } catch (error) {
    if (error instanceof AgentKeyFileRefusal) throw error;
    if (errnoCode(error) !== "ENOENT") throw error;
    return null;
  }

  let fd: number;
  try {
    fd = openSync(privateKeyPath, constants.O_RDONLY | NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (errnoCode(error) === "ELOOP") {
      throw new AgentKeyFileRefusal(
        `key file ${privateKeyPath} is a symlink; remove it and run again so flair can create a new owner-only key`,
      );
    }
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new AgentKeyFileRefusal(
        `key file ${privateKeyPath} is not a regular file; remove it and run again so flair can create a new owner-only key`,
      );
    }
    const uid = currentUid();
    if (uid !== undefined && st.uid !== uid) {
      throw new AgentKeyFileRefusal(
        `key file ${privateKeyPath} is owned by another user; move it aside and run again so flair can create a new owner-only key`,
      );
    }
    if ((st.mode & 0o077) !== 0) {
      throw new AgentKeyFileRefusal(
        `key file ${privateKeyPath} is accessible to other users (mode ${modeText(st.mode)}); ` +
          `run chmod 600 ${privateKeyPath} to make it owner-only`,
      );
    }
    testHooks?.beforeKeyRead?.(fd);
    return new Uint8Array(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

/**
 * On POSIX, read through a no-follow descriptor and refuse symlinks,
 * non-regular files and foreign owners; Windows reads by path.
 * A wide POSIX mode is reported; successful rotation replaces the file.
 */
export function readAgentKeyForRotation(privateKeyPath: string): AgentKeyForRotation | null {
  if (WIN32) {
    try {
      return { bytes: new Uint8Array(readFileSync(privateKeyPath)), widerThanOwnerOnly: false };
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  let fd: number;
  try {
    fd = openSync(privateKeyPath, constants.O_RDONLY | NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    if (errnoCode(error) === "ELOOP") {
      throw new AgentKeyFileRefusal(
        `key file ${privateKeyPath} is a symlink; replace it with a real key file you own and run again`,
      );
    }
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new AgentKeyFileRefusal(
        `key file ${privateKeyPath} is not a regular file; replace it with a real key file you own and run again`,
      );
    }
    const uid = currentUid();
    if (uid !== undefined && st.uid !== uid) {
      throw new AgentKeyFileRefusal(
        `key file ${privateKeyPath} is owned by another user; move it aside and run again so flair can create a new owner-only key`,
      );
    }
    testHooks?.beforeKeyRead?.(fd);
    return { bytes: new Uint8Array(readFileSync(fd)), widerThanOwnerOnly: (st.mode & 0o077) !== 0 };
  } finally {
    closeSync(fd);
  }
}

/**
 * Write `data` to a unique temp file in `privateKeyPath`'s directory, at 0600
 * from creation and fsynced, and return the temp path. The temp file is this
 * call's to hand on: the caller publishes or removes it.
 */
function writeAgentKeyTemp(
  privateKeyPath: string,
  bytes: Buffer,
  onCreated?: (path: string, identity: KeyFileIdentity) => void,
): { path: string; identity: KeyFileIdentity } {
  if (!WIN32) assertAgentKeysDirAncestors(dirname(privateKeyPath));
  const tempPrefix = `.${basename(privateKeyPath)}.tmp-`;
  const maxTempAttempts = 5;
  let fd: number | undefined;
  let tempPath = "";
  let tempCreated = false;
  let attempt = 0;
  while (fd === undefined) {
    attempt += 1;
    const candidate = join(dirname(privateKeyPath), `${tempPrefix}${randomBytes(8).toString("hex")}`);
    try {
      fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      tempPath = candidate;
      tempCreated = true;
    } catch (error) {
      if (errnoCode(error) === "EEXIST" && attempt < maxTempAttempts) continue;
      throw error;
    }
  }
  try {
    const created = fstatSync(fd);
    const identity = { dev: created.dev, ino: created.ino };
    onCreated?.(tempPath, identity);
    // The open mode is narrowed by the umask; set it exactly, still before the
    // first byte, so the protection is the mode the file is created with.
    fchmodSync(fd, 0o600);
    testHooks?.beforeFirstWrite?.(fd);
    const writer = testHooks?.writeSeedFile ?? ((target: number, value: Buffer) => writeSync(target, value));
    let offset = 0;
    while (offset < bytes.length) {
      const written = writer(fd, bytes.subarray(offset));
      if (written <= 0) {
        throw new Error(
          `short write to key file ${privateKeyPath}: wrote ${written} bytes with ${bytes.length - offset} left`,
        );
      }
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    return { path: tempPath, identity };
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already failing */
      }
    }
    if (tempCreated) {
      try {
        unlinkSync(tempPath);
      } catch {
        /* best effort: remove only the temp file this call created */
      }
    }
    throw error;
  }
}

/**
 * Create a new key file at 0600 from the first byte, refusing to replace an
 * existing path. The bytes go to a unique temp file in the same directory and
 * are published with a hard link, so an occupied path is never overwritten.
 * A temp name that is already taken is retried with a new random suffix; the
 * occupying entry is left untouched. On failure the temp file this call
 * created is removed, best effort.
 */
export function createAgentKeyFile(
  privateKeyPath: string,
  data: string | Uint8Array,
  onCreated?: (path: string, identity: KeyFileIdentity) => void,
): void {
  const keysDir = dirname(privateKeyPath);
  const handle = WIN32 ? undefined : openCheckedAgentKeysDir(keysDir);
  let temp: { path: string; identity: KeyFileIdentity };
  try {
    testHooks?.afterKeysDirCheck?.(keysDir);
    temp = writeAgentKeyTemp(privateKeyPath, Buffer.from(data), onCreated);
  } catch (error) {
    if (handle) closeSync(handle.fd);
    throw error;
  }
  let linked = false;
  try {
    testHooks?.beforePublish?.(temp.path, privateKeyPath);
    // linkSync fails with EEXIST when the final path appears before publication.
    linkSync(temp.path, privateKeyPath);
    linked = true;
    testHooks?.afterPublish?.(privateKeyPath);
    if (handle) assertKeyPathStillBound(handle, privateKeyPath, temp.identity);
    // The hard link initially publishes the temp file's inode at the final
    // path; the identity recorded from the temp descriptor stays that inode
    // even if the path is replaced later. Never re-derive it from the path.
    onCreated?.(privateKeyPath, temp.identity);
  } catch (error) {
    if (linked) removePublishedKey(privateKeyPath, temp.identity);
    try {
      unlinkSync(temp.path);
    } catch {
      /* best effort: remove only the temp file this call created */
    }
    if (handle) closeSync(handle.fd);
    throw error;
  }
  try {
    unlinkSync(temp.path);
  } catch {
    /* the published key is complete; a leftover temp file is mode 0600 */
  }
  if (handle) {
    try {
      // The held descriptor is the directory that passed the check: sync it,
      // never a fresh open of the path.
      (testHooks?.syncKeysDir ?? fsyncSync)(handle.fd);
    } catch (error) {
      closeSync(handle.fd);
      const removed = removePublishedKey(privateKeyPath, temp.identity);
      const keyState = removed
        ? `the published key ${privateKeyPath} was removed because it is not confirmed durable`
        : `the published key ${privateKeyPath} is not confirmed durable, and the key path no longer names the file this command wrote`;
      throw new AgentKeyFileRefusal(
        `flair could not sync keys directory ${keysDir} (${error instanceof Error ? error.message : String(error)}); ` +
          `${keyState}; check the directory and filesystem, then retry`,
      );
    }
    closeSync(handle.fd);
  } else {
    // On POSIX, sync the key's directory before returning so the entry is durable
    // before the caller registers the key; a failure refuses.
    try {
      syncAgentKeysDir(keysDir);
    } catch (error) {
      throw new AgentKeyFileRefusal(
        `flair could not sync keys directory ${keysDir} (${error instanceof Error ? error.message : String(error)}); ` +
          `published key ${privateKeyPath} is not confirmed durable; check the directory and filesystem, then retry`,
      );
    }
  }
}

export function createAgentKeyBackup(privateKeyPath: string, data: Uint8Array): void {
  const bytes = Buffer.from(data);
  // Exclusive creation preserves occupied backups without requiring hard links.
  const fd = openSync(privateKeyPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    testHooks?.beforeFirstWrite?.(fd);
    const writer = testHooks?.writeSeedFile ?? ((target: number, value: Buffer) => writeSync(target, value));
    let offset = 0;
    while (offset < bytes.length) {
      const written = writer(fd, bytes.subarray(offset));
      if (written <= 0) throw new Error(`short write to backup ${privateKeyPath}`);
      offset += written;
    }
    fsyncSync(fd);
    const reread = Buffer.alloc(bytes.length);
    offset = 0;
    while (offset < reread.length) {
      const count = readSync(fd, reread, offset, reread.length - offset, offset);
      if (count === 0) throw new Error(`short read from backup ${privateKeyPath}`);
      offset += count;
    }
    if (fstatSync(fd).size !== bytes.length || !reread.equals(bytes)) {
      throw new Error(`backup ${privateKeyPath} does not match the current key`);
    }
  } catch (error) {
    try { unlinkSync(privateKeyPath); } catch { /* best effort */ }
    throw error;
  } finally {
    closeSync(fd);
  }
}

/** UTC filename stamp without colons or periods; sorts by time. */
export function rotationBackupStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function isAgentKeyRotationBackup(name: string, privateKeyName: string): boolean {
  const prefix = `${privateKeyName}.bak.`;
  if (!name.startsWith(prefix)) return false;
  const stamp = name.slice(prefix.length);
  const [date, time] = stamp.split("T");
  if (!time) return false;
  const parsed = new Date(`${date}T${time.slice(0, 8).replace(/-/g, ":")}.${time.slice(9)}`);
  return Number.isFinite(parsed.getTime()) && rotationBackupStamp(parsed) === stamp;
}

function syncAgentKeysDir(directory: string): void {
  // Windows cannot open directories for fsync.
  if (WIN32) return;
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
  try {
    (testHooks?.syncKeysDir ?? fsyncSync)(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write `data` to a unique 0600 temp file beside `privateKeyPath` and leave it
 * staged. A failure sends nothing and attempts to remove only the temp file
 * this call created (best effort).
 */
export function stageAgentKeyFile(privateKeyPath: string, data: string | Uint8Array): string {
  const tempPath = writeAgentKeyTemp(privateKeyPath, Buffer.from(data)).path;
  let directory = dirname(privateKeyPath);
  let kind = "keys";
  try {
    // On POSIX, sync the staged entry and its directory's parent before Flair
    // can accept the new public key, including retries after a failed parent sync.
    syncAgentKeysDir(directory);
    if (!WIN32) {
      kind = "parent";
      directory = dirname(directory);
      directory = realpathSync(directory);
      syncAgentKeysDir(directory);
    }
    return tempPath;
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* best effort */ }
    throw new AgentKeyFileRefusal(
      `flair could not sync ${kind} directory ${directory} (${error instanceof Error ? error.message : String(error)}); check the directory and filesystem, then retry rotation`,
    );
  }
}

/**
 * Rename a staged temp file over `privateKeyPath`. A failed rename leaves the
 * staged file in place so the caller can report its path.
 */
export function replaceAgentKeyFile(privateKeyPath: string, stagedPath: string): void {
  testHooks?.beforePublish?.(stagedPath, privateKeyPath);
  renameSync(stagedPath, privateKeyPath);
  try {
    syncAgentKeysDir(dirname(privateKeyPath));
  } catch (error) {
    console.error(`Warning: flair could not sync keys directory ${dirname(privateKeyPath)} (${error instanceof Error ? error.message : String(error)}); the new private key is in place at ${privateKeyPath}.`);
  }
}

/**
 * Reuse the key at `privateKeyPath` when it exists, otherwise write the bytes
 * `create` returns. An occupied path wins over `create` (an export that
 * carries another key does not replace one already on disk). On POSIX a
 * reused key's directory is synced before the key is returned, so a retry
 * after a failed sync confirms the entry durable; a failure refuses and
 * leaves the key in place. Windows cannot sync a directory. On POSIX the
 * ancestor rule runs before an existing key is read.
 */
export function readOrCreateAgentKey(
  privateKeyPath: string,
  create: () => string | Uint8Array,
): AgentKeyFileContents {
  if (!WIN32) assertAgentKeysDirAncestors(dirname(privateKeyPath));
  const existing = readExistingAgentKey(privateKeyPath);
  if (existing) {
    syncReusedAgentKeyDir(privateKeyPath);
    return { bytes: existing, created: false };
  }

  const data = create();
  try {
    createAgentKeyFile(privateKeyPath, data);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      const raced = readExistingAgentKey(privateKeyPath);
      if (raced) {
        syncReusedAgentKeyDir(privateKeyPath);
        return { bytes: raced, created: false };
      }
    }
    throw error;
  }
  return { bytes: new Uint8Array(Buffer.from(data)), created: true };
}

/**
 * On POSIX, sync the directory of a key this call did not write, before it is
 * returned to a caller that registers it; a failure refuses and leaves the key
 * in place. Windows cannot sync a directory.
 */
function syncReusedAgentKeyDir(privateKeyPath: string): void {
  if (WIN32) return;
  const keysDir = dirname(privateKeyPath);
  const handle = openCheckedAgentKeysDir(keysDir);
  try {
    (testHooks?.syncKeysDir ?? fsyncSync)(handle.fd);
  } catch (error) {
    throw new AgentKeyFileRefusal(
      `flair could not sync keys directory ${keysDir} (${error instanceof Error ? error.message : String(error)}); ` +
        `existing key ${privateKeyPath} is not confirmed durable; check the directory and filesystem, then retry`,
    );
  } finally {
    closeSync(handle.fd);
  }
}
