/**
 * tree-divergence.ts — "the CLI you ran and the instance you are talking to
 * do not live in the same install tree" (flair#2034 §2).
 *
 * An instance that is served by a unit whose node path was baked at an earlier
 * runtime keeps serving from that tree; the CLI on PATH comes from the tree the
 * current runtime's global prefix owns. `flair status` then prints two
 * contradictory hints (restart vs upgrade) that point at each other, and
 * `flair upgrade` — which targets the RUNNING tree — reports "Everything is up
 * to date" about a tree that is not the one the operator is running. Neither
 * names the real problem.
 *
 * This module is the one shared detector. It compares the CLI's package dir
 * (realpath) with the running instance's install tree, taken from the launchd
 * plist / systemd unit the instance runs from, and renders ONE message that
 * names the actor, the state (both paths and both versions) and the remedy.
 *
 * Pure / dependency-injected so it is unit-testable without a real
 * ~/Library/LaunchAgents, a real systemd, or a running instance.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readPlistProgramRefs } from "./launchd-management.js";
import { resolveHome } from "./home.js";

export interface InstanceRuntimeRefs {
  /** The node binary the unit execs, when the unit names one. */
  nodeBin: string | null;
  /** The install tree (WorkingDirectory) the unit runs the service from. */
  workingDirectory: string | null;
}

export interface RuntimeReadDeps {
  read?: (p: string) => string;
}

/**
 * Read the exec-related runtime refs a launchd plist names. ProgramArguments
 * for a pass-file Flair service are `[launcher, adminPassFile, <node>, <harper
 * entry>]`, so the node binary is index 2; the install tree is
 * WorkingDirectory. Returns all-null when the plist cannot be read.
 */
export function readPlistInstanceRuntime(plistPath: string, deps: RuntimeReadDeps = {}): InstanceRuntimeRefs {
  const refs = readPlistProgramRefs(plistPath, deps.read);
  if (!refs) return { nodeBin: null, workingDirectory: null };
  const nodeBin = refs.programArguments.find((a) => /(^|[/\\])node$/.test(a)) ?? null;
  return { nodeBin, workingDirectory: refs.workingDirectory };
}

/**
 * Read the exec-related runtime refs from a systemd user unit. `ExecStart=` is
 * a single command line; the node binary is the first token that looks like a
 * node binary, and `WorkingDirectory=` is the tree.
 */
export function readSystemdInstanceRuntime(unitPath: string, deps: RuntimeReadDeps = {}): InstanceRuntimeRefs {
  let raw: string;
  try {
    raw = (deps.read ?? ((p: string) => readFileSync(p, "utf-8")))(unitPath);
  } catch {
    return { nodeBin: null, workingDirectory: null };
  }
  const exec = /^ExecStart=(.*)$/m.exec(raw);
  let nodeBin: string | null = null;
  if (exec) {
    for (const token of exec[1].split(/\s+/)) {
      const unquoted = token.replace(/^["']|["']$/g, "");
      if (unquoted.startsWith("/") && /(^|[/\\])node$/.test(unquoted)) {
        nodeBin = unquoted;
        break;
      }
    }
  }
  const wd = /^WorkingDirectory=(.*)$/m.exec(raw);
  return { nodeBin, workingDirectory: wd ? wd[1].trim() : null };
}

export interface InstanceRuntimeQuery {
  platform?: NodeJS.Platform;
  plistPath?: string | null;
  systemdUnitPath?: string | null;
  deps?: RuntimeReadDeps;
}

/** Read the running instance's runtime refs from whichever unit applies. */
export function readInstanceRuntime(q: InstanceRuntimeQuery): InstanceRuntimeRefs {
  const platform = q.platform ?? process.platform;
  if (platform === "darwin") {
    return q.plistPath ? readPlistInstanceRuntime(q.plistPath, q.deps) : { nodeBin: null, workingDirectory: null };
  }
  return q.systemdUnitPath
    ? readSystemdInstanceRuntime(q.systemdUnitPath, q.deps)
    : { nodeBin: null, workingDirectory: null };
}

export interface TreeDivergenceInput {
  /** The CLI's own package dir (as resolved by the running CLI). */
  cliDir: string;
  cliVersion: string;
  /** The running instance's install tree, or null when it cannot be resolved. */
  runningDir: string | null;
  /** The running server's reported version, when known. */
  runningVersion?: string | null;
  /** Path-equality hook (defaults to realpath comparison). */
  samePath?: (a: string, b: string) => boolean;
}

export interface TreeDivergence {
  diverged: boolean;
  cliDir: string;
  cliVersion: string;
  runningDir: string | null;
  runningVersion: string | null;
  /** True when the CLI's tree carries an OLDER flair than the running tree. */
  cliTreeOlder: boolean;
}

function defaultSamePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return norm(a) === norm(b);
}

/** Compare a parsed version; returns <0, 0, >0 (missing parts treated as 0). */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function computeTreeDivergence(input: TreeDivergenceInput): TreeDivergence {
  const samePath = input.samePath ?? defaultSamePath;
  const runningDir = input.runningDir;
  const diverged = runningDir !== null && !samePath(input.cliDir, runningDir);
  const cliTreeOlder =
    diverged &&
    typeof input.runningVersion === "string" &&
    compareVersions(input.cliVersion, input.runningVersion) < 0;
  return {
    diverged,
    cliDir: input.cliDir,
    cliVersion: input.cliVersion,
    runningDir,
    runningVersion: input.runningVersion ?? null,
    cliTreeOlder,
  };
}

/**
 * The operator-facing lines for a diverged tree. Names the ACTOR (the CLI vs
 * the running instance), the STATE (both paths, both versions) and the REMEDY
 * (`flair init && flair restart`, plus `npm i -g @tpsdev-ai/flair` when the
 * CLI's own tree is the stale one). Returns [] when the trees agree.
 */
export function formatTreeDivergenceLines(d: TreeDivergence): string[] {
  if (!d.diverged || d.runningDir === null) return [];
  const runningVersion = d.runningVersion ? `  (v${d.runningVersion})` : "";
  const lines = [
    "⚠️  The CLI and the running instance are in DIFFERENT install trees.",
    `   CLI:      ${d.cliDir}  (v${d.cliVersion})`,
    `   instance: ${d.runningDir}${runningVersion}`,
    "   The instance was started by a unit whose node path was baked at an earlier runtime, so it keeps serving from the old tree while this CLI runs from the current one.",
  ];
  if (d.cliTreeOlder) {
    lines.push(
      `   The CLI's tree is the stale one: run \`npm i -g ${"@tpsdev-ai/flair"}\` to make it current, then:`,
    );
  }
  lines.push("   Remedy: flair init && flair restart");
  lines.push(
    "   `flair init` rewrites the unit against the runtime in use now; `flair restart` brings the instance up under it. Your data is not touched.",
  );
  return lines;
}

/** The one-line form for compact output. */
export function formatTreeDivergenceOneLine(d: TreeDivergence): string | null {
  if (!d.diverged || d.runningDir === null) return null;
  const rv = d.runningVersion ? ` v${d.runningVersion}` : "";
  return `CLI tree ${d.cliDir} (v${d.cliVersion}) ≠ instance tree ${d.runningDir}${rv} — run: flair init && flair restart`;
}

/** The instance-scoped launchd label for a data dir (mirrors cli.ts's
 *  launchdLabel: `ai.tpsdev.flair.<8 hex of sha256 of the realpath>`). */
export function instanceLaunchdLabel(dataDir: string): string {
  const hash = createHash("sha256").update(resolve(dataDir), "utf8").digest("hex").slice(0, 8);
  return `ai.tpsdev.flair.${hash}`;
}

/**
 * Read the running instance's runtime refs for a data dir, from the launchd
 * plist (macOS) or the systemd user unit (Linux) that instance runs from. The
 * instance-scoped label is tried first; the pre-#693 bare label is a fallback so
 * an un-migrated install is still read.
 */
export function resolveInstanceRuntimeForDataDir(
  dataDir: string,
  opts: {
    platform?: NodeJS.Platform;
    homeDir?: string;
    read?: (p: string) => string;
    exists?: (p: string) => boolean;
    launchAgentsDir?: string;
    systemdUserDir?: string;
  } = {},
): InstanceRuntimeRefs {
  const platform = opts.platform ?? process.platform;
  const home = opts.homeDir ?? resolveHome();
  const exists = opts.exists ?? existsSync;
  if (platform === "darwin") {
    const dir = opts.launchAgentsDir ?? join(home, "Library", "LaunchAgents");
    const candidates = [join(dir, `${instanceLaunchdLabel(dataDir)}.plist`), join(dir, "ai.tpsdev.flair.plist")];
    for (const p of candidates) {
      if (exists(p)) return readPlistInstanceRuntime(p, { read: opts.read });
    }
    return { nodeBin: null, workingDirectory: null };
  }
  const dir = opts.systemdUserDir ?? join(home, ".config", "systemd", "user");
  const candidates = [join(dir, "flair.service"), join(dir, "dev.flair.service")];
  for (const p of candidates) {
    if (exists(p)) return readSystemdInstanceRuntime(p, { read: opts.read });
  }
  return { nodeBin: null, workingDirectory: null };
}
