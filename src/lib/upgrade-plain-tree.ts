/**
 * upgrade-plain-tree.ts — flair#1109 (a)
 *
 * `flair upgrade` has a paved npm-global lane (`npm install -g`) and a Fabric
 * `--target` lane. Production spokes that run a plain extracted package
 * (npm pack + tar, `npm install --omit=dev`, systemd unit — no git checkout,
 * no npm-global install) had neither. The serving tree was invisible; a stale
 * npm-global relic was reported as "the" install.
 *
 * This module is the missing lane: detect that install shape, fetch the
 * published tarball, swap the tree in place, keep operator launchers that
 * are not in the pack, and restart the systemd unit that points at the tree.
 *
 * Detection and planning are pure / dependency-injected. The apply helpers
 * take an `exec` hook so tests never hit the network or mutate a real prefix.
 *
 * (b) — the exec-path mismatch warning — already shipped in #1560
 * (`upgrade-exec-path.ts`). This file does not change that wording.
 */

import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  cpSync,
  readdirSync,
  readFileSync,
  statSync,
  lstatSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { extract as tarExtract } from "tar";
import {
  canonicalPath,
  findFlairPackageDir,
  readFlairPackageAt,
  sameInstallPath,
  type FlairPackageLocation,
} from "./upgrade-exec-path.js";

export const FLAIR_PACKAGE = "@tpsdev-ai/flair";

/** Sibling suffix for the staged new tree (same filesystem as the live tree). */
export const UPGRADE_NEXT_SUFFIX = "upgrade-next";
/** Sibling suffix for the displaced live tree (rollback source). */
export const UPGRADE_PREV_SUFFIX = "upgrade-prev";
/** Sibling suffix for a failed new tree after rollback. */
export const UPGRADE_FAILED_SUFFIX = "upgrade-failed";

/**
 * Root names shipped in the published `@tpsdev-ai/flair` tarball (package.json
 * `files` plus `package.json` itself, plus `node_modules` which we reinstall).
 * Anything else at the tree root is treated as an operator overlay — the
 * launcher the issue asked us to preserve.
 */
export const PACKED_ROOT_NAMES = new Set([
  "package.json",
  "dist",
  "schemas",
  "templates",
  "docs",
  "config.yaml",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "node_modules",
]);

export type TreeKind = "plain-tree" | "git-checkout" | "source-tree" | "not-flair";

export interface TreeInspection {
  kind: TreeKind;
  dir: string;
  version: string | null;
}

export type PlainTreeTarget =
  | { kind: "use"; inspection: TreeInspection }
  | { kind: "refuse"; message: string }
  | { kind: "skip" };

export interface SystemdUnitRef {
  name: string;
  path: string;
  scope: "system" | "user";
}

export interface PlainTreeUpgradePlan {
  treeDir: string;
  fromVersion: string | null;
  toVersion: string;
  stagingDir: string;
  previousDir: string;
  preserve: string[];
  systemdUnits: SystemdUnitRef[];
}

export interface TreeFsHooks {
  exists?: (p: string) => boolean;
  read?: (p: string) => string;
  list?: (p: string) => string[];
  isDir?: (p: string) => boolean;
}

export type ExecFile = (
  file: string,
  args: string[],
  opts?: { encoding?: string; timeout?: number; cwd?: string; stdio?: unknown },
) => string | Buffer;

const DEFAULT_NPM_TIMEOUT_MS = 10 * 60 * 1000;

function hooksWithDefaults(h: TreeFsHooks = {}): Required<TreeFsHooks> {
  return {
    exists: h.exists ?? existsSync,
    read: h.read ?? ((p) => readFileSync(p, "utf-8")),
    list: h.list ?? ((p) => readdirSync(p)),
    isDir: h.isDir ?? ((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    }),
  };
}

/** Sibling of `treeDir` used for staging / previous / failed copies. */
export function treeSibling(treeDir: string, suffix: string): string {
  const canon = canonicalPath(treeDir);
  return `${canon}.${suffix}`;
}

function pathExists(p: string, exists: (p: string) => boolean): boolean {
  try {
    return exists(p);
  } catch {
    return false;
  }
}

/**
 * Classify a directory as a packed install, a git/source checkout, or not
 * our package. Named checks, not hop counts:
 *
 *   - `@tpsdev-ai/flair` package.json — otherwise this is not our tree
 *   - `.git` at the package root — a checkout; tarball-swap would overwrite it
 *   - `src/cli.ts` without `.git` — a copied source tree, same refusal
 *   - `dist/cli.js` and none of the above — the packed shape the issue named
 */
export function inspectFlairTree(dir: string, fs: TreeFsHooks = {}): TreeInspection {
  const h = hooksWithDefaults(fs);
  const loc = readFlairPackageAt(dir);
  const canon = loc?.dir ?? canonicalPath(dir);
  if (!loc) return { kind: "not-flair", dir: canon, version: null };
  const version = loc.version;
  if (pathExists(join(canon, ".git"), h.exists)) {
    return { kind: "git-checkout", dir: canon, version };
  }
  if (pathExists(join(canon, "src", "cli.ts"), h.exists)) {
    return { kind: "source-tree", dir: canon, version };
  }
  if (!pathExists(join(canon, "dist", "cli.js"), h.exists)) {
    return { kind: "not-flair", dir: canon, version };
  }
  return { kind: "plain-tree", dir: canon, version };
}

/**
 * Decide whether `flair upgrade` should take the plain-tree lane.
 *
 * `--tree` is an explicit operator pin and refuses (never silently falls
 * through) when the path is not a packed install. Without the flag, the
 * serving instance's package dir wins, then this CLI's package dir when it
 * is itself a packed tree and is not the npm-global install.
 */
export function resolvePlainTreeTarget(input: {
  treeFlag: string | null;
  serving: FlairPackageLocation | null;
  cli: FlairPackageLocation | null;
  global: FlairPackageLocation | null;
  inspect?: (dir: string) => TreeInspection;
}): PlainTreeTarget {
  const inspect = input.inspect ?? ((d) => inspectFlairTree(d));

  if (input.treeFlag && input.treeFlag.trim() !== "") {
    const inspection = inspect(input.treeFlag.trim());
    if (input.global && sameInstallPath(inspection.dir, input.global.dir)) {
      return {
        kind: "refuse",
        message:
          `--tree ${inspection.dir} is the npm-global install. Omit --tree to use the npm-global lane.`,
      };
    }
    if (inspection.kind === "plain-tree") return { kind: "use", inspection };
    if (inspection.kind === "git-checkout") {
      return {
        kind: "refuse",
        message:
          `--tree ${inspection.dir} is a git checkout. The tarball-swap lane would overwrite it.`,
      };
    }
    if (inspection.kind === "source-tree") {
      return {
        kind: "refuse",
        message:
          `--tree ${inspection.dir} looks like a source tree (src/cli.ts is present). The tarball-swap lane is for npm-pack extracts only.`,
      };
    }
    return {
      kind: "refuse",
      message:
        `--tree ${input.treeFlag} is not a packed @tpsdev-ai/flair install (need package.json + dist/cli.js, no .git).`,
    };
  }

  const candidates: FlairPackageLocation[] = [];
  if (input.serving) candidates.push(input.serving);
  if (input.cli && !candidates.some((c) => sameInstallPath(c.dir, input.cli!.dir))) {
    candidates.push(input.cli);
  }
  for (const loc of candidates) {
    if (input.global && sameInstallPath(loc.dir, input.global.dir)) continue;
    const inspection = inspect(loc.dir);
    if (inspection.kind === "plain-tree") return { kind: "use", inspection };
  }
  return { kind: "skip" };
}

/**
 * Root-level names in the live tree that are not part of the published
 * pack. Those are the operator launcher / overlay the swap must copy onto
 * the new tree.
 */
export function listPreservedLauncherNames(treeDir: string, fs: TreeFsHooks = {}): string[] {
  const h = hooksWithDefaults(fs);
  if (!h.isDir(treeDir)) return [];
  let names: string[];
  try {
    names = h.list(treeDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n !== "." && n !== "..")
    .filter((n) => !PACKED_ROOT_NAMES.has(n))
    .filter((n) => !n.startsWith(".upgrade-"))
    .sort();
}

export function planPlainTreeUpgrade(input: {
  treeDir: string;
  fromVersion: string | null;
  toVersion: string;
  preserve?: string[];
  systemdUnits?: SystemdUnitRef[];
}): PlainTreeUpgradePlan {
  const treeDir = canonicalPath(input.treeDir);
  return {
    treeDir,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    stagingDir: treeSibling(treeDir, UPGRADE_NEXT_SUFFIX),
    previousDir: treeSibling(treeDir, UPGRADE_PREV_SUFFIX),
    preserve: input.preserve ?? listPreservedLauncherNames(treeDir),
    systemdUnits: input.systemdUnits ?? [],
  };
}

export function formatPlainTreeBanner(inspection: TreeInspection): string {
  const ver = inspection.version ? `  (${inspection.version})` : "";
  return [
    `Plain-tree install: ${inspection.dir}${ver}`,
    "   `flair upgrade` will fetch the published tarball, swap this tree in place,",
    "   keep operator launchers that are not in the pack, and restart the unit.",
  ].join("\n");
}

export function formatPlainTreeScopeFooter(inspection: TreeInspection): string {
  return (
    `Scope: plain-tree at ${inspection.dir} (fetch tarball, swap, preserve launcher, restart unit). ` +
    "npm-global packages are not this instance's install."
  );
}

export function formatPlainTreePlan(plan: PlainTreeUpgradePlan): string {
  const from = plan.fromVersion ?? "unknown";
  const lines = [
    `Plain-tree plan: ${plan.treeDir}`,
    `   ${FLAIR_PACKAGE}: ${from} → ${plan.toVersion}  (in-place tarball swap)`,
    `   staging:  ${plan.stagingDir}`,
    `   previous: ${plan.previousDir}  (rollback source until verify succeeds)`,
  ];
  if (plan.preserve.length > 0) {
    lines.push(`   preserve launcher/overlay: ${plan.preserve.join(", ")}`);
  } else {
    lines.push("   preserve launcher/overlay: (none — tree root matches the published pack)");
  }
  if (plan.systemdUnits.length > 0) {
    lines.push(`   restart unit: ${plan.systemdUnits.map(formatUnitRef).join(", ")}`);
  } else {
    lines.push("   restart unit: no systemd unit found for this tree — will use `flair restart`");
  }
  return lines.join("\n");
}

function formatUnitRef(u: SystemdUnitRef): string {
  return `${u.name} (${u.scope}: ${u.path})`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * After a directory path, the next character must not continue the last
 * path segment. `/opt/flair` matches `WorkingDirectory=/opt/flair`,
 * `/opt/flair/`, and `/opt/flair/dist/cli.js` — not `/opt/flair-spoke`.
 */
const AFTER_DIR_PATH = String.raw`(?:/|[\s"'=:]|\\|$)`;

export function unitTextMentionsTree(unitText: string, treeDir: string): boolean {
  const variants = new Set<string>();
  const add = (p: string): void => {
    const trimmed = p.replace(/\/+$/, "");
    if (trimmed.length > 1) variants.add(trimmed);
  };
  add(treeDir);
  try {
    add(canonicalPath(treeDir));
  } catch { /* lexical variants are enough */ }
  return [...variants].some((v) => new RegExp(`${escapeRegExp(v)}${AFTER_DIR_PATH}`).test(unitText));
}

const SYSTEM_UNIT_DIRS = ["/etc/systemd/system"];

export function userSystemdDir(home: string = homedir()): string {
  return join(home, ".config", "systemd", "user");
}

/**
 * Find systemd unit files that name this tree in WorkingDirectory or
 * ExecStart. Looks at `/etc/systemd/system` and the user unit dir — not
 * `/lib/systemd/system` (distro packages).
 *
 * `FLAIR_SYSTEMD_UNIT` (comma-separated `name` or `scope:name`) adds
 * explicit units even when the file does not mention the tree path.
 */
export function findSystemdUnitsForTree(
  treeDir: string,
  opts: {
    home?: string;
    envUnit?: string | null;
    fs?: TreeFsHooks;
    systemDirs?: string[];
    userDir?: string;
  } = {},
): SystemdUnitRef[] {
  const h = hooksWithDefaults(opts.fs);
  const found: SystemdUnitRef[] = [];
  const seen = new Set<string>();
  const add = (u: SystemdUnitRef): void => {
    const key = `${u.scope}:${u.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(u);
  };

  const scan = (dir: string, scope: "system" | "user"): void => {
    if (!h.isDir(dir)) return;
    let names: string[];
    try {
      names = h.list(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".service")) continue;
      const path = join(dir, name);
      let text: string;
      try {
        text = h.read(path);
      } catch {
        continue;
      }
      if (unitTextMentionsTree(text, treeDir)) add({ name, path, scope });
    }
  };

  for (const dir of opts.systemDirs ?? SYSTEM_UNIT_DIRS) scan(dir, "system");
  scan(opts.userDir ?? userSystemdDir(opts.home), "user");

  const envRaw = opts.envUnit ?? process.env.FLAIR_SYSTEMD_UNIT ?? "";
  for (const token of envRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const scoped = token.match(/^(system|user):(.+)$/);
    const scope = (scoped?.[1] ?? null) as "system" | "user" | null;
    const name = (scoped?.[2] ?? token).replace(/\.service$/i, "") + ".service";
    const candidates: Array<{ scope: "system" | "user"; dir: string }> = [];
    if (scope === "system" || scope === null) {
      for (const dir of opts.systemDirs ?? SYSTEM_UNIT_DIRS) candidates.push({ scope: "system", dir });
    }
    if (scope === "user" || scope === null) {
      candidates.push({ scope: "user", dir: opts.userDir ?? userSystemdDir(opts.home) });
    }
    for (const c of candidates) {
      const path = join(c.dir, name);
      if (h.exists(path)) add({ name, path, scope: c.scope });
    }
  }

  return found;
}

export function systemdRestartArgs(unit: SystemdUnitRef): string[] {
  return unit.scope === "user"
    ? ["--user", "restart", unit.name]
    : ["restart", unit.name];
}

export function restartSystemdUnits(
  units: SystemdUnitRef[],
  exec: ExecFile = execFileSync as ExecFile,
): void {
  for (const unit of units) {
    exec("systemctl", systemdRestartArgs(unit), {
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

function copyPreserved(fromTree: string, toTree: string, names: string[]): void {
  for (const name of names) {
    const src = join(fromTree, name);
    const dest = join(toTree, name);
    try {
      if (!existsSync(src)) continue;
      cpSync(src, dest, { recursive: true, dereference: false, force: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to preserve launcher/overlay '${name}': ${msg}`);
    }
  }
}

function npmPackFilename(stdout: string, spec: string): string {
  const lines = stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tgz = [...lines].reverse().find((l) => l.endsWith(".tgz"));
  if (tgz) return basename(tgz);
  throw new Error(`npm pack ${spec} did not print a .tgz filename`);
}

export interface ApplyPlainTreeHooks {
  exec?: ExecFile;
  extract?: (tgz: string, dest: string) => Promise<void>;
  packTimeoutMs?: number;
  installTimeoutMs?: number;
}

async function defaultExtract(tgz: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  await tarExtract({ file: tgz, cwd: dest, strip: 1 });
}

/**
 * Fetch `@tpsdev-ai/flair@toVersion` via `npm pack`, extract it next to the
 * live tree, `npm install --omit=dev`, copy preserved launchers, then
 * rename-swap (`tree → .upgrade-prev`, `staging → tree`).
 *
 * Staging as a sibling keeps the rename on one filesystem (rename fails
 * across devices). Rollback is `restorePlainTreePrevious`.
 */
export async function applyPlainTreeUpgrade(
  plan: PlainTreeUpgradePlan,
  hooks: ApplyPlainTreeHooks = {},
): Promise<void> {
  const exec = hooks.exec ?? (execFileSync as ExecFile);
  const extract = hooks.extract ?? defaultExtract;
  const packTimeout = hooks.packTimeoutMs ?? DEFAULT_NPM_TIMEOUT_MS;
  const installTimeout = hooks.installTimeoutMs ?? DEFAULT_NPM_TIMEOUT_MS;

  const parent = dirname(plan.stagingDir);
  mkdirSync(parent, { recursive: true });

  if (existsSync(plan.stagingDir)) {
    rmSync(plan.stagingDir, { recursive: true, force: true });
  }
  mkdirSync(plan.stagingDir, { recursive: true });

  const spec = `${FLAIR_PACKAGE}@${plan.toVersion}`;
  const packOut = String(exec("npm", ["pack", spec, "--pack-destination", parent], {
    encoding: "utf-8",
    timeout: packTimeout,
    stdio: ["ignore", "pipe", "pipe"],
  }));
  const tgzName = npmPackFilename(packOut, spec);
  const tgzPath = join(parent, tgzName);
  if (!existsSync(tgzPath)) {
    throw new Error(`npm pack ${spec} reported ${tgzName} but ${tgzPath} is missing`);
  }

  try {
    await extract(tgzPath, plan.stagingDir);
    const staged = readFlairPackageAt(plan.stagingDir);
    if (!staged) {
      throw new Error(`extracted tarball at ${plan.stagingDir} is not ${FLAIR_PACKAGE}`);
    }
    if (staged.version && staged.version !== plan.toVersion) {
      throw new Error(
        `extracted tarball at ${plan.stagingDir} is ${staged.version}, expected ${plan.toVersion}`,
      );
    }

    exec("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
      encoding: "utf-8",
      timeout: installTimeout,
      cwd: plan.stagingDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    copyPreserved(plan.treeDir, plan.stagingDir, plan.preserve);

    if (existsSync(plan.previousDir)) {
      rmSync(plan.previousDir, { recursive: true, force: true });
    }

    try {
      renameSync(plan.treeDir, plan.previousDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`could not move live tree aside (${plan.treeDir} → ${plan.previousDir}): ${msg}`);
    }
    try {
      renameSync(plan.stagingDir, plan.treeDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        if (existsSync(plan.previousDir) && !existsSync(plan.treeDir)) {
          renameSync(plan.previousDir, plan.treeDir);
        }
      } catch { /* restore-best-effort; surface the original error */ }
      throw new Error(`could not move staged tree into place (${plan.stagingDir} → ${plan.treeDir}): ${msg}`);
    }
  } finally {
    try {
      if (existsSync(tgzPath)) rmSync(tgzPath, { force: true });
    } catch { /* leftover tgz is harmless */ }
  }
}

/**
 * Put `.upgrade-prev` back at the live tree path. Used by upgrade rollback
 * when restart or verify fails after a swap.
 *
 * Returns whether a previous tree was restored. `false` means there was
 * nothing to restore (swap never completed) — the caller must say so.
 */
export function restorePlainTreePrevious(plan: Pick<PlainTreeUpgradePlan, "treeDir" | "previousDir">): boolean {
  const treeDir = canonicalPath(plan.treeDir);
  const previousDir = plan.previousDir;
  if (!existsSync(previousDir)) return false;

  const failedDir = treeSibling(treeDir, UPGRADE_FAILED_SUFFIX);
  if (existsSync(treeDir)) {
    if (existsSync(failedDir)) rmSync(failedDir, { recursive: true, force: true });
    renameSync(treeDir, failedDir);
  }
  renameSync(previousDir, treeDir);
  return true;
}

/** Drop the displaced previous tree after a successful verify (saves a second copy). */
export function discardPlainTreePrevious(previousDir: string): void {
  if (existsSync(previousDir)) {
    rmSync(previousDir, { recursive: true, force: true });
  }
}

/**
 * Re-export for callers that already have a path and want the package loc
 * without taking a dependency on the (b) module at the call site.
 */
export function locateFlairTree(startPath: string): FlairPackageLocation | null {
  return findFlairPackageDir(startPath);
}

/** True when `dir` is the npm-global package (so the tarball lane must not claim it). */
export function isNpmGlobalTree(
  dir: string,
  global: FlairPackageLocation | null,
): boolean {
  if (!global) return false;
  return sameInstallPath(dir, global.dir);
}

/** lstat helper kept for tests that want to assert a preserve copy kept a symlink. */
export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The "→ version" for `@tpsdev-ai/flair` on the plain-tree lane.
 *
 * Always consulted against registry `/latest` when that fetch succeeded.
 * `--flair-version` is the swap target (an operator pin), and it still
 * applies when `/latest` timed out or was non-OK — otherwise a requested
 * tarball swap is silently skipped. No pin and no latest → cannot list.
 */
export function resolvePlainTreeListingTarget(input: {
  registryLatest: string | null | undefined;
  pin: string | null | undefined;
}): { version: string; pinned: boolean } | null {
  const pin = typeof input.pin === "string" && input.pin.trim() !== "" ? input.pin.trim() : null;
  const latest = typeof input.registryLatest === "string"
    && input.registryLatest.trim() !== ""
    && input.registryLatest !== "unknown"
    ? input.registryLatest.trim()
    : null;
  if (pin) return { version: pin, pinned: true };
  if (latest) return { version: latest, pinned: false };
  return null;
}

export type PlainTreeRollbackDecision =
  | { kind: "restore" }
  | { kind: "skip"; reason: string };

/**
 * Rollback must not assume `.upgrade-prev` exists. A plain-tree run that
 * did not swap @tpsdev-ai/flair (already current; openclaw-only) has no
 * previous tree — skip restore rather than aborting as a hard failure.
 */
export function decidePlainTreeRollback(previousDirExists: boolean): PlainTreeRollbackDecision {
  if (previousDirExists) return { kind: "restore" };
  return {
    kind: "skip",
    reason: "no previous tree to restore (the live tree was not swapped)",
  };
}
