/**
 * service-repoint.ts — re-point the instance's own service unit at this CLI's
 * install tree, changing ONLY the runtime paths (flair#2034 §2).
 *
 * `flair init` used to leave an already-adopted launchd plist byte-for-byte
 * unchanged (flair#1693: an adopted plist must never be downgraded), so after a
 * Node bump the advised `flair init && flair restart` restarted the instance
 * from the OLD tree. The fix is not to regenerate the unit — that would drop
 * whatever the operator changed in it — but to replace the few values that name
 * a runtime or an install tree and leave every other byte where it was:
 *
 *   - launchd (the plist `flair init` / `doctor --fix` writes):
 *       ProgramArguments[0] (the launcher), [2] (node), [3] (Harper entry),
 *       and WorkingDirectory. [1] (the admin-pass FILE path) and every other
 *       key — EnvironmentVariables, KeepAlive, Umask, log paths — are untouched.
 *   - systemd user unit (Linux): WorkingDirectory, the node binary in
 *       ExecStart, and every ExecStart path inside the old tree (mapped to the
 *       same relative path in the new tree). Nothing else.
 *
 * WHEN a unit is re-pointed, and when it is not (the same rule for both):
 *
 *   - it serves an npm-global install tree (`…/lib/node_modules/@tpsdev-ai/flair`)
 *     that is NOT this CLI's tree → re-point node + tree together;
 *   - it serves THIS CLI's tree with an existing, different node → a deliberate
 *     runtime pin: left as it is (`pinned-node`);
 *   - it serves this CLI's tree and one of its paths no longer exists → only
 *     the missing path is replaced;
 *   - it serves a plain tree or a checkout → never re-pointed (`refuse`): that
 *     is a separately managed deployment;
 *   - the old tree carries a NEWER flair than this CLI's → refused: re-pointing
 *     would downgrade the instance;
 *   - anything not in the shape flair writes (a missing key, an extra argument,
 *     quoting, systemd specifiers or continuations) → refused, never guessed.
 *
 * Pure: text in, text out. The callers (src/cli.ts) own the reads, the atomic
 * write and the service-manager reload.
 */
import { basename, isAbsolute, relative } from "node:path";
import { escapeXml, unescapeXml } from "./xml-escape.js";
import { compareVersions, isNpmGlobalFlairTree } from "./tree-divergence.js";

export const LAUNCHER_BASENAME = "start-flair-with-admin-pass.sh";

export interface RepointTargets {
  /** The launcher in this CLI's tree (launchd only). */
  launcher?: string;
  /** The node binary to write (already alias-preferred by the caller). */
  nodeBin: string;
  /** Harper's entry in this CLI's tree. */
  harperBin: string;
  /** This CLI's install tree. */
  workingDirectory: string;
  /** This CLI's flair version, for the no-downgrade rule. */
  cliVersion: string | null;
}

export interface RepointDeps {
  exists: (p: string) => boolean;
  /** Path equality — callers pass a realpath-based comparison. */
  samePath: (a: string, b: string) => boolean;
  /** realpath, falling back to the input when it cannot be resolved. */
  canonical: (p: string) => string;
  /** The flair version declared by the package at `dir`, or null. */
  treeVersion: (dir: string) => string | null;
}

export interface RepointChange {
  field: string;
  from: string;
  to: string;
}

export type RepointPlan =
  | { kind: "current"; detail: string }
  | { kind: "pinned-node"; detail: string; unitNodeBin: string }
  | { kind: "repoint"; text: string; changes: RepointChange[]; detail: string }
  | { kind: "refuse"; detail: string };

function describeChanges(changes: RepointChange[]): string {
  return changes.map((c) => `${c.field}: ${c.from} → ${c.to}`).join("; ");
}

/** Shared decision: may a unit serving `oldTree` be moved to `t.workingDirectory`? */
function treeGate(oldTree: string, t: RepointTargets, deps: RepointDeps, unit: string): string | null {
  if (!isNpmGlobalFlairTree(oldTree)) {
    return (
      `${unit} serves ${oldTree}, which is not an npm-global install (a plain tree or a checkout), so flair treats it ` +
      "as a separately managed deployment and does not re-point it."
    );
  }
  const oldVersion = deps.treeVersion(oldTree);
  if (oldVersion && t.cliVersion && compareVersions(t.cliVersion, oldVersion) < 0) {
    return (
      `${unit} serves flair ${oldVersion} from ${oldTree}; this CLI's tree has the older ${t.cliVersion}, so re-pointing ` +
      "would downgrade the instance. Update this CLI's tree first (npm i -g @tpsdev-ai/flair), then re-run flair init."
    );
  }
  for (const p of [t.workingDirectory, t.harperBin, ...(t.launcher ? [t.launcher] : []), t.nodeBin]) {
    if (!deps.exists(p)) return `this CLI's tree is missing ${p}, so ${unit} cannot be re-pointed at it.`;
  }
  return null;
}

// ─── launchd ──────────────────────────────────────────────────────────────

/**
 * Plan the re-point of an adopted pass-file plist. `raw` must be the plist
 * `buildLaunchdPlist` shape: one ProgramArguments array of exactly four
 * strings (launcher, admin-pass file, node, Harper entry) and one
 * WorkingDirectory.
 */
export function planPlistRuntimeRepoint(raw: string, t: RepointTargets, deps: RepointDeps, plistPath: string): RepointPlan {
  const unit = `the launchd plist ${plistPath}`;
  if (!t.launcher) return { kind: "refuse", detail: "internal: no launcher path to write" };
  const argsKeys = raw.match(/<key>ProgramArguments<\/key>/g) ?? [];
  const wdKeys = raw.match(/<key>WorkingDirectory<\/key>/g) ?? [];
  const argsBlock = /(<key>ProgramArguments<\/key>\s*<array>)([\s\S]*?)(<\/array>)/.exec(raw);
  const wd = /(<key>WorkingDirectory<\/key>\s*<string>)([^<]*)(<\/string>)/.exec(raw);
  if (argsKeys.length !== 1 || wdKeys.length !== 1 || !argsBlock || !wd) {
    return { kind: "refuse", detail: `${unit} does not have exactly one ProgramArguments array and one WorkingDirectory, so it is not re-pointed.` };
  }
  const inner = argsBlock[2]!;
  const strings = [...inner.matchAll(/<string>([^<]*)<\/string>/g)];
  if (strings.length !== 4 || inner.replace(/<string>[^<]*<\/string>/g, "").trim() !== "") {
    return { kind: "refuse", detail: `${unit}'s ProgramArguments is not the four-argument pass-file launcher shape flair writes, so it is not re-pointed.` };
  }
  const args = strings.map((m) => unescapeXml(m[1]!));
  if (basename(args[0]!) !== LAUNCHER_BASENAME) {
    return { kind: "refuse", detail: `${unit} does not exec the pass-file launcher, so it is not re-pointed.` };
  }
  const oldTree = unescapeXml(wd[2]!);
  const current = { launcher: args[0]!, nodeBin: args[2]!, harperBin: args[3]!, workingDirectory: oldTree };

  const next = { ...current };
  const sameTree = deps.samePath(oldTree, t.workingDirectory);
  if (sameTree) {
    // Same tree: replace only what no longer exists; an existing different node is a deliberate pin.
    if (!deps.exists(current.launcher)) next.launcher = t.launcher;
    if (!deps.exists(current.harperBin)) next.harperBin = t.harperBin;
    if (!deps.exists(current.nodeBin)) next.nodeBin = t.nodeBin;
  } else {
    const refusal = treeGate(oldTree, t, deps, unit);
    if (refusal) return { kind: "refuse", detail: refusal };
    next.launcher = t.launcher;
    next.nodeBin = t.nodeBin;
    next.harperBin = t.harperBin;
    next.workingDirectory = t.workingDirectory;
  }

  const changes: RepointChange[] = [];
  if (next.launcher !== current.launcher) changes.push({ field: "launcher", from: current.launcher, to: next.launcher });
  if (next.nodeBin !== current.nodeBin) changes.push({ field: "node", from: current.nodeBin, to: next.nodeBin });
  if (next.harperBin !== current.harperBin) changes.push({ field: "Harper entry", from: current.harperBin, to: next.harperBin });
  if (next.workingDirectory !== current.workingDirectory) {
    changes.push({ field: "WorkingDirectory", from: current.workingDirectory, to: next.workingDirectory });
  }

  if (changes.length === 0) {
    if (sameTree && deps.canonical(current.nodeBin) !== deps.canonical(t.nodeBin)) {
      return {
        kind: "pinned-node",
        unitNodeBin: current.nodeBin,
        detail:
          `${unit} serves this CLI's tree with node ${current.nodeBin} (this CLI runs ${t.nodeBin}); a deliberate ` +
          "runtime pin is left as it is.",
      };
    }
    return { kind: "current", detail: `${unit} already serves this CLI's tree.` };
  }

  // Rebuild the array by index, keeping every byte between the strings.
  const nextArgs = [next.launcher, args[1]!, next.nodeBin, next.harperBin];
  let i = 0;
  const nextInner = inner.replace(/<string>[^<]*<\/string>/g, (m) => {
    const idx = i++;
    return nextArgs[idx] === args[idx] ? m : `<string>${escapeXml(nextArgs[idx]!)}</string>`;
  });
  let text =
    raw.slice(0, argsBlock.index) + argsBlock[1] + nextInner + argsBlock[3] + raw.slice(argsBlock.index + argsBlock[0].length);
  if (next.workingDirectory !== current.workingDirectory) {
    const wd2 = /(<key>WorkingDirectory<\/key>\s*<string>)([^<]*)(<\/string>)/.exec(text)!;
    text =
      text.slice(0, wd2.index) + wd2[1] + escapeXml(next.workingDirectory) + wd2[3] + text.slice(wd2.index + wd2[0].length);
  }
  return { kind: "repoint", text, changes, detail: `re-pointed ${unit} (${describeChanges(changes)})` };
}

// ─── systemd (Linux user unit) ────────────────────────────────────────────

const UNSAFE_WORD = /["'\\%$`]/;

/**
 * Plan the re-point of the systemd USER unit proven to own the serving process.
 * `oldTree` is the tree the unit serves now. Only a single-line, unquoted,
 * specifier-free `WorkingDirectory=` and `ExecStart=` are rewritten; anything
 * else is refused rather than guessed.
 */
export function planSystemdUnitRuntimeRepoint(
  text: string,
  oldTree: string,
  t: RepointTargets,
  deps: RepointDeps,
  unitPath: string,
): RepointPlan {
  const unit = `the systemd user unit ${unitPath}`;
  if (deps.samePath(oldTree, t.workingDirectory)) return { kind: "current", detail: `${unit} already serves this CLI's tree.` };
  const refusal = treeGate(oldTree, t, deps, unit);
  if (refusal) return { kind: "refuse", detail: refusal };

  const lines = text.split("\n");
  let section = "";
  const wdIdx: number[] = [];
  const execIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    if (trimmed.startsWith("[")) {
      section = trimmed.slice(1).replace(/\].*$/, "").trim().toLowerCase();
      continue;
    }
    if (section !== "service") continue;
    if (/\\$/.test(line)) return { kind: "refuse", detail: `${unit} uses a line continuation in [Service], so it is not re-pointed.` };
    const key = trimmed.slice(0, Math.max(0, trimmed.indexOf("="))).trim();
    if (key === "WorkingDirectory") wdIdx.push(i);
    if (key === "ExecStart") execIdx.push(i);
  }
  if (wdIdx.length !== 1 || execIdx.length !== 1) {
    return { kind: "refuse", detail: `${unit} does not have exactly one WorkingDirectory= and one ExecStart= in [Service], so it is not re-pointed.` };
  }

  const changes: RepointChange[] = [];
  const next = [...lines];
  const oldCanon = deps.canonical(oldTree);
  const mapInTree = (word: string): string | null => {
    if (!isAbsolute(word)) return null;
    const rel = relative(oldCanon, deps.canonical(word));
    if (rel === "") return t.workingDirectory;
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return `${t.workingDirectory}/${rel}`;
  };

  // WorkingDirectory=[-]<path>
  {
    const i = wdIdx[0]!;
    const m = /^(\s*WorkingDirectory\s*=\s*)(-?)(\S+)(\s*)$/.exec(lines[i]!.replace(/\r$/, ""));
    if (!m || UNSAFE_WORD.test(m[3]!) || !deps.samePath(m[3]!, oldTree)) {
      return { kind: "refuse", detail: `${unit}'s WorkingDirectory= is not the plain path of the tree it serves (${oldTree}), so it is not re-pointed.` };
    }
    next[i] = `${m[1]}${m[2]}${t.workingDirectory}${m[4]}${lines[i]!.endsWith("\r") ? "\r" : ""}`;
    changes.push({ field: "WorkingDirectory", from: m[3]!, to: t.workingDirectory });
  }

  // ExecStart=[prefixes]<words…>
  {
    const i = execIdx[0]!;
    const raw = lines[i]!.replace(/\r$/, "");
    const m = /^(\s*ExecStart\s*=\s*)([-@:+!]*)(.*)$/.exec(raw);
    if (!m) return { kind: "refuse", detail: `${unit}'s ExecStart= could not be read, so it is not re-pointed.` };
    const parts = m[3]!.split(/(\s+)/);
    const exe = parts.find((w, idx) => idx % 2 === 0 && w !== "") ?? "";
    const exeIsNode = isAbsolute(exe) && /(^|\/)node$/.test(exe);
    if (!exeIsNode && mapInTree(exe) === null) {
      return {
        kind: "refuse",
        detail: `${unit}'s ExecStart= runs ${exe || "nothing"}, which is neither node nor a file in the tree it serves, so flair cannot tell what it starts and does not re-point it.`,
      };
    }
    for (let p = 0; p < parts.length; p += 2) {
      const word = parts[p]!;
      if (word === "") continue;
      if (UNSAFE_WORD.test(word)) {
        return { kind: "refuse", detail: `${unit}'s ExecStart= uses quoting, a variable or a specifier (${word}), so it is not re-pointed.` };
      }
      if (isAbsolute(word) && /(^|\/)node$/.test(word)) {
        if (deps.canonical(word) !== deps.canonical(t.nodeBin)) {
          parts[p] = t.nodeBin;
          changes.push({ field: "node", from: word, to: t.nodeBin });
        }
        continue;
      }
      const mapped = mapInTree(word);
      if (mapped !== null) {
        if (!deps.exists(mapped)) {
          return { kind: "refuse", detail: `${unit} runs ${word}, and this CLI's tree has no ${mapped}, so it is not re-pointed.` };
        }
        parts[p] = mapped;
        changes.push({ field: "ExecStart path", from: word, to: mapped });
      }
    }
    next[i] = `${m[1]}${m[2]}${parts.join("")}${lines[i]!.endsWith("\r") ? "\r" : ""}`;
  }

  return { kind: "repoint", text: next.join("\n"), changes, detail: `re-pointed ${unit} (${describeChanges(changes)})` };
}
