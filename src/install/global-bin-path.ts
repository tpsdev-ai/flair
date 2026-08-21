// ─── npm global bin dir vs PATH (flair#1134) ────────────────────────────────
//
// `npm install -g @tpsdev-ai/flair` on a user-prefix setup (prefix =
// ~/.npm-global or similar) succeeds, puts the `flair` bin in
// `<prefix>/bin`, and then `flair` is "command not found" because that
// directory was never added to PATH. The install instructions claim
// one-command readiness, so the failure reads as a broken package, not a
// broken PATH.
//
// This module is the single source of truth for detecting that state and
// for the message that fixes it. Two consumers:
//   - dist/postinstall.cjs (src/postinstall.cts) — runs at `npm i -g` time,
//     the moment the user hits the lie.
//   - `flair doctor` — cheap, always runs, and covers every path where
//     lifecycle scripts are suppressed (--ignore-scripts, bun without
//     trustedDependencies, the fleet's tar-swap deploys).
//
// Contract (errors must enable a response): every warning names the ACTUAL
// bin directory and prints the exact line to add for the user's shell —
// never "check your PATH". If we cannot VALIDATE the directory (the flair
// bin is really there), we say nothing rather than print a wrong fix.
//
// Everything here is pure and dependency-injected except
// resolveNpmGlobalPrefix (spawns `npm prefix -g` for doctor).

import { join } from "node:path";
import { existsSync } from "node:fs";

// ─── path membership ────────────────────────────────────────────────────────

/** Strip trailing separators ("/", and "\" on win32) without eating a bare root. */
function stripTrailingSeps(p: string, win32: boolean): string {
  const stripped = p.replace(win32 ? /[\\/]+$/ : /\/+$/, "");
  return stripped === "" ? p.slice(0, 1) : stripped;
}

function normalizeEntry(entry: string, win32: boolean): string {
  let e = stripTrailingSeps(entry.trim(), win32);
  if (win32) e = e.replace(/\//g, "\\").toLowerCase();
  return e;
}

/**
 * The directory npm links global bins into for a given prefix:
 * `<prefix>/bin` everywhere except win32, where shims land in the prefix
 * itself (npm's own layout, not ours).
 */
export function npmGlobalBinDir(prefix: string, platform: NodeJS.Platform = process.platform): string {
  const win32 = platform === "win32";
  const clean = stripTrailingSeps(prefix.trim(), win32);
  return win32 ? clean : join(clean, "bin");
}

/**
 * Is `dir` one of the entries of `pathEnv`? Trailing slashes are ignored on
 * both sides; win32 compares case-insensitively with either separator and
 * splits on ";". Empty entries (historical "cwd" semantics) never match.
 */
export function isDirOnPath(
  dir: string,
  pathEnv: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!pathEnv) return false;
  const win32 = platform === "win32";
  const delim = win32 ? ";" : ":";
  const want = normalizeEntry(dir, win32);
  return pathEnv
    .split(delim)
    .filter((e) => e.trim() !== "")
    .some((e) => normalizeEntry(e, win32) === want);
}

// ─── the fix, per shell ─────────────────────────────────────────────────────

export interface ShellPathFix {
  /** The line that fixes the CURRENT shell (or persists, for fish). */
  exportLine: string;
  /** One command that persists the fix, or null when we can't name the rc file. */
  persistCommand: string | null;
  /** The rc file the persist command appends to, for the message text. */
  rcFile: string | null;
}

/** basename of $SHELL, lowercased — "/usr/local/bin/zsh" → "zsh". */
function shellFlavor(shell: string | undefined): string {
  if (!shell) return "";
  return shell.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
}

export function shellPathFix(binDir: string, shell: string | undefined): ShellPathFix {
  const flavor = shellFlavor(shell);
  if (flavor === "fish") {
    // fish_add_path persists via a universal variable — one command does both.
    const line = `fish_add_path ${binDir}`;
    return { exportLine: line, persistCommand: line, rcFile: null };
  }
  const exportLine = `export PATH="${binDir}:$PATH"`;
  const rcFile = flavor === "zsh" ? "~/.zshrc" : flavor === "bash" ? "~/.bashrc" : null;
  return {
    exportLine,
    persistCommand: rcFile === null ? null : `echo '${exportLine}' >> ${rcFile}`,
    rcFile,
  };
}

// ─── the message ────────────────────────────────────────────────────────────

/**
 * The full actionable warning. Names the actual bin dir, gives the exact
 * line for the user's shell, says how to persist it, and how to verify.
 */
export function formatOffPathMessage(
  binDir: string,
  shell: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return [
      `flair is installed in ${binDir}, but that directory is not on your PATH,`,
      `so the "flair" command will not be found.`,
      ``,
      `Fix — add it to your user PATH (new terminals pick it up):`,
      ``,
      `  powershell -Command "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';${binDir}', 'User')"`,
      ``,
      `Then open a new terminal and verify:  flair --version`,
    ].join("\n");
  }
  const fix = shellPathFix(binDir, shell);
  const lines = [
    `flair is installed at ${binDir}/flair, but ${binDir} is not on your PATH,`,
    `so the "flair" command will not be found.`,
    ``,
    `Fix — run this in your shell now:`,
    ``,
    `  ${fix.exportLine}`,
  ];
  if (fix.persistCommand) {
    lines.push(``, `and persist it for new shells:`, ``, `  ${fix.persistCommand}`);
  } else if (shellFlavor(shell) !== "fish") {
    lines.push(``, `and add that same line to your shell's startup file to persist it.`);
  }
  lines.push(``, `Then verify:  flair --version`);
  return lines.join("\n");
}

// ─── composed check (doctor + postinstall share this) ───────────────────────

export interface GlobalBinCheckInput {
  /** npm's global prefix (`npm prefix -g` / npm_config_prefix). */
  prefix: string;
  /** The PATH value to check against (process.env.PATH). */
  pathEnv: string | undefined;
  /** For the fix wording ($SHELL). */
  shell?: string;
  platform?: NodeJS.Platform;
}

export type GlobalBinCheck =
  | { onPath: true; binDir: string }
  | { onPath: false; binDir: string; exportLine: string; message: string };

export function checkGlobalBinOnPath(input: GlobalBinCheckInput): GlobalBinCheck {
  const platform = input.platform ?? process.platform;
  const binDir = npmGlobalBinDir(input.prefix, platform);
  if (isDirOnPath(binDir, input.pathEnv, platform)) return { onPath: true, binDir };
  return {
    onPath: false,
    binDir,
    exportLine: shellPathFix(binDir, input.shell).exportLine,
    message: formatOffPathMessage(binDir, input.shell, platform),
  };
}

// ─── postinstall decision (thin entry in src/postinstall.cts calls this) ────

export interface PostinstallEnv {
  /** process.env.npm_config_global — "true" on `npm i -g`. */
  npmConfigGlobal?: string;
  /** process.env.npm_config_prefix — set whenever the user configured a prefix. */
  npmConfigPrefix?: string;
  pathEnv?: string;
  shell?: string;
  platform?: NodeJS.Platform;
  /** Root directory of the installed package (…/lib/node_modules/@tpsdev-ai/flair). */
  packageDir?: string;
  /** Injectable for tests: does `binDir` really contain the flair bin? */
  binDirHasFlair?: (binDir: string) => boolean;
}

/**
 * Fallback when npm_config_prefix is absent: derive prefix from where npm put
 * us. String-based (not path.join) so the win32 shape stays faithful even in
 * tests running on posix hosts.
 */
export function prefixFromPackageDir(packageDir: string, platform: NodeJS.Platform = process.platform): string {
  // posix:  <prefix>/lib/node_modules/@tpsdev-ai/flair  → 4 segments up
  // win32:  <prefix>\node_modules\@tpsdev-ai\flair      → 3 segments up
  const win32 = platform === "win32";
  const segments = stripTrailingSeps(packageDir, win32).split(win32 ? /[\\/]/ : "/");
  const ups = win32 ? 3 : 4;
  const kept = segments.slice(0, Math.max(1, segments.length - ups));
  return kept.join(win32 ? "\\" : "/") || (win32 ? packageDir : "/");
}

function defaultBinDirHasFlair(binDir: string, platform: NodeJS.Platform): boolean {
  const names = platform === "win32" ? ["flair.cmd", "flair"] : ["flair"];
  return names.some((n) => existsSync(join(binDir, n)));
}

/**
 * Decide what (if anything) the postinstall hook should print.
 *
 * Returns the warning message, or null when there is nothing to say:
 *   - not a global install (npm_config_global !== "true" — local installs and
 *     non-npm runners stay silent),
 *   - no candidate prefix VALIDATES (the flair bin is not actually in the
 *     candidate's bin dir — we never print a fix naming a wrong directory),
 *   - or the bin dir is already on PATH.
 */
export function postinstallWarning(env: PostinstallEnv): string | null {
  if (env.npmConfigGlobal !== "true") return null;
  const platform = env.platform ?? process.platform;
  const hasFlair = env.binDirHasFlair ?? ((d: string) => defaultBinDirHasFlair(d, platform));

  const candidates: string[] = [];
  if (env.npmConfigPrefix) candidates.push(env.npmConfigPrefix);
  if (env.packageDir) candidates.push(prefixFromPackageDir(env.packageDir, platform));

  for (const prefix of candidates) {
    const binDir = npmGlobalBinDir(prefix, platform);
    if (!hasFlair(binDir)) continue; // unvalidated — never name a wrong dir
    if (isDirOnPath(binDir, env.pathEnv, platform)) return null;
    return formatOffPathMessage(binDir, env.shell, platform);
  }
  return null;
}

// ─── CLI boot banner (the surface that runs when lifecycle scripts can't) ───
//
// npm ≥12 BLOCKS install scripts by default (allowScripts policy — measured
// 2026-08-21 on npm 12.0.1: a user-prefix `npm i -g <tarball>` prints
// "install scripts blocked" and the postinstall never runs). `--ignore-scripts`
// and bun-without-trust do the same on older toolchains. On those paths the
// FIRST thing of ours that executes is the CLI itself — reached via npx, an
// absolute path, or a PATH the user fixed for one shell but never persisted.
// So the CLI warns at boot, under tight gates:
//   - spawn-free: the prefix is derived from the CLI's own on-disk location
//     (no `npm prefix -g` on every command),
//   - validated: the derived bin dir must really hold the flair bin,
//   - TTY-gated: automation invoking flair by absolute path with a slim PATH
//     must not get per-run noise; humans at terminals do.

export interface BootPathWarningEnv {
  /** Root directory of the installed package (dirname(dist)/..). */
  packageDir: string;
  pathEnv?: string;
  shell?: string;
  platform?: NodeJS.Platform;
  /** process.stderr.isTTY — the noise gate. */
  stderrIsTTY: boolean;
  /** Injectable for tests: does `binDir` really contain the flair bin? */
  binDirHasFlair?: (binDir: string) => boolean;
}

/** Compact per-boot variant of the message — this one repeats until fixed. */
export function formatCompactOffPathBanner(binDir: string, shell: string | undefined): string {
  const fix = shellPathFix(binDir, shell);
  const lines = [
    `flair: ${binDir} (where npm installed flair) is not on your PATH.`,
    `  fix now:  ${fix.exportLine}`,
  ];
  if (fix.persistCommand && fix.persistCommand !== fix.exportLine) {
    lines.push(`  persist:  ${fix.persistCommand}`);
  } else if (!fix.persistCommand) {
    lines.push(`  persist:  add that line to your shell's startup file`);
  }
  return lines.join("\n");
}

/**
 * Decide what (if anything) the CLI should print to stderr at boot.
 * Null when: not a TTY, the layout does not validate (dev checkouts, npx
 * cache copies, tar-swap deploys — their derived dir has no flair bin), or
 * the bin dir is on PATH.
 */
export function cliBootPathWarning(env: BootPathWarningEnv): string | null {
  if (!env.stderrIsTTY) return null;
  const platform = env.platform ?? process.platform;
  const hasFlair = env.binDirHasFlair ?? ((d: string) => defaultBinDirHasFlair(d, platform));
  const binDir = npmGlobalBinDir(prefixFromPackageDir(env.packageDir, platform), platform);
  if (!hasFlair(binDir)) return null; // unvalidated — never name a wrong dir
  if (isDirOnPath(binDir, env.pathEnv, platform)) return null;
  return formatCompactOffPathBanner(binDir, env.shell);
}

// ─── doctor plumbing ────────────────────────────────────────────────────────

/**
 * `npm prefix -g`, best-effort. Returns the trimmed prefix or null when npm
 * is absent / slow / errors — doctor SKIPS the check then (flair may have
 * been installed by other means; a missing npm is not something this check
 * can turn into an actionable finding).
 */
export async function resolveNpmGlobalPrefix(): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process");
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["prefix", "-g"],
        { timeout: 5000, encoding: "utf-8", shell: process.platform === "win32" },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
      );
    });
    const prefix = out.trim();
    return prefix === "" ? null : prefix;
  } catch {
    return null;
  }
}
