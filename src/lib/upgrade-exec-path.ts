/**
 * upgrade-exec-path.ts — flair#1109 (b)
 *
 * `flair upgrade` reports and upgrades the npm-global `@tpsdev-ai/flair`
 * package. A host can also be serving from a different exec path — a plain
 * extracted tree (npm pack + tar under systemd), a checkout, a second prefix.
 * When those paths differ, the npm-global listing is not "the" install: it
 * may be a stale relic, and upgrading it will not touch the tree serving
 * traffic.
 *
 * This module is detection and wording only. It does not add an in-place
 * tarball-swap upgrade lane (that is #1109 (a), kept elsewhere).
 *
 * Everything that classifies or formats is pure and dependency-injected
 * except the default /proc and lsof readers used when the CLI asks about a
 * live pid.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { npmGlobalFlairPackageDir } from "../install/global-bin-path.js";

/** The CLI / server package whose install path we are comparing. */
export const FLAIR_PACKAGE = "@tpsdev-ai/flair";

export type ExecPathSource = "serving-instance" | "this-cli";

export interface FlairPackageLocation {
  dir: string;
  version: string | null;
}

export interface ProcessPathHooks {
  readCwd?: (pid: number) => string | null;
  readCmdline?: (pid: number) => string | null;
}

export type ExecPathCheck =
  | {
      kind: "match";
      runningPath: string;
      globalPath: string;
      source: ExecPathSource;
    }
  | {
      kind: "mismatch";
      runningPath: string;
      runningVersion: string | null;
      globalPath: string | null;
      globalVersion: string | null;
      source: ExecPathSource;
    }
  | { kind: "unknown" };

const PROCESS_PROBE_TIMEOUT_MS = 2000;

/**
 * Walk up from `startPath` looking for `@tpsdev-ai/flair`'s own package.json.
 *
 * Named search, not a hop count: a harper bin lives several levels under
 * the package root, a CLI script lives at `dist/cli.js`, and a serving
 * cwd may already BE the package root. Checking `name` means an intermediate
 * `package.json` (harper, a workspace) cannot be mistaken for ours.
 */
export function findFlairPackageDir(startPath: string): FlairPackageLocation | null {
  let dir: string;
  try {
    const st = statSync(startPath);
    dir = st.isDirectory() ? startPath : dirname(startPath);
  } catch {
    dir = startPath;
  }
  for (let i = 0; i < 8; i++) {
    const loc = readFlairPackageAt(dir);
    if (loc) return loc;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Read `@tpsdev-ai/flair` at exactly `dir`, or null if it is not that package. */
export function readFlairPackageAt(dir: string): FlairPackageLocation | null {
  try {
    const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (pkg?.name !== FLAIR_PACKAGE) return null;
    return {
      dir: canonicalPath(dir),
      version: typeof pkg.version === "string" && pkg.version ? pkg.version : null,
    };
  } catch {
    return null;
  }
}

/** Canonical path for equality: realpath when it exists, else lexical resolve. */
export function canonicalPath(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function sameInstallPath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

/**
 * Path-shaped tokens from a process command line (null- or space-separated).
 * Flags and bare words (`run`, `.`) are dropped — they are not exec paths.
 */
export function extractPathHints(cmdline: string): string[] {
  return cmdline
    .split(/\0|\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t) => {
      if (t.startsWith("-")) return false;
      if (t.startsWith("/") || t.startsWith("\\")) return true;
      if (/^[A-Za-z]:[\\/]/.test(t)) return true;
      if (t.includes("node_modules") || t.includes("/") || t.includes("\\")) return true;
      return false;
    });
}

export function defaultReadProcessCwd(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return realpathSync(`/proc/${pid}/cwd`);
  } catch {
    try {
      const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
        encoding: "utf-8",
        timeout: PROCESS_PROBE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const m = String(out).match(/^n(.+)$/m);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }
}

export function defaultReadProcessCmdline(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8");
  } catch {
    try {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf-8",
        timeout: PROCESS_PROBE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const trimmed = String(out).trim();
      return trimmed === "" ? null : trimmed;
    } catch {
      return null;
    }
  }
}

/**
 * Locate the `@tpsdev-ai/flair` tree a live pid is executing from.
 *
 * Prefers cwd (Harper is spawned with `cwd: <package dir>`), then path
 * tokens on the command line (the harper bin lives under that tree).
 * Returns null when neither hint resolves to our package — never guesses.
 */
export function resolveServingFlairPackage(
  pid: number,
  hooks: ProcessPathHooks = {},
): FlairPackageLocation | null {
  const readCwd = hooks.readCwd ?? defaultReadProcessCwd;
  const readCmdline = hooks.readCmdline ?? defaultReadProcessCmdline;
  const hints: string[] = [];
  try {
    const cwd = readCwd(pid);
    if (cwd) hints.push(cwd);
  } catch { /* injected readers must not fail the check */ }
  try {
    const cmdline = readCmdline(pid);
    if (cmdline) hints.push(...extractPathHints(cmdline));
  } catch { /* same */ }
  for (const hint of hints) {
    const found = findFlairPackageDir(hint);
    if (found) return found;
  }
  return null;
}

export function resolveNpmGlobalFlairPackage(
  prefix: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): FlairPackageLocation | null {
  if (!prefix || prefix.trim() === "") return null;
  return readFlairPackageAt(npmGlobalFlairPackageDir(prefix, platform));
}

/**
 * `prefixKnown` is true only when `npm prefix -g` actually returned a
 * prefix. A failed/absent probe is not "the global package is missing" —
 * that is `unknown` (no warning). A known prefix with no `@tpsdev-ai/flair`
 * under it is a real mismatch.
 */
export function classifyExecPathVsNpmGlobal(input: {
  serving: FlairPackageLocation | null;
  cli: FlairPackageLocation | null;
  global: FlairPackageLocation | null;
  prefixKnown: boolean;
}): ExecPathCheck {
  const running = input.serving ?? input.cli;
  if (!running) return { kind: "unknown" };
  if (!input.prefixKnown) return { kind: "unknown" };
  const source: ExecPathSource = input.serving ? "serving-instance" : "this-cli";
  if (input.global && sameInstallPath(running.dir, input.global.dir)) {
    return { kind: "match", runningPath: running.dir, globalPath: input.global.dir, source };
  }
  return {
    kind: "mismatch",
    runningPath: running.dir,
    runningVersion: running.version,
    globalPath: input.global?.dir ?? null,
    globalVersion: input.global?.version ?? null,
    source,
  };
}

function versionLabel(version: string | null | undefined): string {
  return version ? `  (${version})` : "";
}

/**
 * Operator-facing warning. Names both paths (and versions when readable)
 * and says what `flair upgrade` will and will not touch. Does not propose
 * an in-place tarball swap — that lane is out of scope for (b).
 */
export function formatExecPathMismatchWarning(check: ExecPathCheck): string | null {
  if (check.kind !== "mismatch") return null;
  const subject = check.source === "serving-instance"
    ? "The running instance's exec path is not the npm-global install."
    : "This CLI's exec path is not the npm-global install.";
  const runningLabel = check.source === "serving-instance" ? "Running" : "This CLI";
  const lines = [
    `⚠️  ${subject}`,
    `   ${runningLabel}:  ${check.runningPath}${versionLabel(check.runningVersion)}`,
  ];
  if (check.globalPath) {
    lines.push(`   npm-global: ${check.globalPath}${versionLabel(check.globalVersion)}`);
  } else {
    lines.push("   npm-global: not installed (no @tpsdev-ai/flair under the npm global prefix)");
  }
  lines.push(
    "   `flair upgrade` only upgrades the npm-global packages. The tree serving traffic is unchanged.",
  );
  return lines.join("\n");
}

/**
 * The one function `flair upgrade` calls. Best-effort: a missing pid, a
 * missing prefix, or an unreadable /proc entry degrades to "unknown"
 * (no warning) rather than failing the command.
 */
export function collectUpgradeExecPathWarning(input: {
  servingPid: number | null;
  cliPackageDir: string;
  npmGlobalPrefix: string | null;
  platform?: NodeJS.Platform;
  hooks?: ProcessPathHooks;
}): string | null {
  try {
    const prefixKnown = typeof input.npmGlobalPrefix === "string" && input.npmGlobalPrefix.trim() !== "";
    const serving = input.servingPid != null
      ? resolveServingFlairPackage(input.servingPid, input.hooks)
      : null;
    const cli = findFlairPackageDir(input.cliPackageDir);
    const global = prefixKnown
      ? resolveNpmGlobalFlairPackage(input.npmGlobalPrefix, input.platform ?? process.platform)
      : null;
    return formatExecPathMismatchWarning(classifyExecPathVsNpmGlobal({
      serving,
      cli,
      global,
      prefixKnown,
    }));
  } catch {
    return null;
  }
}
