import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

test("scripts using nounset guard quoted array expansions for bash 3.2", () => {
  const violations: string[] = [];
  function scan(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(path);
        continue;
      }
      if (!entry.name.endsWith(".sh")) continue;
      const source = readFileSync(path, "utf8").replace(/\\\$/g, "$");
      if (!/^\s*set\s+(?:-[a-zA-Z]*u[a-zA-Z]*(?:\s|$)|-o\s+nounset\b)/m.test(source)) continue;
      const lines = source.split("\n");
      for (const [index, line] of lines.entries()) {
        if (/^\s*#/.test(line)) continue;
        const unguarded = line.replace(/\$\{([A-Za-z_][A-Za-z_0-9]*)\[@\]\+"\$\{\1\[@\]\}"\}/g, "");
        if (/"\$\{[A-Za-z_][A-Za-z_0-9]*\[@\]\}"/.test(unguarded)) {
          violations.push(`${relative(ROOT, path)}:${index + 1}: ${line.trim()}`);
        }
      }
    }
  }
  scan(join(ROOT, "scripts"));
  expect(violations).toEqual([]);
});
