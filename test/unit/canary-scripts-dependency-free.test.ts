/**
 * flair#1856 — the post-publish canary must run with NO repository dependencies.
 *
 * The 0.55.2 canary died before it measured anything:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'semver' imported from
 *   scripts/ci/registry-tarball-sha256.mjs
 *   hashed 0/9 lockstep tarballs — refusing to promote a partial set
 *
 * The canary job (`.github/workflows/canary.yml`) runs on a clean,
 * credential-less runner that NEVER installs this repo's dependencies, so any
 * bare package specifier in a script it runs is a hard crash at module load.
 *
 * This is the CLASS guard, not a check of that one file. It walks every script
 * the canary runs — `node scripts/...` invocations in the workflow, the
 * `scripts/ci/*.sh` helpers the workflow calls, and the node scripts those shell
 * scripts invoke — follows relative imports transitively, and asserts every
 * import specifier is a `node:` builtin or a relative path.
 *
 * A bare specifier anywhere in that closure is a dependency the canary cannot
 * resolve. Adding `import x from "semver"` to any canary script turns this red.
 */

import { beforeAll, describe, expect, test } from "bun:test";
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

interface Closure {
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
function canaryScriptClosure(overrides: Readonly<Record<string, string>> = {}): Closure {
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

test.each(["node -e 'require(\"semver\")'", "node --eval 'require(\"semver\")'", "node -p 'require(\"semver\")'", "node - <<'JS'\nrequire(\"semver\")\nJS", "node -pe '21+21'", "node -- <<'JS'\n21+21\nJS", "node <<'JS'\n21+21\nJS", "echo 21 | node", "node<<'JS'\n21\nJS", "node --require ./x.js scripts/ci/lockstep-packages.mjs"])("rejects inline Node in a shell fixture: %s", (inline: string) => {
  const shell = "scripts/ci/check-instance-boot.sh";
  const fixture = readFileSync(join(REPO_ROOT, shell), "utf8") + "\n" + inline + "\n";
  expect(() => canaryScriptClosure({ [shell]: fixture })).toThrow("inline Node body");
});

test("a sibling shell script called through $SCRIPT_DIR is walked and guarded", () => {
  const helper = "scripts/ci/doctor-advisory.sh";
  const fixture = readFileSync(join(REPO_ROOT, helper), "utf8") + "\nnode -e 'require(\"semver\")'\n";
  expect(() => canaryScriptClosure({ [helper]: fixture })).toThrow("inline Node body in " + helper);
});

test("a command continued across lines is scanned as one command", () => {
  const shell = "scripts/ci/check-instance-boot.sh";
  const fixture = readFileSync(join(REPO_ROOT, shell), "utf8") + "\nnode \\\n  -p '6*7'\n";
  expect(() => canaryScriptClosure({ [shell]: fixture })).toThrow("inline Node body");
});

test("a walked module that does not exist fails the walk", () => {
  const shell = "scripts/ci/check-instance-boot.sh";
  const fixture = readFileSync(join(REPO_ROOT, shell), "utf8") + "\nnode scripts/ci/does-not-exist-1859.mjs\n";
  expect(() => canaryScriptClosure({ [shell]: fixture })).toThrow("walked module missing");
});

describe("post-publish canary scripts are dependency-free (flair#1856)", () => {
  // Built in a hook, not at describe time: a throw here must FAIL these tests, not drop them.
  let closure: Closure;
  beforeAll(() => {
    closure = canaryScriptClosure();
  });

  test("the walk reached the canary's scripts (positive control)", () => {
    // A zero-length closure would make the assertion below vacuously true — the
    // exact failure mode (a check that scans nothing and reports green).
    expect(closure.modules.length).toBeGreaterThanOrEqual(5);
    expect(closure.modules).toContain("scripts/ci/registry-tarball-sha256.mjs");
    expect(closure.modules).toContain("scripts/ci/boot-probe.mjs");
    expect(closure.shellScripts).toContain("scripts/ci/check-instance-boot.sh");
    expect(closure.shellScripts).toContain("scripts/ci/canary-verdict.sh");
    expect(closure.shellScripts).toContain("scripts/ci/doctor-advisory.sh");
    // ...and it actually parsed imports out of them, rather than reading files
    // whose specifiers the regex never saw.
    expect(closure.specifierCount).toBeGreaterThan(10);
  });

  test("every import in the closure is a node: builtin or a relative path", () => {
    const rendered = closure.bare.map((b) => `${b.file} imports "${b.spec}"`);
    expect(rendered).toEqual([]);
  });
});
