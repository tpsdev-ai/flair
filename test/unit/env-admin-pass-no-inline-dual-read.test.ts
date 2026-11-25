/**
 * env-admin-pass-no-inline-dual-read.test.ts — Issue #3093.
 *
 * Asserts that ambient admin password reads in src/ use the shared envAdminPass()
 * helper, failing on any read of process.env.FLAIR_ADMIN_PASS or
 * process.env.HDB_ADMIN_PASSWORD outside envAdminPass() itself, with an explicit
 * allowlist of named exceptions:
 *   - init's separate ordered reads during install/bootstrap
 *   - the two direct-start sites (src/commands/service.ts ~656 and src/cli.ts ~8641)
 *     where HDB_ADMIN_PASSWORD takes precedence as Harper's bootstrap variable
 *   - sites that intentionally read only one variable (e.g. service.ts ~600,
 *     commands that only support FLAIR_ADMIN_PASS, or diagnostic recordings)
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC_DIR = resolve(import.meta.dir, "..", "..", "src");

export interface AllowedRead {
  file: string;
  pattern: RegExp;
  reason: string;
}

export const ALLOWED_READS: AllowedRead[] = [
  // 1. Definition site in auth-resolve.ts
  {
    file: "lib/auth-resolve.ts",
    pattern: /return process\.env\.FLAIR_ADMIN_PASS \|\| process\.env\.HDB_ADMIN_PASSWORD \|\| undefined;/,
    reason: "Definition of the envAdminPass() helper itself",
  },
  // 2. Diagnostic recording of which ambient env var was used
  {
    file: "lib/auth-resolve.ts",
    pattern: /adminPassEnvVar:\s*process\.env\.FLAIR_ADMIN_PASS/,
    reason: "Diagnostic recording of which ambient env var was used",
  },
  {
    file: "lib/auth-resolve.ts",
    pattern: /:\s*process\.env\.HDB_ADMIN_PASSWORD \? "HDB_ADMIN_PASSWORD" : undefined/,
    reason: "Diagnostic recording of which ambient env var was used",
  },
  // 3. Local/remote target disambiguation
  {
    file: "lib/auth-resolve.ts",
    pattern: /if \(process\.env\.FLAIR_ADMIN_PASS\) return process\.env\.FLAIR_ADMIN_PASS;/,
    reason: "Local target check intentionally takes only FLAIR_ADMIN_PASS",
  },
  // 4. Two direct-start sites where HDB_ADMIN_PASSWORD takes precedence
  {
    file: "commands/service.ts",
    pattern: /const adminPass = process\.env\.HDB_ADMIN_PASSWORD \|\| process\.env\.FLAIR_ADMIN_PASS \|\| "";/,
    reason: "Harper direct start: HDB_ADMIN_PASSWORD takes precedence as Harper's bootstrap variable (#3093)",
  },
  {
    file: "cli.ts",
    pattern: /const adminPass = process\.env\.HDB_ADMIN_PASSWORD \|\| process\.env\.FLAIR_ADMIN_PASS \|\| "";/,
    reason: "Harper restart direct start: HDB_ADMIN_PASSWORD takes precedence as Harper's bootstrap variable (#3093)",
  },
  // 5. Init's separate ordered reads
  {
    file: "commands/init.ts",
    pattern: /let flairAdminPass = opts\.flairAdminPass \|\| process\.env\.FLAIR_ADMIN_PASS;/,
    reason: "init's separate ordered reads during install/bootstrap",
  },
  {
    file: "commands/init.ts",
    pattern: /\} else if \(process\.env\.FLAIR_ADMIN_PASS\) \{/,
    reason: "init's separate ordered reads during install/bootstrap",
  },
  {
    file: "commands/init.ts",
    pattern: /adminPass = process\.env\.FLAIR_ADMIN_PASS;/,
    reason: "init's separate ordered reads during install/bootstrap",
  },
  {
    file: "commands/init.ts",
    pattern: /\} else if \(process\.env\.HDB_ADMIN_PASSWORD\) \{/,
    reason: "init's separate ordered reads during install/bootstrap",
  },
  {
    file: "commands/init.ts",
    pattern: /adminPass = process\.env\.HDB_ADMIN_PASSWORD;/,
    reason: "init's separate ordered reads during install/bootstrap",
  },
  // 6. Reads that intentionally take only HDB_ADMIN_PASSWORD
  {
    file: "commands/service.ts",
    pattern: /adminPass: process\.env\.HDB_ADMIN_PASSWORD \?\? "",/,
    reason: "Service status intentionally checks only HDB_ADMIN_PASSWORD",
  },
  {
    file: "cli.ts",
    pattern: /deps\.adminPass \?\? process\.env\.HDB_ADMIN_PASSWORD \?\? "",/,
    reason: "Harness/doctor intentionally checks only HDB_ADMIN_PASSWORD",
  },
  {
    file: "cli.ts",
    pattern: /adminPass: process\.env\.HDB_ADMIN_PASSWORD \?\? "",/,
    reason: "Direct spawn health check intentionally checks only HDB_ADMIN_PASSWORD",
  },
  {
    file: "cli.ts",
    pattern: /waitForHealth\(port, DEFAULT_ADMIN_USER, process\.env\.HDB_ADMIN_PASSWORD \?\? "", STARTUP_TIMEOUT_MS\)/,
    reason: "Direct spawn waitHealthy intentionally checks only HDB_ADMIN_PASSWORD",
  },
  // 7. Commands intentionally taking only FLAIR_ADMIN_PASS
  {
    file: "commands/agent.ts",
    pattern: /process\.env\.FLAIR_ADMIN_PASS/,
    reason: "Agent commands intentionally read only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/backup-approval.ts",
    pattern: /process\.env\.FLAIR_ADMIN_PASS/,
    reason: "Backup-approval intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/backup.ts",
    pattern: /process\.env\.FLAIR_ADMIN_PASS/,
    reason: "Backup intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/export.ts",
    pattern: /process\.env\.FLAIR_ADMIN_PASS/,
    reason: "Export intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/federation.ts",
    pattern: /process\.env\.FLAIR_ADMIN_PASS/,
    reason: "Federation intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/grant.ts",
    pattern: /process\.env\.FLAIR_ADMIN_PASS/,
    reason: "Grant intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/idp.ts",
    pattern: /process\.env\.FLAIR_ADMIN_PASS/,
    reason: "IdP intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/import.ts",
    pattern: /process\.env\.FLAIR_ADMIN_PASS/,
    reason: "Import intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/integrity.ts",
    pattern: /process\.env\.FLAIR_ADMIN_PASS/,
    reason: "Integrity intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/mcp.ts",
    pattern: /process\.env\.FLAIR_ADMIN_PASS/,
    reason: "MCP intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/principal.ts",
    pattern: /process\.env\.FLAIR_ADMIN_PASS/,
    reason: "Principal intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/rem.ts",
    pattern: /process\.env\.FLAIR_ADMIN_PASS/,
    reason: "REM intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/restore.ts",
    pattern: /process\.env\.FLAIR_ADMIN_PASS/,
    reason: "Restore intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/test.ts",
    pattern: /process\.env\.FLAIR_ADMIN_PASS/,
    reason: "Test intentionally reads only FLAIR_ADMIN_PASS",
  },
];

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

export function scanFileLines(
  relPath: string,
  content: string,
  allowlist: AllowedRead[]
): { file: string; line: number; text: string }[] {
  const violations: { file: string; line: number; text: string }[] = [];
  const lines = content.split("\n");
  const readPattern = /process\.env\.(FLAIR_ADMIN_PASS|HDB_ADMIN_PASSWORD)/;

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (!readPattern.test(lineText)) continue;

    // Check if this line matches an entry in allowlist for this file
    const isAllowed = allowlist.some(
      (entry) => entry.file === relPath && entry.pattern.test(lineText)
    );

    if (!isAllowed) {
      violations.push({ file: relPath, line: i + 1, text: lineText.trim() });
    }
  }

  return violations;
}

describe("source scanner: envAdminPass allowlist (#3093)", () => {
  test("fails on any read of process.env.FLAIR_ADMIN_PASS or HDB_ADMIN_PASSWORD in src/ outside allowlist", () => {
    const tsFiles = walkTsFiles(SRC_DIR);
    const violations: { file: string; line: number; text: string }[] = [];

    for (const file of tsFiles) {
      const relPath = relative(SRC_DIR, file).replace(/\\/g, "/");
      const content = readFileSync(file, "utf-8");
      violations.push(...scanFileLines(relPath, content, ALLOWED_READS));
    }

    expect(violations).toEqual([]);
  });

  describe("mutation cases", () => {
    test("a fixture with a bare read fails", () => {
      const fixture = `
        const pass = process.env.FLAIR_ADMIN_PASS;
      `;
      const violations = scanFileLines("commands/custom.ts", fixture, ALLOWED_READS);
      expect(violations.length).toBe(1);
      expect(violations[0].text).toContain("process.env.FLAIR_ADMIN_PASS");
    });

    test("a fixture with a parenthesised (a || b) fails", () => {
      const fixture = `
        const pass = (process.env.HDB_ADMIN_PASSWORD || process.env.FLAIR_ADMIN_PASS);
      `;
      const violations = scanFileLines("commands/custom.ts", fixture, ALLOWED_READS);
      expect(violations.length).toBe(1);
      expect(violations[0].text).toContain("process.env.HDB_ADMIN_PASSWORD");
    });

    test("an envAdminPass() call passes with zero violations", () => {
      const fixture = `
        import { envAdminPass } from "../lib/auth-resolve.js";
        const pass = envAdminPass() || "";
      `;
      const violations = scanFileLines("commands/custom.ts", fixture, ALLOWED_READS);
      expect(violations).toEqual([]);
    });
  });
});
