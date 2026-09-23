/**
 * Home-resolver guard (flair#1858).
 *
 * ONE home resolver for all of `src/`: `resolveHome()` in `src/lib/home.ts`
 * (win32 → `USERPROFILE`, elsewhere → `HOME`, both falling back to `homedir()`).
 * #1854 moved the keystore and the client-config writers onto it; the rest of
 * `src/` still resolves home several other ways, so different subsystems can
 * disagree about where "home" is in the SAME process — doctor inspects one home
 * while the writers use another.
 *
 * This test walks every `src/**\/*.ts` with the TypeScript parser (so comments
 * and strings do not count) and flags:
 *   - a call to `homedir(...)` (with or without the `os.` qualifier); and
 *   - a READ of `process.env.HOME` / `process.env.USERPROFILE`
 * outside `src/lib/home.ts`. An assignment TARGET (`process.env.HOME = x`) or a
 * `delete` is not a lookup and is not flagged.
 *
 * A hit is allowed only if its FILE is on the ALLOW list below, each with a
 * reason. The list is a ratchet: it names the sites that are genuinely not
 * invocation-home lookups, plus the files not yet migrated. It can only shrink.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const REPO = join(import.meta.dir, "..", "..");
const SRC_DIR = join(REPO, "src");
const RESOLVER = "src/lib/home.ts";

/**
 * Files allowed to resolve home outside `src/lib/home.ts`, with a reason.
 *
 * EMPTY (flair#1858 round 2): the `withHome()` overrides that read
 * `process.env.HOME` now live IN `src/lib/home.ts` (it sets HOME and USERPROFILE),
 * so no other file in `src/` reads either variable. Anything added here must say
 * why it is not a home lookup.
 */
const ALLOW: Array<{ file: string; reason: string }> = [];

interface Hit {
  file: string;
  line: number;
  kind: string;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

/** Parse `text` and return every home lookup, with the line it sits on. */
function scan(file: string, text: string): Hit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const hits: Hit[] = [];
  const at = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const isProcessEnvRead = (node: ts.Node, parent: ts.Node | undefined): boolean => {
    if (!ts.isPropertyAccessExpression(node)) return false;
    if (node.name.text !== "HOME" && node.name.text !== "USERPROFILE") return false;
    const env = node.expression;
    if (!ts.isPropertyAccessExpression(env) || env.name.text !== "env") return false;
    if (!ts.isIdentifier(env.expression) || env.expression.text !== "process") return false;
    // An assignment target or a delete is a WRITE/harness, not a home lookup.
    if (parent && ts.isBinaryExpression(parent) && parent.left === node) return false;
    if (parent && ts.isDeleteExpression(parent)) return false;
    return true;
  };

  const walk = (node: ts.Node, parent: ts.Node | undefined): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "homedir") {
        hits.push({ file, line: at(node), kind: "homedir()" });
      } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "homedir") {
        hits.push({ file, line: at(node), kind: "os.homedir()" });
      }
    }
    if (isProcessEnvRead(node, parent)) {
      hits.push({ file, line: at(node), kind: "process.env.HOME/USERPROFILE read" });
    }
    ts.forEachChild(node, (child) => walk(child, node));
  };
  walk(sf, undefined);
  return hits;
}

describe("home resolver guard — src/ resolves home only via src/lib/home.ts (flair#1858)", () => {
  const files = tsFiles(SRC_DIR).map((abs) => relative(REPO, abs));

  it("the scanner works and the walk reaches the source tree (positive control)", () => {
    // A zero-length walk would make the assertion below vacuously true.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(RESOLVER);
    // Prove the scanner is not blind: it must find both shapes in a snippet.
    const found = scan("snippet.ts", "const a = homedir(); const b = os.homedir(); const c = process.env.HOME;");
    expect(found.map((h) => h.kind).sort()).toEqual([
      "homedir()",
      "os.homedir()",
      "process.env.HOME/USERPROFILE read",
    ].sort());
  });

  it("every home lookup in src/ is routed through src/lib/home.ts or allow-listed", () => {
    const allowed = new Set(ALLOW.map((a) => a.file));
    const offenders: string[] = [];
    for (const rel of files) {
      if (rel === RESOLVER) continue;
      const hits = scan(rel, readFileSync(join(REPO, rel), "utf8"));
      if (allowed.has(rel)) continue;
      for (const h of hits) offenders.push(`${h.file}:${h.line} ${h.kind}`);
    }
    expect(offenders).toEqual([]);
  });
});
