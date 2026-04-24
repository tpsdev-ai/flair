/**
 * Trust allow-list for npm code-plugin bridges.
 *
 * A Shape B bridge is arbitrary JavaScript fetched from npm. The spec §7
 * requires explicit operator opt-in on first use: `flair bridge allow <name>`
 * records the approval; subsequent invocations see the bridge on the
 * allow-list and skip the prompt. `flair bridge revoke <name>` removes it.
 *
 * Approvals are pinned to a concrete package location and its package.json
 * content digest. A name-only approval is not enough: a malicious package
 * squatting on an allowed short-name in a different `node_modules` tree
 * (e.g. the user approved `mem0` in ProjectA, then cd'd into ProjectB which
 * ships a planted `node_modules/flair-bridge-mem0`) would otherwise load
 * under the existing trust record. Each entry therefore captures:
 *
 *   - packageDir:        canonical (realpath) directory where the approved
 *                        package lives on disk at allow-time.
 *   - packageJsonSha256: hex sha256 of the package's package.json content.
 *   - version:           the package's self-reported version (display only;
 *                        the sha is what enforces identity).
 *
 * At load-time, `verifyAllow(discovered)` re-checks all three. A change in
 * any triggers a BridgeRuntimeError pointing the operator back at
 * `flair bridge allow` — either the move is intentional (re-approve) or
 * it is a squat (refuse).
 *
 * Design notes:
 *  - YAML (Shape A) + built-in bridges skip this gate entirely. They don't
 *    execute arbitrary JS.
 *  - The store is a simple JSON file at ~/.flair/bridges-allowed.json.
 *    No separate DB, no Harper dependency — the trust decision should
 *    still work when Flair's own service is down.
 *  - Migration: older entries from 0.6.0/0.6.1 carry only {name, allowedAt}.
 *    `verifyAllow` treats those as invalid and forces re-approval on next
 *    load. Acceptable cost — no known external consumers pre-1.0.
 */

import { promises as fsp } from "node:fs";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { DiscoveredBridge } from "../types.js";

export interface AllowEntry {
  name: string;
  allowedAt: string;
  packageDir: string;
  packageJsonSha256: string;
  version?: string;
}

export interface AllowList {
  allowed: AllowEntry[];
}

export interface AllowListOptions {
  /** Override for the allow-list file path. Defaults to ~/.flair/bridges-allowed.json. */
  path?: string;
}

export type VerifyResult =
  | { ok: true; entry: AllowEntry }
  | { ok: false; reason: "not-allowed"; entry?: undefined }
  | { ok: false; reason: "path-mismatch"; entry: AllowEntry; observedPath: string }
  | { ok: false; reason: "digest-mismatch"; entry: AllowEntry; observedDigest: string }
  | { ok: false; reason: "entry-incomplete"; entry: AllowEntry }
  | { ok: false; reason: "package-missing"; entry?: AllowEntry };

function resolvePath(opts: AllowListOptions | undefined): string {
  return opts?.path ?? join(homedir(), ".flair", "bridges-allowed.json");
}

function hasEntryFields(e: any): e is AllowEntry {
  return (
    typeof e?.name === "string" &&
    typeof e?.allowedAt === "string" &&
    typeof e?.packageDir === "string" &&
    typeof e?.packageJsonSha256 === "string"
  );
}

async function read(path: string): Promise<AllowList> {
  if (!existsSync(path)) return { allowed: [] };
  try {
    const raw = await fsp.readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.allowed)) return { allowed: [] };
    // Keep structurally valid entries only. Legacy name-only rows are
    // dropped here so `verifyAllow` reports not-allowed (forcing re-approve).
    return {
      allowed: parsed.allowed.filter(hasEntryFields).map((e: AllowEntry) => ({
        name: e.name,
        allowedAt: e.allowedAt,
        packageDir: e.packageDir,
        packageJsonSha256: e.packageJsonSha256,
        ...(typeof (e as any).version === "string" ? { version: (e as any).version } : {}),
      })),
    };
  } catch {
    return { allowed: [] };
  }
}

async function write(path: string, data: AllowList): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await fsp.rename(tmp, path);
}

/**
 * Canonicalize a filesystem path. Resolves symlinks so node_modules hoisting
 * and pnpm-style content-addressed stores still hash-match reliably.
 */
async function canonical(path: string): Promise<string> {
  try {
    return await fsp.realpath(path);
  } catch {
    return path;
  }
}

/**
 * Hash a package's package.json file. The sha changes whenever the package
 * contents "change enough to matter" — version bumps, name changes, and
 * realistically most substantive updates touch package.json. It is NOT a
 * hash of every file in the package; that would be slower and more fragile
 * without closing the meaningful attack paths (since a squatter needs the
 * right package.json anyway to survive discovery).
 */
export async function digestPackage(
  packageDir: string,
): Promise<{ canonicalDir: string; sha256: string; version?: string }> {
  const canonicalDir = await canonical(packageDir);
  const pkgJsonPath = join(canonicalDir, "package.json");
  const raw = await fsp.readFile(pkgJsonPath, "utf-8");
  const sha = createHash("sha256").update(raw).digest("hex");
  let version: string | undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version === "string") version = parsed.version;
  } catch {
    // A malformed package.json is itself a refusal signal — but leave that
    // to the import path; here we just decline to record a version.
  }
  return { canonicalDir, sha256: sha, version };
}

/**
 * Check if a name appears in the allow-list. Useful for UI listings; NOT a
 * trust decision — use `verifyAllow` for load-time security checks.
 */
export async function isAllowed(name: string, opts?: AllowListOptions): Promise<boolean> {
  const data = await read(resolvePath(opts));
  return data.allowed.some((e) => e.name === name);
}

/**
 * Load-time trust check. Verifies the discovered package still matches the
 * approval record by canonical path AND package.json sha. Anything else is
 * a refusal — the operator must re-run `flair bridge allow <name>`.
 */
export async function verifyAllow(
  discovered: DiscoveredBridge,
  opts?: AllowListOptions,
): Promise<VerifyResult> {
  const data = await read(resolvePath(opts));
  const entry = data.allowed.find((e) => e.name === discovered.name);
  if (!entry) return { ok: false, reason: "not-allowed" };

  // Guard: if we ever loaded a partial record, refuse. Belt-and-braces;
  // read() already filters these, but if someone hand-edits the file we
  // don't want to silently bypass the check.
  if (!entry.packageDir || !entry.packageJsonSha256) {
    return { ok: false, reason: "entry-incomplete", entry };
  }

  let observed: { canonicalDir: string; sha256: string; version?: string };
  try {
    observed = await digestPackage(discovered.path);
  } catch {
    return { ok: false, reason: "package-missing", entry };
  }

  if (observed.canonicalDir !== entry.packageDir) {
    return { ok: false, reason: "path-mismatch", entry, observedPath: observed.canonicalDir };
  }
  if (observed.sha256 !== entry.packageJsonSha256) {
    return { ok: false, reason: "digest-mismatch", entry, observedDigest: observed.sha256 };
  }
  return { ok: true, entry };
}

/**
 * Approve a package for code-plugin execution. `packageDir` must be the
 * directory holding the package.json — typically discovered via
 * `flair bridge list` and passed through by the CLI layer.
 */
export async function allow(
  name: string,
  packageDir: string,
  opts?: AllowListOptions,
): Promise<{ alreadyAllowed: boolean; updated: boolean; entry: AllowEntry }> {
  const listPath = resolvePath(opts);
  const data = await read(listPath);
  const { canonicalDir, sha256, version } = await digestPackage(packageDir);
  const now = new Date().toISOString();

  const existing = data.allowed.find((e) => e.name === name);
  if (existing && existing.packageDir === canonicalDir && existing.packageJsonSha256 === sha256) {
    return { alreadyAllowed: true, updated: false, entry: existing };
  }

  const entry: AllowEntry = {
    name,
    allowedAt: now,
    packageDir: canonicalDir,
    packageJsonSha256: sha256,
    ...(version ? { version } : {}),
  };
  data.allowed = data.allowed.filter((e) => e.name !== name);
  data.allowed.push(entry);
  data.allowed.sort((a, b) => a.name.localeCompare(b.name));
  await write(listPath, data);
  return { alreadyAllowed: false, updated: !!existing, entry };
}

export async function revoke(name: string, opts?: AllowListOptions): Promise<{ wasAllowed: boolean }> {
  const path = resolvePath(opts);
  const data = await read(path);
  const before = data.allowed.length;
  data.allowed = data.allowed.filter((e) => e.name !== name);
  if (data.allowed.length === before) {
    return { wasAllowed: false };
  }
  await write(path, data);
  return { wasAllowed: true };
}

export async function list(opts?: AllowListOptions): Promise<AllowEntry[]> {
  const data = await read(resolvePath(opts));
  return data.allowed;
}
