/**
 * flair-mcp must stay HTTP-only via FlairClient (flair#1580).
 * Importing Harper-linked server code (resources/*, harper) would pull the
 * coupling the shared descriptor module exists to remove.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.[ct]sx?$/.test(name)) out.push(full);
  }
  return out;
}

const IMPORT_RE = /from\s+["']([^"']+)["']/g;

describe("flair-mcp dependency graph — no Harper-linked code (flair#1580)", () => {
  const files = walk(SRC);

  test("src/ is scanned (non-vacuous)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  test("no file imports harper, resources/, or mcp-tools", () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      for (const match of src.matchAll(IMPORT_RE)) {
        const spec = match[1];
        if (
          spec === "harper" ||
          spec.startsWith("harper/") ||
          spec.includes("/resources/") ||
          spec.endsWith("/mcp-tools.js") ||
          spec.endsWith("/mcp-tools.ts") ||
          spec.endsWith("/mcp-handler.js") ||
          spec.endsWith("/mcp-handler.ts")
        ) {
          violations.push(`${relative(SRC, file)} imports ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("package.json does not depend on harper or the root flair server", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps.harper).toBeUndefined();
    expect(deps["@tpsdev-ai/flair"]).toBeUndefined();
    expect(deps["@tpsdev-ai/flair-tool-descriptors"]).toBeDefined();
    expect(deps["@tpsdev-ai/flair-client"]).toBeDefined();
  });
});
