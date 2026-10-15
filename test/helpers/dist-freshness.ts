/**
 * dist-freshness.ts — flair#2583.
 *
 * Real-Harper tests load the COMPILED `dist/resources/*.js` (config.yaml's
 * `jsResource` glob), not the `.ts` sources. Nothing on the test path checked
 * that dist/ matched the sources: only `dist/cli.js` had a freshness check
 * (build-cli-once.ts). After a resource edit without a rebuild a real-Harper
 * run executes the PREVIOUS build, and the new test then fails for a reason
 * its message does not name (measured 2026-10-15: three tests timed out
 * waiting for a code path that existed in the source but not in the build).
 *
 * WHAT THIS DOES. `assertFlairDistFresh(root)` throws a NAMED error when the
 * component root is a Flair source tree (it carries both `resources/` and
 * `tsconfig.json`) and the inputs of a build are newer than its outputs:
 *   - resources/ + the tsconfig.json chain + package.json + bun.lock +
 *     scripts/write-build-info.mjs  →  every file under dist/resources
 *   - src/ + the tsconfig.cli.json chain + package.json + bun.lock +
 *     scripts/write-build-info.mjs  →  dist/cli.js
 * The message names the newer input and the command to run.
 *
 * REFUSE, NOT REBUILD. A rebuild from here would run package.json's `build`,
 * whose `prebuild` deletes dist/ — including dist/cli.js, an artifact other
 * files in the same lane need — so a check that started Harper would mutate
 * unrelated artifacts. Refusing writes nothing and never boots a stale build.
 *
 * `bun run build` builds dist/resources AND wipes dist/ (including
 * dist/cli.js), so a suite that also spawns the CLI needs a following
 * `bun run build:cli`; a missing or stale dist/cli.js is detected too.
 *
 * The check applies when the component root carries both `resources/` and
 * `tsconfig.json` (the Flair source tree). Fixture applications
 * (`resources/*.js`, no tsconfig.json), composed component copies (`dist/`,
 * no `resources/`) and installed tarballs carry a different shape and are
 * skipped.
 *
 * The freshness inputs mirror build-cli-once.ts's approach (output mtimes vs
 * the newest input). This module keeps its own copy of the two primitives
 * because build-cli-once.ts pins them to the repo root, while this one takes
 * the component root as an argument.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

interface FileMtime {
  path: string;
  mtimeMs: number;
}

/**
 * The newest file under `path` (recursively). A directory's OWN mtime is
 * ignored: it changes on add/remove, not on an edit to a file. A missing path
 * is reported as mtime 0.
 */
function newestEntry(path: string): FileMtime {
  let st;
  try {
    st = statSync(path);
  } catch {
    return { path, mtimeMs: 0 };
  }
  if (st.isDirectory()) {
    let newest: FileMtime = { path, mtimeMs: 0 };
    for (const name of readdirSync(path)) {
      const e = newestEntry(join(path, name));
      if (e.mtimeMs > newest.mtimeMs) newest = e;
    }
    return newest;
  }
  return { path, mtimeMs: st.mtimeMs };
}

/** Every file under `path` (recursively), with its mtime. */
function filesUnder(path: string, out: FileMtime[] = []): FileMtime[] {
  let st;
  try {
    st = statSync(path);
  } catch {
    return out;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) filesUnder(join(path, name), out);
  } else {
    out.push({ path, mtimeMs: st.mtimeMs });
  }
  return out;
}

/** A tsconfig and every file it `extends`, transitively. */
function tsconfigInputs(root: string, path: string, seen = new Set<string>()): string[] {
  const out: string[] = [];
  if (seen.has(path) || !existsSync(path)) return out;
  seen.add(path);
  out.push(path);
  try {
    // tsconfig.json is JSONC; `extends` here is a bare string with no comments
    // on its line, so a targeted match is enough and avoids a JSON5 dep.
    const text = readFileSync(path, "utf-8");
    const m = text.match(/"extends"\s*:\s*"([^"]+)"/);
    if (m) {
      const base = m[1].startsWith(".") ? resolve(path, "..", m[1]) : resolve(root, "node_modules", m[1]);
      out.push(...tsconfigInputs(root, base, seen));
    }
  } catch {
    /* unreadable — the file's own mtime still counts via the caller */
  }
  return out;
}

/** Every input whose change must make dist/resources stale. */
export function resourcesInputs(root: string): string[] {
  return [
    join(root, "resources"),
    ...tsconfigInputs(root, join(root, "tsconfig.json")),
    join(root, "package.json"),
    join(root, "bun.lock"),
    join(root, "scripts", "write-build-info.mjs"),
  ];
}

/** Every input whose change must make dist/cli.js stale. */
export function cliInputs(root: string): string[] {
  return [
    join(root, "src"),
    ...tsconfigInputs(root, join(root, "tsconfig.cli.json")),
    join(root, "package.json"),
    join(root, "bun.lock"),
    join(root, "scripts", "write-build-info.mjs"),
  ];
}

/** True when `root` is the Flair source tree the resources build reads. */
export function isFlairSourceRoot(root: string): boolean {
  return existsSync(join(root, "resources")) && existsSync(join(root, "tsconfig.json"));
}

export interface DistIssue {
  /** What is stale or missing, named. */
  message: string;
  /** The exact command that rebuilds it. */
  remedy: string;
}

/**
 * Every reason `root`'s dist/ does not match its sources, each naming the
 * input (or output) and the command that fixes it. Empty means fresh.
 */
export function distFreshnessIssues(root: string): DistIssue[] {
  const issues: DistIssue[] = [];
  try {
    const builtResources = join(root, "dist", "resources");
    const built = filesUnder(builtResources);
    if (built.length === 0) {
      issues.push({ message: `${relative(root, builtResources)} contains no built resources`, remedy: "bun run build" });
    } else {
      let oldest = built[0];
      for (const f of built) if (f.mtimeMs < oldest.mtimeMs) oldest = f;
      for (const input of resourcesInputs(root)) {
        const e = newestEntry(input);
        if (e.mtimeMs > oldest.mtimeMs) {
          issues.push({
            message: `${relative(root, e.path)} (${new Date(e.mtimeMs).toISOString()}) is newer than the oldest built resource ${relative(root, oldest.path)} (${new Date(oldest.mtimeMs).toISOString()})`,
            remedy: "bun run build",
          });
        }
      }
    }
    const stamp = join(root, "dist", "build-info.json");
    if (!existsSync(stamp)) {
      issues.push({ message: `${relative(root, stamp)} is missing`, remedy: "bun run build" });
    }
    const cli = join(root, "dist", "cli.js");
    if (!existsSync(cli)) {
      issues.push({ message: `${relative(root, cli)} is missing`, remedy: "bun run build:cli" });
    } else {
      const cliMtime = statSync(cli).mtimeMs;
      for (const input of cliInputs(root)) {
        const e = newestEntry(input);
        if (e.mtimeMs > cliMtime) {
          issues.push({
            message: `${relative(root, e.path)} (${new Date(e.mtimeMs).toISOString()}) is newer than ${relative(root, cli)} (${new Date(cliMtime).toISOString()})`,
            remedy: "bun run build:cli",
          });
        }
      }
    }
  } catch (err) {
    // A tree that could not be read is NOT a fresh tree: fail closed.
    issues.push({
      message: `the build tree could not be read: ${(err as Error).message}`,
      remedy: "bun run build && bun run build:cli",
    });
  }
  return issues;
}

/**
 * Throw a named error if `root` is the Flair source tree and its dist/ was not
 * built from the current sources. Call before a component is loaded. No-op for
 * any root that is not the Flair source tree.
 */
export function assertFlairDistFresh(root: string): void {
  if (!isFlairSourceRoot(root)) return;
  const issues = distFreshnessIssues(root);
  if (issues.length === 0) return;
  const remedies = [...new Set(issues.map((i) => i.remedy))];
  throw new Error(
    `[harper-lifecycle] refusing to start Harper: ${root} dist/ was not built from the current sources, ` +
      `so the component would run the previous build.\n` +
      issues.map((i) => `  - ${i.message}`).join("\n") +
      `\nRebuild first: ${remedies.map((r) => `\`${r}\``).join(" then ")}. ` +
      "`bun run build` builds dist/resources and wipes dist/ (including dist/cli.js), " +
      "so a suite that also spawns the CLI needs `bun run build:cli` too.",
  );
}
