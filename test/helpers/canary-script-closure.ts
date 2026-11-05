/**
 * The post-publish canary's script closure (flair#1856, flair#1928 slice 2).
 *
 * ONE walker, shared by the dependency-free guard and the release-promote trust
 * contract: every `node scripts/...` invocation and `scripts/...*.sh` helper in
 * `.github/workflows/canary.yml`, the node scripts those helpers call, and the
 * transitive relative-import graph of every module reached.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CANARY_YML = join(REPO_ROOT, ".github", "workflows", "canary.yml");

/** Drop whole-line comments so a doc reference is not read as an invocation. */
function stripComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** Repo-relative paths of every `node scripts/...` invocation in `text`. */
function nodeScriptsInvoked(text: string, shell = ""): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bnode\s+(scripts\/[A-Za-z0-9._/-]+\.(?:mjs|cjs|js|ts))\b/g)) {
    out.add(m[1]!);
  }
  for (const m of text.matchAll(/\bnode\s+"\$SCRIPT_DIR\/([A-Za-z0-9._/-]+\.mjs)"/g)) {
    if (!shell) throw new Error("sibling Node script without a shell path");
    out.add(join(dirname(shell), m[1]!));
  }
  return [...out];
}

/**
 * Repo-relative paths of every shell script referenced in `text`: a literal
 * `scripts/...*.sh`, or a sibling `"$SCRIPT_DIR/...*.sh"` resolved against `shell`.
 */
function shellScriptsReferenced(text: string, shell = ""): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(scripts\/[A-Za-z0-9._/-]+\.sh)\b/g)) {
    out.add(m[1]!);
  }
  for (const m of text.matchAll(/"\$SCRIPT_DIR\/([A-Za-z0-9._/-]+\.sh)"/g)) {
    if (!shell) throw new Error("sibling shell script without a shell path");
    out.add(join(dirname(shell), m[1]!));
  }
  return [...out];
}

/**
 * Every import/require specifier in a module's source: static `from "..."`,
 * side-effect `import "..."`, `require("...")` and dynamic `import("...")`.
 * Only `"` / `'` are treated as specifier quotes (a backtick is never a static
 * import specifier, and matching one false-positives on prose in comments).
 */
function importSpecifiers(text: string): string[] {
  const Q = `["']([^"']+)["']`;
  const patterns = [
    new RegExp(`\\bfrom\\s*${Q}`, "g"),
    new RegExp(`\\bimport\\s*${Q}`, "g"),
    new RegExp(`\\brequire\\s*\\(\\s*${Q}\\s*\\)`, "g"),
    new RegExp(`\\bimport\\s*\\(\\s*${Q}\\s*\\)`, "g"),
  ];
  const out: string[] = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) out.push(m[1]!);
  }
  return out;
}

export interface Closure {
  shellScripts: string[];
  modules: string[];
  /** Total import/require specifiers extracted from the closure. */
  specifierCount: number;
  /** Bare (non-`node:`, non-relative) specifiers, with the file that has them. */
  bare: { file: string; spec: string }[];
}

/**
 * The canary's script closure: the workflow's node scripts + shell helpers, the
 * node scripts those helpers call, and the transitive relative-import graph of
 * every module reached.
 */
export function canaryScriptClosure(overrides: Readonly<Record<string, string>> = {}): Closure {
  const workflow = stripComments(readFileSync(CANARY_YML, "utf8"));

  const moduleQueue = nodeScriptsInvoked(workflow);
  const shellQueue = shellScriptsReferenced(workflow);
  const shellSeen = new Set<string>();

  while (shellQueue.length) {
    const sh = shellQueue.shift()!;
    if (shellSeen.has(sh)) continue;
    shellSeen.add(sh);
    const full = join(REPO_ROOT, sh);
    if (!existsSync(full)) continue;
    // Join backslash-newline continuations first, so a command split across lines is
    // scanned as the one command the shell runs.
    const text = stripComments(overrides[sh] ?? readFileSync(full, "utf8")).replace(/\\\n/g, " ");
    moduleQueue.push(...nodeScriptsInvoked(text, sh));
    // Whitelist, not blacklist: every `node` command must run a script in exactly one of the
    // two forms nodeScriptsInvoked() records (`scripts/...` or "$SCRIPT_DIR/..."), with no
    // options before it. Anything else (-e, -p, --eval, stdin, a pipe, a heredoc, an option)
    // is code the dependency walk cannot inspect. This guards against ACCIDENTAL inline
    // bodies and unwalked scripts; it is not a sandbox (NODE_OPTIONS and the environment are
    // out of scope).
    for (const m of text.matchAll(/(?:^|[\s;&|(`])node(?=$|[\s<>|;&)])([^\n]*)/gm)) {
      const rest = m[1].trim();
      if (!/^(?:scripts\/[A-Za-z0-9._/-]+\.(?:mjs|cjs|js|ts)|"\$SCRIPT_DIR\/[A-Za-z0-9._/-]+\.mjs")(?=$|[\s;&|)`])/.test(rest)) throw new Error("inline Node body in " + sh + ": node " + rest);
    }
    shellQueue.push(...shellScriptsReferenced(text, sh));
  }

  const moduleSeen = new Set<string>();
  const bare: { file: string; spec: string }[] = [];
  let specifierCount = 0;

  while (moduleQueue.length) {
    const rel = moduleQueue.shift()!;
    if (moduleSeen.has(rel)) continue;
    moduleSeen.add(rel);
    const full = join(REPO_ROOT, rel);
    // A module the canary runs must exist: a silent skip would leave its imports unchecked.
    if (!existsSync(full)) throw new Error("walked module missing: " + rel);
    const text = stripComments(readFileSync(full, "utf8"));
    for (const spec of importSpecifiers(text)) {
      specifierCount++;
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".")) {
        moduleQueue.push(relative(REPO_ROOT, resolve(dirname(full), spec)));
        continue;
      }
      bare.push({ file: rel, spec });
    }
  }

  return { shellScripts: [...shellSeen], modules: [...moduleSeen], specifierCount, bare };
}
