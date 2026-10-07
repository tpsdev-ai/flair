/**
 * flair#2280 — no test source binds a port a real local Flair uses.
 *
 * 9925 and 9926 are the ops and HTTP ports a default Flair holds. A test that
 * BINDS either can collide with a live instance that has the port, and — before
 * this check — its stub's failed start hung the suite instead of failing it. A
 * test source may still mention 9925/9926 as DATA (a config value, an expected
 * ops URL, a decoy to assert against); this check flags only a BIND:
 *
 *   - a listener call — `listen` or `serve` — whose line spells the literal
 *     port 9925 or 9926; or
 *   - such a call whose line names a file-local identifier that some line in
 *     the same file assigned one of those two values.
 *
 * The port match is word-bounded, so the near-miss TEST ports 19925/19926 are
 * not flagged. Scope: the test/ tree (.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs),
 * helpers included. The scan reads text, so a comment or string that itself
 * spells a bind reads as one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const TEST_ROOT = join(import.meta.dirname, "..");
const EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
/** A call that starts a listener. */
const BIND_CALL = /(?:\.|\b)(?:listen|serve)\s*\(|\bstartStub\s*\(/;
/** A literal production port, word-bounded so 19925 is not a match. */
const PORT_LITERAL = /\b(?:9925|9926)\b/;

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...testFiles(path));
    else if (EXTS.has(name.slice(name.lastIndexOf(".")))) out.push(path);
  }
  return out;
}

/** Binds of 9925/9926 in one file's text, as `lineNo: text`. */
export function portBinds(text: string): string[] {
  const assigned = new Set<string>();
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:9925|9926)\b/g)) {
    assigned.add(m[1]);
  }
  const found: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (!BIND_CALL.test(line)) return;
    const referencesPort = PORT_LITERAL.test(line) || [...assigned].some((id) => new RegExp(`\\b${id}\\b`).test(line));
    if (referencesPort) found.push(`${i + 1}: ${line.trim()}`);
  });
  return found;
}

describe("no test source binds a real Flair port (flair#2280)", () => {
  test("test/ binds neither 9925 nor 9926", () => {
    const offenders: string[] = [];
    for (const file of testFiles(TEST_ROOT)) {
      for (const bind of portBinds(readFileSync(file, "utf-8"))) {
        offenders.push(`${relative(TEST_ROOT, file)}:${bind}`);
      }
    }
    expect(offenders, `a test source binds a port a live Flair uses:\n${offenders.join("\n")}`).toEqual([]);
  });
});
