/**
 * env-admin-pass-no-inline-dual-read.test.ts — Issue #3093.
 *
 * Asserts that ambient admin password reads in src/ use the shared envAdminPass()
 * helper, failing on any read of process.env.FLAIR_ADMIN_PASS or
 * process.env.HDB_ADMIN_PASSWORD outside envAdminPass() itself, with an explicit
 * allowlist of named exceptions.
 *
 * Each exception names the exact expression it allows, how many times it may
 * appear in that file, and a reason describing that one read:
 *   - lib/auth-resolve.ts:
 *       - Definition of the envAdminPass() helper itself (count: 1)
 *       - Diagnostic recording of adminPassEnvVar for FLAIR_ADMIN_PASS (count: 1)
 *       - Diagnostic recording of adminPassEnvVar for HDB_ADMIN_PASSWORD (count: 1)
 *       - Target disambiguation in resolveLocalAdminPass() (count: 1)
 *   - commands/service.ts:
 *       - Direct start: HDB_ADMIN_PASSWORD takes precedence as Harper's bootstrap variable (count: 1)
 *       - Service status: inspects HDB_ADMIN_PASSWORD for server status check (count: 1)
 *   - cli.ts:
 *       - Restart direct start: HDB_ADMIN_PASSWORD takes precedence as Harper's bootstrap variable (count: 1)
 *       - Harness/doctor: diagnostic inspect of HDB_ADMIN_PASSWORD (count: 1)
 *       - Direct spawn health check: reads HDB_ADMIN_PASSWORD (count: 1)
 *       - Direct spawn waitHealthy: reads HDB_ADMIN_PASSWORD (count: 1)
 *   - commands/init.ts:
 *       - Install options read: checks opts.flairAdminPass || FLAIR_ADMIN_PASS (count: 1)
 *       - Init branch condition: checks process.env.FLAIR_ADMIN_PASS (count: 1)
 *       - Init branch assignment: reads process.env.FLAIR_ADMIN_PASS (count: 1)
 *       - Init fallback branch condition: checks process.env.HDB_ADMIN_PASSWORD (count: 1)
 *       - Init fallback branch assignment: reads process.env.HDB_ADMIN_PASSWORD (count: 1)
 *   - Commands intentionally reading only FLAIR_ADMIN_PASS:
 *       - commands/agent.ts: rotate-key (~582) and remove (~672) reads (count: 2)
 *       - commands/federation.ts: show (~851) and teardown (~2708) reads (count: 2),
 *         and resolveFederationAdminPass ambient fallback (~2314) (count: 1)
 *       - commands/rem.ts: cancel (~868) read (count: 1)
 *       - commands/backup-approval.ts: operator credential read (count: 1)
 *       - commands/backup.ts: backup command read (count: 1)
 *       - commands/export.ts: export command read (count: 1)
 *       - commands/grant.ts: add (~55) and revoke (~112) reads (count: 2)
 *       - commands/idp.ts: create (~62), delete (~111), set-default (~164), sync (~190) reads (count: 4)
 *       - commands/import.ts: import command read (count: 1)
 *       - commands/integrity.ts: verify (~359) and repair (~434) reads (count: 2)
 *       - commands/mcp.ts: dryRun read (count: 1)
 *       - commands/principal.ts: create (~125) read (count: 1), rotate-key (~489) and remove (~633) reads (count: 2)
 *       - commands/restore.ts: restore command read (count: 1)
 *       - commands/test.ts: test guard condition check (count: 1)
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC_DIR = resolve(import.meta.dir, "..", "..", "src");

export interface AllowedRead {
  file: string;
  pattern: RegExp;
  count: number;
  reason: string;
}

export const ALLOWED_READS: AllowedRead[] = [
  // 1. Definition site in auth-resolve.ts
  {
    file: "lib/auth-resolve.ts",
    pattern: /return process\.env\.FLAIR_ADMIN_PASS \|\| process\.env\.HDB_ADMIN_PASSWORD \|\| undefined;/,
    count: 1,
    reason: "Definition of the envAdminPass() helper itself",
  },
  // 2. Diagnostic recording of which ambient env var was used
  {
    file: "lib/auth-resolve.ts",
    pattern: /adminPassEnvVar:\s*process\.env\.FLAIR_ADMIN_PASS/,
    count: 1,
    reason: "Diagnostic recording of FLAIR_ADMIN_PASS ambient env var in auth resolution",
  },
  {
    file: "lib/auth-resolve.ts",
    pattern: /:\s*process\.env\.HDB_ADMIN_PASSWORD \? "HDB_ADMIN_PASSWORD" : undefined/,
    count: 1,
    reason: "Diagnostic recording of HDB_ADMIN_PASSWORD ambient env var in auth resolution",
  },
  // 3. Local/remote target disambiguation
  {
    file: "lib/auth-resolve.ts",
    pattern: /if \(process\.env\.FLAIR_ADMIN_PASS\) return process\.env\.FLAIR_ADMIN_PASS;/,
    count: 1,
    reason: "resolveLocalAdminPass target disambiguation intentionally reads only FLAIR_ADMIN_PASS",
  },
  // 4. Two direct-start sites where HDB_ADMIN_PASSWORD takes precedence
  {
    file: "commands/service.ts",
    pattern: /const adminPass = process\.env\.HDB_ADMIN_PASSWORD \|\| process\.env\.FLAIR_ADMIN_PASS \|\| "";/,
    count: 1,
    reason: "Harper direct start: HDB_ADMIN_PASSWORD takes precedence as Harper's bootstrap variable (#3093)",
  },
  {
    file: "cli.ts",
    pattern: /const adminPass = process\.env\.HDB_ADMIN_PASSWORD \|\| process\.env\.FLAIR_ADMIN_PASS \|\| "";/,
    count: 1,
    reason: "Harper restart direct start: HDB_ADMIN_PASSWORD takes precedence as Harper's bootstrap variable (#3093)",
  },
  // 5. Init's separate ordered reads
  {
    file: "commands/init.ts",
    pattern: /let flairAdminPass = opts\.flairAdminPass \|\| process\.env\.FLAIR_ADMIN_PASS;/,
    count: 1,
    reason: "init install options read intentionally checks only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/init.ts",
    pattern: /\} else if \(process\.env\.FLAIR_ADMIN_PASS\) \{/,
    count: 1,
    reason: "init branch condition intentionally checks only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/init.ts",
    pattern: /adminPass = process\.env\.FLAIR_ADMIN_PASS;/,
    count: 1,
    reason: "init branch assignment intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/init.ts",
    pattern: /\} else if \(process\.env\.HDB_ADMIN_PASSWORD\) \{/,
    count: 1,
    reason: "init fallback branch condition intentionally checks only HDB_ADMIN_PASSWORD",
  },
  {
    file: "commands/init.ts",
    pattern: /adminPass = process\.env\.HDB_ADMIN_PASSWORD;/,
    count: 1,
    reason: "init fallback branch assignment intentionally reads only HDB_ADMIN_PASSWORD",
  },
  // 6. Reads that intentionally take only HDB_ADMIN_PASSWORD
  {
    file: "commands/service.ts",
    pattern: /adminPass: process\.env\.HDB_ADMIN_PASSWORD \?\? "",/,
    count: 1,
    reason: "Service status intentionally checks only HDB_ADMIN_PASSWORD",
  },
  {
    file: "cli.ts",
    pattern: /deps\.adminPass \?\? process\.env\.HDB_ADMIN_PASSWORD \?\? "",/,
    count: 1,
    reason: "Harness/doctor intentionally checks only HDB_ADMIN_PASSWORD",
  },
  {
    file: "cli.ts",
    pattern: /adminPass: process\.env\.HDB_ADMIN_PASSWORD \?\? "",/,
    count: 1,
    reason: "Direct spawn health check intentionally checks only HDB_ADMIN_PASSWORD",
  },
  {
    file: "cli.ts",
    pattern: /waitForHealth\(port, DEFAULT_ADMIN_USER, process\.env\.HDB_ADMIN_PASSWORD \?\? "", STARTUP_TIMEOUT_MS\)/,
    count: 1,
    reason: "Direct spawn waitHealthy intentionally checks only HDB_ADMIN_PASSWORD",
  },
  // 7. Commands intentionally taking only FLAIR_ADMIN_PASS
  {
    file: "commands/agent.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 2,
    reason: "agent rotate-key (~582) and agent remove (~672) intentionally read only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/backup-approval.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 1,
    reason: "backup-approval intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/backup.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 1,
    reason: "backup intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/export.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 1,
    reason: "export intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/federation.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 2,
    reason: "federation show (~851) and federation teardown (~2708) intentionally read only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/federation.ts",
    pattern: /const adminPass = resolveFederationAdminPass\(opts, process\.env\.FLAIR_ADMIN_PASS\);/,
    count: 1,
    reason: "resolveFederationAdminPass ambient fallback (~2314) intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/grant.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 2,
    reason: "grant add (~55) and grant revoke (~112) intentionally read only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/idp.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 4,
    reason: "idp create (~62), delete (~111), set-default (~164), and sync (~190) intentionally read only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/import.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 1,
    reason: "import intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/integrity.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 2,
    reason: "integrity verify (~359) and integrity repair (~434) intentionally read only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/mcp.ts",
    pattern: /const adminPass = dryRun \? \(opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? ""\) : resolveLocalAdminPass\(opts\.adminPass, \/\* isRemoteTarget \*\/ true\);/,
    count: 1,
    reason: "mcp dryRun check intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/principal.ts",
    pattern: /adminPass = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS;/,
    count: 1,
    reason: "principal create (~125) intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/principal.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 2,
    reason: "principal rotate-key (~489) and principal remove (~633) intentionally read only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/rem.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 1,
    reason: "rem cancel (~868) intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/restore.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 1,
    reason: "restore intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/test.ts",
    pattern: /if \(!agentId && !process\.env\.FLAIR_ADMIN_PASS\) \{/,
    count: 1,
    reason: "test guard condition (~45) intentionally checks only FLAIR_ADMIN_PASS",
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
): { file: string; line: number; text: string; message?: string }[] {
  const violations: { file: string; line: number; text: string; message?: string }[] = [];
  const lines = content.split("\n");
  const readPattern = /process\.env\.(FLAIR_ADMIN_PASS|HDB_ADMIN_PASSWORD)/;

  const fileEntries = allowlist.filter((entry) => entry.file === relPath);
  const matchCounts = new Map<AllowedRead, number>();
  for (const entry of fileEntries) {
    matchCounts.set(entry, 0);
  }

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (!readPattern.test(lineText)) continue;

    // Check if this line matches an entry in allowlist for this file
    const matchedEntry = fileEntries.find((entry) => entry.pattern.test(lineText));

    if (!matchedEntry) {
      violations.push({
        file: relPath,
        line: i + 1,
        text: lineText.trim(),
        message: `Unexpected ambient read outside allowlist: ${lineText.trim()}`,
      });
    } else {
      const currentCount = matchCounts.get(matchedEntry) || 0;
      matchCounts.set(matchedEntry, currentCount + 1);
      if (currentCount + 1 > matchedEntry.count) {
        violations.push({
          file: relPath,
          line: i + 1,
          text: lineText.trim(),
          message: `Read matched allowlist pattern (${matchedEntry.reason}) but exceeded allowed count of ${matchedEntry.count}`,
        });
      }
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

    test("scanner goes red on an extra bare read in commands/agent.ts", () => {
      const original = readFileSync(join(SRC_DIR, "commands", "agent.ts"), "utf-8");
      // Swapping the helper call at agent list (~452) back to a bare read
      const mutated = original.replace(
        "opts.adminPass || envAdminPass() || \"\"",
        "opts.adminPass || process.env.FLAIR_ADMIN_PASS || \"\""
      );
      expect(mutated).not.toBe(original);
      const violations = scanFileLines("commands/agent.ts", mutated, ALLOWED_READS);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations.some((v) => v.text.includes("process.env.FLAIR_ADMIN_PASS"))).toBe(true);
    });

    test("scanner goes red on an extra bare read in commands/federation.ts", () => {
      const original = readFileSync(join(SRC_DIR, "commands", "federation.ts"), "utf-8");
      // Swapping the helper call at federation pair (~2035) back to a bare read
      const mutated = original.replace(
        "envAdminPass(),",
        "process.env.FLAIR_ADMIN_PASS,"
      );
      expect(mutated).not.toBe(original);
      const violations = scanFileLines("commands/federation.ts", mutated, ALLOWED_READS);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations.some((v) => v.text.includes("process.env.FLAIR_ADMIN_PASS"))).toBe(true);
    });

    test("scanner goes red on an extra bare read in commands/rem.ts", () => {
      const original = readFileSync(join(SRC_DIR, "commands", "rem.ts"), "utf-8");
      // Swapping the helper call at rem nightly (~1298) back to a bare read
      const mutated = original.replace(
        "opts.adminPass || envAdminPass() || \"\"",
        "opts.adminPass || process.env.FLAIR_ADMIN_PASS || \"\""
      );
      expect(mutated).not.toBe(original);
      const violations = scanFileLines("commands/rem.ts", mutated, ALLOWED_READS);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations.some((v) => v.text.includes("process.env.FLAIR_ADMIN_PASS"))).toBe(true);
    });
  });
});
