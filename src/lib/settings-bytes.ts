/**
 * settings-bytes.ts — the shared bytes-level half of the hook-settings
 * writers (flair#1778 slice 2c-i-c).
 *
 * `src/hook-install.ts` and `src/doctor-client.ts` write the SAME two files
 * (`~/.claude/settings.json` and `~/.codex/hooks.json`) with the SAME encode
 * and backup conventions. Before this module each carried its own private
 * copy of the parse / encode / backup helpers. The slice that put BOTH behind
 * `withConfigCriticalSection` (invariant I3b) needs ONE of each so the two
 * modules cannot drift: the lock serializes writers only if every writer
 * parses the IN-LOCK bytes with the same parser, emits the same byte shape,
 * and backs up to the same sibling path.
 *
 * Leaf module: imports only `node:fs` and `node:crypto`. NEVER import
 * `src/cli.ts` here (its `writeFileAtomic` lacks exclusive temp creation,
 * fsync, locking and identity checks — flair#1778 2c-i-b ruling).
 * `parseSettingsBytes` must consume the bytes the primitive hands `decide` —
 * never a pre-lock read.
 */
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";

/** Result of reading/parsing a settings file. `parsed` is null and
 *  `parseError` set on ANY reason we must not proceed: a missing file is NOT
 *  an error (parsed defaults to {}), but an unreadable or unparseable existing
 *  file always is — never silently coerced to "absent". */
export interface ReadSettingsResult {
  exists: boolean;
  parsed: any | null;
  parseError: string | null;
}

/** Backup path convention: a single sibling `<path>.bak`, overwritten on
 *  every mutating run — recovery insurance for the mutation that's about to
 *  happen, not a version history. Exported so tests assert against the same
 *  constant this module uses internally. */
export function hookBackupPath(settingsPath: string): string {
  return `${settingsPath}.bak`;
}

/** Parse settings bytes read INSIDE the critical section (flair#1778
 *  2c-i-b). The primitive hands `decide` the LOCKED snapshot, so parsing must
 *  consume those bytes — never a pre-lock read. */
export function parseSettingsBytes(bytes: Uint8Array | null, path: string): ReadSettingsResult {
  if (bytes === null) return { exists: false, parsed: {}, parseError: null };
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf-8");
  if (!raw.trim()) return { exists: true, parsed: {}, parseError: null };
  try {
    return { exists: true, parsed: JSON.parse(raw), parseError: null };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { exists: true, parsed: null, parseError: `malformed JSON in ${path} (${reason})` };
  }
}

/** The primitive-managed backup: write the IN-LOCK bytes to the sibling
 *  `<path>.bak` (overwritten every mutating run). Throws so the primitive can
 *  short-circuit to a named refusal BEFORE `decide` runs.
 *
 *  The backup may hold SECRET material (a settings file carrying a token), so
 *  it is written 0600 ALWAYS — never the umask default, and never the mode of a
 *  pre-existing `.bak`. Two obvious shapes do NOT get there:
 *    - `writeFileSync(dest, bytes, { mode: 0o600 })` applies the mode only on
 *      CREATE (`O_CREAT`), so an overwrite truncates in place and keeps the old
 *      bits — an existing 0644 `.bak` would stay 0644;
 *    - `openSync(dest, "wx", 0o600)` (exclusive create) FAILS outright when the
 *      file already exists.
 *  Instead follow the primitive's own pattern: write a sibling temp opened `wx`
 *  0600, write, fsync, then rename over `<path>.bak`. A rename REPLACES the
 *  inode, so an existing `.bak` is tightened to 0600, and the token bytes never
 *  sit in a world-readable file, even briefly. */
export function backupBytesTo(path: string, bytes: Uint8Array): string {
  const dest = hookBackupPath(path);
  const tmp = `${dest}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, dest);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort — a leaked temp beats a false success */ }
    throw err;
  }
  return dest;
}

const CONFIG_ENCODER = new TextEncoder();

/** The exact bytes every hook config writer emits: 2-space JSON + newline. */
export function encodeConfig(config: unknown): Uint8Array {
  return CONFIG_ENCODER.encode(JSON.stringify(config, null, 2) + "\n");
}
