/**
 * env-admin-pass-no-inline-dual-read.test.ts — Issue #3093.
 *
 * Asserts that no file in src/ other than src/lib/auth-resolve.ts performs an
 * inline fallback between FLAIR_ADMIN_PASS and HDB_ADMIN_PASSWORD. All callers
 * must use the shared envAdminPass() helper to ensure consistent empty-string
 * fallback semantics.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC_DIR = resolve(import.meta.dir, "..", "..", "src");

function walkTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...walkTsFiles(fullPath));
    } else if (entry.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("source scanner: envAdminPass centralization (#3093)", () => {
  test("no src/ file other than auth-resolve.ts reads FLAIR_ADMIN_PASS and HDB_ADMIN_PASSWORD inline together", () => {
    const tsFiles = walkTsFiles(SRC_DIR);
    const violations: { file: string; match: string }[] = [];

    // Detects inline fallback expressions like:
    // process.env.FLAIR_ADMIN_PASS || process.env.HDB_ADMIN_PASSWORD
    // process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD
    // or with HDB_ADMIN_PASSWORD first
    const dualReadPattern = /(?:FLAIR_ADMIN_PASS|HDB_ADMIN_PASSWORD)\s*(?:\|\||\?\?)\s*(?:process\.env\.)?(?:FLAIR_ADMIN_PASS|HDB_ADMIN_PASSWORD)/;

    for (const file of tsFiles) {
      const relPath = relative(SRC_DIR, file).replace(/\\/g, "/");
      // auth-resolve.ts is the canonical home of envAdminPass()
      if (relPath === "lib/auth-resolve.ts") continue;

      const content = readFileSync(file, "utf-8");
      const match = content.match(dualReadPattern);
      if (match) {
        violations.push({ file: relPath, match: match[0] });
      }
    }

    expect(violations).toEqual([]);
  });
});
