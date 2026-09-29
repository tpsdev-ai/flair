/**
 * service-repoint.ts — re-point the instance's own service unit at this CLI's
 * install tree, changing ONLY the runtime paths (flair#2034 §2).
 *
 * `flair init` used to leave an already-adopted launchd plist byte-for-byte
 * unchanged (flair#1693: an adopted plist must never be downgraded), so after a
 * Node bump the advised `flair init && flair restart` restarted the instance
 * from the OLD tree. The fix is not to regenerate the unit — that would drop
 * whatever the operator changed in it — but to replace the few values that name
 * a runtime or an install tree and leave every other byte where it was.
 *
 * These are OPERATOR FILES, so the rule is REFUSE RATHER THAN HANDLE: a unit is
 * written only when it is provably this instance's and exactly one of the
 * shapes below, every operand in its runtime role. Anything else is refused
 * with a message naming the file, what did not match, and the change to make by
 * hand. No other shape is interpreted, and no operator argument is rewritten.
 *
 *   - launchd — the pass-file plist `flair init` / `doctor --fix` write, for
 *     THIS instance: one Label (this data dir's label), one ROOTPATH (this data
 *     dir), one HOME (this user's home), no `Program` key, one WorkingDirectory
 *     and a ProgramArguments array of exactly
 *       [<tree>/templates/launchd/start-flair-with-admin-pass.sh,
 *        <this instance's admin-pass file>, <…/node>,
 *        <tree>/node_modules/<harper>/dist/bin/harper.js].
 *     Re-pointed: the launcher, node, Harper entry and WorkingDirectory. The
 *     admin-pass path and every other key are untouched.
 *   - systemd user unit (Linux; flair writes none, so only these two shapes):
 *       ExecStart=[-]<…/node> <tree>/node_modules/<harper>/dist/bin/harper.js run .
 *       ExecStart=[-]<tree>/templates/launchd/start-flair-with-admin-pass.sh <admin-pass file> <…/node> <harper.js>
 *     with exactly one `WorkingDirectory=[-]<tree>` and one `ExecStart=` in
 *     [Service], no line continuation, no quoting, specifier, variable or
 *     ExecStart prefix other than `-`. Re-pointed: node, Harper entry, launcher,
 *     WorkingDirectory. The admin-pass argument is the operator's and is kept.
 *     A target path that would need quoting in a unit (a space, a quote, `%`,
 *     `$`, …) is refused, never written.
 *
 * WHEN a valid unit is re-pointed (the same rule for both):
 *
 *   - it serves an npm-global install tree (`…/lib/node_modules/@tpsdev-ai/flair`)
 *     that is NOT this CLI's tree, whose flair version can be read and is not
 *     newer than this CLI's → node, Harper entry, launcher and tree move together;
 *   - it serves a plain tree or a checkout → never (`refuse`): separately managed;
 *   - the old tree's flair version (or this CLI's) cannot be read, or is newer
 *     → refused: a downgrade cannot be ruled out;
 *   - it serves THIS CLI's tree with an existing, different node → a deliberate
 *     runtime pin, left as it is (`pinned-node`);
 *   - launchd only: it serves this CLI's tree and one of its runtime paths no
 *     longer exists → only the missing path is replaced (systemd: refused).
 *
 * Every refusal names the unit file, what did not match, and the remedy — the
 * paths to set by hand, an update, or a reinstall.
 *
 * Pure: text in, text out. The callers own the reads, the atomic write (with
 * the planned-from re-check) and the service-manager reload.
 */
import { basename, isAbsolute, relative, sep } from "node:path";
import { escapeXml, unescapeXml } from "./xml-escape.js";
import { compareVersions, isNpmGlobalFlairTree } from "./tree-divergence.js";

export const LAUNCHER_BASENAME = "start-flair-with-admin-pass.sh";
/** The launcher's path relative to an install tree. */
export const LAUNCHER_REL = "templates/launchd/start-flair-with-admin-pass.sh";
/** A Harper entry's path relative to an install tree (`harper`, `@harperfast/harper`, …). */
const HARPER_ENTRY_REL = /^node_modules\/(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+\/dist\/bin\/harper\.js$/;
/**
 * The characters a path may contain to be written into a systemd unit as one
 * unquoted word. A whitelist: anything else (a space, a quote, `%`, `$`, `\`,
 * `;`, a control character) would need quoting or escaping, and is refused.
 */
const SYSTEMD_SAFE_PATH = /^\/[A-Za-z0-9._@+~/-]*$/;
/** One unquoted word of a supported ExecStart= (the same whitelist, plus the relative `run` and `.`). */
const SYSTEMD_SAFE_WORD = /^[A-Za-z0-9._@+~/-]+$/;

export interface RepointTargets {
  /** The launcher in this CLI's tree. Required for the launchd plist and a launcher-shape systemd unit. */
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

/** What a launchd plist must declare to be THIS instance's. */
export interface PlistOwnership {
  /** This data dir's launchd label. */
  label: string;
  /** This data dir (the plist's ROOTPATH). */
  dataDir: string;
  /** This user's home (the plist's HOME). */
  home: string;
  /** This instance's admin-pass file (ProgramArguments[1]). */
  adminPassFile: string;
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

/** `p` relative to `tree` (both canonical, `/`-separated), or null when `p` is not strictly inside `tree`. */
function relInTree(tree: string, p: string, deps: RepointDeps): string | null {
  if (!isAbsolute(p) || !isAbsolute(tree)) return null;
  const rel = relative(deps.canonical(tree), deps.canonical(p));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function isNodeBinary(p: string): boolean {
  return isAbsolute(p) && basename(p) === "node";
}

/** The hand-edit remedy every refusal carries. */
function byHand(t: RepointTargets, launcher: boolean): string {
  const parts = [
    ...(launcher && t.launcher ? [`the launcher to ${t.launcher}`] : []),
    `node to ${t.nodeBin}`,
    `the Harper entry to ${t.harperBin}`,
    `WorkingDirectory to ${t.workingDirectory}`,
  ];
  return ` To move it to this CLI's tree, set ${parts.join(", ")} by hand, then run: flair restart`;
}

/** Why this CLI's own targets cannot be written into the unit, or null. */
function targetProblem(t: RepointTargets, deps: RepointDeps, launcher: boolean, systemd: boolean): string | null {
  if (!isNodeBinary(t.nodeBin)) return `this CLI's node path ${t.nodeBin} is not an absolute path to a \`node\` binary.`;
  const harperRel = relInTree(t.workingDirectory, t.harperBin, deps);
  if (harperRel === null || !HARPER_ENTRY_REL.test(harperRel)) {
    return `this CLI's Harper entry ${t.harperBin} is not inside its install tree ${t.workingDirectory}.`;
  }
  if (launcher) {
    if (!t.launcher) return "this CLI's launcher path is not known.";
    if (relInTree(t.workingDirectory, t.launcher, deps) !== LAUNCHER_REL) {
      return `this CLI's launcher ${t.launcher} is not ${LAUNCHER_REL} inside its install tree ${t.workingDirectory}.`;
    }
  }
  if (systemd) {
    for (const p of [t.workingDirectory, t.nodeBin, t.harperBin, ...(launcher && t.launcher ? [t.launcher] : [])]) {
      if (!SYSTEMD_SAFE_PATH.test(p)) {
        return (
          `this CLI's path ${JSON.stringify(p)} contains a character that would need quoting in a systemd unit, and flair ` +
          "does not write quoted paths into a unit."
        );
      }
    }
  }
  return null;
}

/**
 * Shared decision: may a unit serving `oldTree` be moved to `t.workingDirectory`?
 * Every refusal carries its remedy (a hand edit, an update, or a reinstall).
 */
function treeGate(oldTree: string, t: RepointTargets, deps: RepointDeps, unit: string, launcher: boolean): string | null {
  if (!isNpmGlobalFlairTree(oldTree)) {
    return (
      `${unit} serves ${oldTree}, which is not an npm-global install (a plain tree or a checkout), so flair treats it ` +
      `as a separately managed deployment and does not re-point it.${byHand(t, launcher)}`
    );
  }
  const oldVersion = deps.treeVersion(oldTree);
  if (!oldVersion) {
    return (
      `${unit} serves ${oldTree}, whose flair version cannot be read, so flair cannot rule out that re-pointing would ` +
      `downgrade the instance, and does not re-point it.${byHand(t, launcher)}`
    );
  }
  if (!t.cliVersion) {
    return (
      `this CLI's own flair version cannot be read, so flair cannot rule out that re-pointing ${unit} would downgrade ` +
      `the instance, and does not re-point it.${byHand(t, launcher)}`
    );
  }
  if (compareVersions(t.cliVersion, oldVersion) < 0) {
    return (
      `${unit} serves flair ${oldVersion} from ${oldTree}; this CLI's tree has the older ${t.cliVersion}, so re-pointing ` +
      "would downgrade the instance. Update this CLI's tree first (npm i -g @tpsdev-ai/flair), then re-run flair init."
    );
  }
  for (const p of [t.workingDirectory, t.harperBin, ...(t.launcher ? [t.launcher] : []), t.nodeBin]) {
    if (!deps.exists(p)) {
      return (
        `this CLI's tree is missing ${p}, so ${unit} cannot be re-pointed at it. Reinstall this CLI's tree ` +
        "(npm i -g @tpsdev-ai/flair), then re-run flair init."
      );
    }
  }
  return null;
}

// ─── launchd ──────────────────────────────────────────────────────────────

function keyCount(raw: string, key: string): number {
  return raw.split(`<key>${key}</key>`).length - 1;
}

function stringValue(raw: string, key: string): string | null {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(raw);
  return m ? unescapeXml(m[1]!) : null;
}

/**
 * Plan the re-point of an adopted pass-file plist. `raw` must be THIS
 * instance's plist (see PlistOwnership) in the `buildLaunchdPlist` shape; see
 * the module header for exactly what is checked and what is changed.
 */
export function planPlistRuntimeRepoint(
  raw: string,
  t: RepointTargets,
  deps: RepointDeps,
  plistPath: string,
  owner: PlistOwnership,
): RepointPlan {
  const unit = `the launchd plist ${plistPath}`;
  const refuse = (what: string): RepointPlan => ({
    kind: "refuse",
    detail: `${unit} ${what}, so it is not re-pointed.${byHand(t, true)}`,
  });
  if (!t.launcher) return { kind: "refuse", detail: "internal: no launcher path to write" };

  // One unambiguous declaration of each key this decision reads.
  for (const key of ["Label", "ProgramArguments", "WorkingDirectory", "ROOTPATH", "HOME"]) {
    if (keyCount(raw, key) !== 1) return refuse(`does not declare exactly one ${key}`);
  }
  if (keyCount(raw, "Program") !== 0) return refuse("declares a Program key, which launchd runs instead of ProgramArguments[0]");
  const label = stringValue(raw, "Label");
  if (label !== owner.label) return refuse(`has the Label ${JSON.stringify(label)}, not this data directory's ${owner.label}`);
  const rootPath = stringValue(raw, "ROOTPATH");
  if (rootPath === null || !deps.samePath(rootPath, owner.dataDir)) {
    return refuse(`declares ROOTPATH ${JSON.stringify(rootPath)}, not this data directory ${owner.dataDir}`);
  }
  const home = stringValue(raw, "HOME");
  if (home === null || !deps.samePath(home, owner.home)) {
    return refuse(`declares HOME ${JSON.stringify(home)}, not this user's home ${owner.home}`);
  }

  const argsBlock = /(<key>ProgramArguments<\/key>\s*<array>)([\s\S]*?)(<\/array>)/.exec(raw);
  const wd = /(<key>WorkingDirectory<\/key>\s*<string>)([^<]*)(<\/string>)/.exec(raw);
  if (!argsBlock || !wd) return refuse("does not have a ProgramArguments array and a WorkingDirectory string");
  const inner = argsBlock[2]!;
  const strings = [...inner.matchAll(/<string>([^<]*)<\/string>/g)];
  if (strings.length !== 4 || inner.replace(/<string>[^<]*<\/string>/g, "").trim() !== "") {
    return refuse("does not have the four-argument pass-file launcher ProgramArguments flair writes");
  }
  const args = strings.map((m) => unescapeXml(m[1]!));
  const oldTree = unescapeXml(wd[2]!);
  if (!isAbsolute(oldTree)) return refuse(`has a WorkingDirectory that is not an absolute path (${JSON.stringify(oldTree)})`);
  if (relInTree(oldTree, args[0]!, deps) !== LAUNCHER_REL) {
    return refuse(`runs ${args[0]} as its program, not ${LAUNCHER_REL} inside its WorkingDirectory ${oldTree}`);
  }
  if (!isAbsolute(args[1]!) || !deps.samePath(args[1]!, owner.adminPassFile)) {
    return refuse(`passes the admin-pass file ${args[1]}, not this instance's ${owner.adminPassFile}`);
  }
  if (!isNodeBinary(args[2]!)) return refuse(`has ${args[2]} where the node binary goes`);
  const harperRel = relInTree(oldTree, args[3]!, deps);
  if (harperRel === null || !HARPER_ENTRY_REL.test(harperRel)) {
    return refuse(`has ${args[3]} where the Harper entry inside its WorkingDirectory ${oldTree} goes`);
  }
  const targetBad = targetProblem(t, deps, true, false);
  if (targetBad) return { kind: "refuse", detail: `${unit} is not re-pointed: ${targetBad}${byHand(t, true)}` };

  const current = { launcher: args[0]!, nodeBin: args[2]!, harperBin: args[3]!, workingDirectory: oldTree };
  const next = { ...current };
  const sameTree = deps.samePath(oldTree, t.workingDirectory);
  if (sameTree) {
    // Same tree: replace only what no longer exists; an existing different node is a deliberate pin.
    if (!deps.exists(current.launcher)) next.launcher = t.launcher;
    if (!deps.exists(current.harperBin)) next.harperBin = t.harperBin;
    if (!deps.exists(current.nodeBin)) next.nodeBin = t.nodeBin;
  } else {
    const refusal = treeGate(oldTree, t, deps, unit, true);
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
          `runtime pin is left as it is. To move it, change that node path to ${t.nodeBin} by hand, then run: flair restart`,
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

/**
 * Plan the re-point of the systemd USER unit proven to own the serving process.
 * `oldTree` is the tree the unit serves now. The whole supported shape is
 * validated FIRST — before any `current`, `pinned-node` or `repoint` answer —
 * and only the runtime operands, identified by their role, are replaced.
 */
export function planSystemdUnitRuntimeRepoint(
  text: string,
  oldTree: string,
  t: RepointTargets,
  deps: RepointDeps,
  unitPath: string,
): RepointPlan {
  const unit = `the systemd user unit ${unitPath}`;
  let launcherShape = false;
  const refuse = (what: string): RepointPlan => ({
    kind: "refuse",
    detail: `${unit} ${what}, so it is not re-pointed.${byHand(t, launcherShape)}`,
  });

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
    if (/\\$/.test(line)) return refuse("uses a line continuation in [Service]");
    const key = trimmed.slice(0, Math.max(0, trimmed.indexOf("="))).trim();
    if (key === "WorkingDirectory") wdIdx.push(i);
    if (key === "ExecStart") execIdx.push(i);
  }
  if (wdIdx.length !== 1 || execIdx.length !== 1) {
    return refuse("does not have exactly one WorkingDirectory= and one ExecStart= in [Service]");
  }

  // WorkingDirectory=[-]<the tree it serves>
  const wdLine = lines[wdIdx[0]!]!;
  const wdm = /^(\s*WorkingDirectory\s*=\s*)(-?)(\S+)(\s*)$/.exec(wdLine.replace(/\r$/, ""));
  if (!wdm || !SYSTEMD_SAFE_PATH.test(wdm[3]!) || !deps.samePath(wdm[3]!, oldTree)) {
    return refuse(`has a WorkingDirectory= that is not the plain path of the tree it serves (${oldTree})`);
  }

  // ExecStart=[-]<one of the two supported argv shapes>
  const execLine = lines[execIdx[0]!]!;
  const em = /^(\s*ExecStart\s*=\s*)([-@:+!]*)(.*?)(\s*)$/.exec(execLine.replace(/\r$/, ""));
  if (!em) return refuse("has an ExecStart= that could not be read");
  if (em[2] !== "" && em[2] !== "-") return refuse(`uses the ExecStart= prefix ${JSON.stringify(em[2])} (only "-" is supported)`);
  const parts = em[3]!.split(/(\s+)/);
  const words = parts.filter((_, idx) => idx % 2 === 0);
  if (words.some((w) => w === "" || !SYSTEMD_SAFE_WORD.test(w))) {
    return refuse("has an ExecStart= with quoting, a specifier, a variable or another character flair does not interpret");
  }
  const roles: { launcher?: number; passFile?: number; node: number; harper: number } | null =
    words.length === 4 && words[2] === "run" && words[3] === "."
      ? { node: 0, harper: 1 }
      : words.length === 4 && basename(words[0]!) === LAUNCHER_BASENAME
        ? { launcher: 0, passFile: 1, node: 2, harper: 3 }
        : null;
  if (!roles) {
    return refuse(
      "has an ExecStart= that is neither `<node> <harper.js> run .` nor " +
        "`<tree>/templates/launchd/start-flair-with-admin-pass.sh <admin-pass file> <node> <harper.js>`",
    );
  }
  launcherShape = roles.launcher !== undefined;
  const oldNode = words[roles.node]!;
  const oldHarper = words[roles.harper]!;
  if (!isNodeBinary(oldNode)) return refuse(`has ${oldNode} where the node binary goes`);
  const harperRel = relInTree(oldTree, oldHarper, deps);
  if (harperRel === null || !HARPER_ENTRY_REL.test(harperRel)) {
    return refuse(`has ${oldHarper} where the Harper entry inside ${oldTree} goes`);
  }
  if (roles.launcher !== undefined && relInTree(oldTree, words[roles.launcher]!, deps) !== LAUNCHER_REL) {
    return refuse(`runs ${words[roles.launcher]} instead of ${LAUNCHER_REL} inside ${oldTree}`);
  }
  if (roles.passFile !== undefined && !isAbsolute(words[roles.passFile]!)) {
    return refuse(`passes an admin-pass file that is not an absolute path (${words[roles.passFile]})`);
  }
  const targetBad = targetProblem(t, deps, launcherShape, true);
  if (targetBad) return { kind: "refuse", detail: `${unit} is not re-pointed: ${targetBad}${byHand(t, launcherShape)}` };

  // Only now, with the whole shape validated: is it already this CLI's tree?
  if (deps.samePath(oldTree, t.workingDirectory)) {
    const runtime = [oldNode, oldHarper, ...(roles.launcher !== undefined ? [words[roles.launcher]!] : [])];
    const missing = runtime.filter((p) => !deps.exists(p));
    if (missing.length > 0) {
      return refuse(`serves this CLI's tree but names ${missing.join(", ")}, which does not exist`);
    }
    if (deps.canonical(oldNode) !== deps.canonical(t.nodeBin)) {
      return {
        kind: "pinned-node",
        unitNodeBin: oldNode,
        detail:
          `${unit} serves this CLI's tree with node ${oldNode} (this CLI runs ${t.nodeBin}); a deliberate runtime pin ` +
          `is left as it is. To move it, change that node path to ${t.nodeBin} by hand, then run: flair restart`,
      };
    }
    return { kind: "current", detail: `${unit} already serves this CLI's tree.` };
  }
  const refusal = treeGate(oldTree, t, deps, unit, launcherShape);
  if (refusal) return { kind: "refuse", detail: refusal };

  const changes: RepointChange[] = [];
  const set = (role: number, to: string, field: string): void => {
    const from = words[role]!;
    if (from === to) return;
    parts[role * 2] = to;
    changes.push({ field, from, to });
  };
  if (roles.launcher !== undefined) set(roles.launcher, t.launcher!, "launcher");
  if (deps.canonical(oldNode) !== deps.canonical(t.nodeBin)) set(roles.node, t.nodeBin, "node");
  set(roles.harper, t.harperBin, "Harper entry");

  const cr = (l: string): string => (l.endsWith("\r") ? "\r" : "");
  const next = [...lines];
  next[wdIdx[0]!] = `${wdm[1]}${wdm[2]}${t.workingDirectory}${wdm[4]}${cr(wdLine)}`;
  changes.push({ field: "WorkingDirectory", from: wdm[3]!, to: t.workingDirectory });
  next[execIdx[0]!] = `${em[1]}${em[2]}${parts.join("")}${em[4]}${cr(execLine)}`;

  return { kind: "repoint", text: next.join("\n"), changes, detail: `re-pointed ${unit} (${describeChanges(changes)})` };
}
