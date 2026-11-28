/**
 * env-admin-pass-no-inline-dual-read.test.ts — Issue #3093.
 *
 * Asserts that ambient admin password reads in src/ use the shared envAdminPass()
 * helper, walking the TypeScript AST of each file and counting property access
 * and string-literal element access on process.env naming either variable
 * (FLAIR_ADMIN_PASS or HDB_ADMIN_PASSWORD), through parentheses and type
 * assertions (as, satisfies, <Type>, !).
 *
 * Other forms (destructuring process.env, an alias such as const env = process.env,
 * or a computed key that is not a literal) are not counted.
 *
 * The scanner pins how many ambient reads each file has and requires each AST
 * read to be authorized by an allowlist entry matching its AST construct; comments
 * never authorize a read. It requires the total AST reads in each file to equal
 * the sum of that file's allowed read counts, and each allowlist entry to authorize
 * exactly its expected number of AST reads.
 *
 * Each exception names the exact expression it allows, how many times it may
 * appear in that file, how many AST reads it accounts for, and its rationale:
 *   - lib/auth-resolve.ts:
 *       - Definition of the envAdminPass() helper itself (count: 1, reads: 2)
 *       - Diagnostic recording of adminPassEnvVar for FLAIR_ADMIN_PASS (count: 1, reads: 1)
 *       - Diagnostic recording of adminPassEnvVar for HDB_ADMIN_PASSWORD (count: 1, reads: 1)
 *       - Target disambiguation in resolveLocalAdminPass() (count: 1, reads: 2)
 *   - commands/service.ts:
 *       - Direct start: HDB_ADMIN_PASSWORD takes precedence as Harper's bootstrap variable (count: 1, reads: 2)
 *       - Service status: inspects HDB_ADMIN_PASSWORD for server status check (count: 1, reads: 1)
 *   - cli.ts:
 *       - Restart direct start: HDB_ADMIN_PASSWORD takes precedence as Harper's bootstrap variable (count: 1, reads: 2)
 *       - Harness/doctor: diagnostic inspect of HDB_ADMIN_PASSWORD (count: 1, reads: 1)
 *       - Direct spawn health check: reads HDB_ADMIN_PASSWORD (count: 1, reads: 1)
 *       - Direct spawn waitHealthy: reads HDB_ADMIN_PASSWORD (count: 1, reads: 1)
 *   - commands/init.ts:
 *       - Install options read: checks opts.flairAdminPass || FLAIR_ADMIN_PASS (count: 1, reads: 1)
 *       - Init branch condition: checks process.env.FLAIR_ADMIN_PASS (count: 1, reads: 1)
 *       - Init branch assignment: reads process.env.FLAIR_ADMIN_PASS (count: 1, reads: 1)
 *       - Init fallback branch condition: checks process.env.HDB_ADMIN_PASSWORD (count: 1, reads: 1)
 *       - Init fallback branch assignment: reads process.env.HDB_ADMIN_PASSWORD (count: 1, reads: 1)
 *   - Commands intentionally reading only FLAIR_ADMIN_PASS:
 *       - commands/agent.ts: rotate-key (~582) and remove (~672) reads (count: 2, reads: 2)
 *       - commands/federation.ts: show (~851) and teardown (~2708) reads (count: 2, reads: 2),
 *         and resolveFederationAdminPass ambient fallback (~2314) (count: 1, reads: 1)
 *       - commands/rem.ts: cancel (~868) read (count: 1, reads: 1)
 *       - commands/backup-approval.ts: operator credential read (count: 1, reads: 1)
 *       - commands/backup.ts: backup command read (count: 1, reads: 1)
 *       - commands/export.ts: export command read (count: 1, reads: 1)
 *       - commands/grant.ts: add (~55) and revoke (~112) reads (count: 2, reads: 2)
 *       - commands/idp.ts: create (~62), delete (~111), set-default (~164), sync (~190) reads (count: 4, reads: 4)
 *       - commands/import.ts: import command read (count: 1, reads: 1)
 *       - commands/integrity.ts: verify (~359) and repair (~434) reads (count: 2, reads: 2)
 *       - commands/mcp.ts: dryRun read (count: 1, reads: 1)
 *       - commands/principal.ts: create (~125) read (count: 1, reads: 1), rotate-key (~489) and remove (~633) reads (count: 2, reads: 2)
 *       - commands/restore.ts: restore command read (count: 1, reads: 1)
 *       - commands/test.ts: test guard condition check (count: 1, reads: 1)
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const SRC_DIR = resolve(import.meta.dir, "..", "..", "src");

export interface AllowedRead {
  file: string;
  pattern: RegExp;
  count: number;
  reads?: number;
  reason: string;
}

export const ALLOWED_READS: AllowedRead[] = [
  // 1. Definition site in auth-resolve.ts
  {
    file: "lib/auth-resolve.ts",
    pattern: /return process\.env\.FLAIR_ADMIN_PASS \|\| process\.env\.HDB_ADMIN_PASSWORD \|\| undefined;/,
    count: 1,
    reads: 2,
    reason: "Definition of the envAdminPass() helper itself",
  },
  // 2. Diagnostic recording of which ambient env var was used
  {
    file: "lib/auth-resolve.ts",
    pattern: /adminPassEnvVar:\s*process\.env\.FLAIR_ADMIN_PASS/,
    count: 1,
    reads: 1,
    reason: "Diagnostic recording of FLAIR_ADMIN_PASS ambient env var in auth resolution",
  },
  {
    file: "lib/auth-resolve.ts",
    pattern: /process\.env\.HDB_ADMIN_PASSWORD \? "HDB_ADMIN_PASSWORD" : undefined/,
    count: 1,
    reads: 1,
    reason: "Diagnostic recording of HDB_ADMIN_PASSWORD ambient env var in auth resolution",
  },
  // 3. Local/remote target disambiguation
  {
    file: "lib/auth-resolve.ts",
    pattern: /if \(process\.env\.FLAIR_ADMIN_PASS\) return process\.env\.FLAIR_ADMIN_PASS;/,
    count: 1,
    reads: 2,
    reason: "resolveLocalAdminPass target disambiguation intentionally reads only FLAIR_ADMIN_PASS",
  },
  // 4. Two direct-start sites where HDB_ADMIN_PASSWORD takes precedence
  {
    file: "commands/service.ts",
    pattern: /const adminPass = process\.env\.HDB_ADMIN_PASSWORD \|\| process\.env\.FLAIR_ADMIN_PASS \|\| "";/,
    count: 1,
    reads: 2,
    reason: "Harper direct start: HDB_ADMIN_PASSWORD takes precedence as Harper's bootstrap variable (#3093)",
  },
  {
    file: "cli.ts",
    pattern: /const adminPass = process\.env\.HDB_ADMIN_PASSWORD \|\| process\.env\.FLAIR_ADMIN_PASS \|\| "";/,
    count: 1,
    reads: 2,
    reason: "Harper restart direct start: HDB_ADMIN_PASSWORD takes precedence as Harper's bootstrap variable (#3093)",
  },
  // 5. Init's separate ordered reads
  {
    file: "commands/init.ts",
    pattern: /let flairAdminPass = opts\.flairAdminPass \|\| process\.env\.FLAIR_ADMIN_PASS;/,
    count: 1,
    reads: 1,
    reason: "init install options read intentionally checks only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/init.ts",
    pattern: /if \(process\.env\.FLAIR_ADMIN_PASS\)/,
    count: 1,
    reads: 1,
    reason: "init branch condition intentionally checks only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/init.ts",
    pattern: /adminPass = process\.env\.FLAIR_ADMIN_PASS;/,
    count: 1,
    reads: 1,
    reason: "init branch assignment intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/init.ts",
    pattern: /if \(process\.env\.HDB_ADMIN_PASSWORD\)/,
    count: 1,
    reads: 1,
    reason: "init fallback branch condition intentionally checks only HDB_ADMIN_PASSWORD",
  },
  {
    file: "commands/init.ts",
    pattern: /adminPass = process\.env\.HDB_ADMIN_PASSWORD;/,
    count: 1,
    reads: 1,
    reason: "init fallback branch assignment intentionally reads only HDB_ADMIN_PASSWORD",
  },
  // 6. Reads that intentionally take only HDB_ADMIN_PASSWORD
  {
    file: "commands/service.ts",
    pattern: /adminPass: process\.env\.HDB_ADMIN_PASSWORD \?\? "",/,
    count: 1,
    reads: 1,
    reason: "Service status intentionally checks only HDB_ADMIN_PASSWORD",
  },
  {
    file: "cli.ts",
    pattern: /deps\.adminPass \?\? process\.env\.HDB_ADMIN_PASSWORD \?\? "",/,
    count: 1,
    reads: 1,
    reason: "Harness/doctor intentionally checks only HDB_ADMIN_PASSWORD",
  },
  {
    file: "cli.ts",
    pattern: /adminPass: process\.env\.HDB_ADMIN_PASSWORD \?\? "",/,
    count: 1,
    reads: 1,
    reason: "Direct spawn health check intentionally checks only HDB_ADMIN_PASSWORD",
  },
  {
    file: "cli.ts",
    pattern: /waitForHealth\(port, DEFAULT_ADMIN_USER, process\.env\.HDB_ADMIN_PASSWORD \?\? "", STARTUP_TIMEOUT_MS\)/,
    count: 1,
    reads: 1,
    reason: "Direct spawn waitHealthy intentionally checks only HDB_ADMIN_PASSWORD",
  },
  // 7. Commands intentionally taking only FLAIR_ADMIN_PASS
  {
    file: "commands/agent.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 2,
    reads: 2,
    reason: "agent rotate-key (~582) and agent remove (~672) intentionally read only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/backup-approval.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 1,
    reads: 1,
    reason: "backup-approval intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/backup.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 1,
    reads: 1,
    reason: "backup intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/export.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 1,
    reads: 1,
    reason: "export intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/federation.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 2,
    reads: 2,
    reason: "federation show (~851) and federation teardown (~2708) intentionally read only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/federation.ts",
    pattern: /const adminPass = resolveFederationAdminPass\(opts, process\.env\.FLAIR_ADMIN_PASS\);/,
    count: 1,
    reads: 1,
    reason: "resolveFederationAdminPass ambient fallback (~2314) intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/grant.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 2,
    reads: 2,
    reason: "grant add (~55) and grant revoke (~112) intentionally read only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/idp.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 4,
    reads: 4,
    reason: "idp create (~62), delete (~111), set-default (~164), and sync (~190) intentionally read only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/import.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 1,
    reads: 1,
    reason: "import intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/integrity.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 2,
    reads: 2,
    reason: "integrity verify (~359) and integrity repair (~434) intentionally read only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/mcp.ts",
    pattern: /const adminPass = dryRun \? \(opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? ""\) : resolveLocalAdminPass\(opts\.adminPass, \/\* isRemoteTarget \*\/ true\);/,
    count: 1,
    reads: 1,
    reason: "mcp dryRun check intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/principal.ts",
    pattern: /adminPass = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS;/,
    count: 1,
    reads: 1,
    reason: "principal create (~125) intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/principal.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 2,
    reads: 2,
    reason: "principal rotate-key (~489) and principal remove (~633) intentionally read only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/rem.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 1,
    reads: 1,
    reason: "rem cancel (~868) intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/restore.ts",
    pattern: /const adminPass: string = opts\.adminPass \?\? process\.env\.FLAIR_ADMIN_PASS \?\? "";/,
    count: 1,
    reads: 1,
    reason: "restore intentionally reads only FLAIR_ADMIN_PASS",
  },
  {
    file: "commands/test.ts",
    pattern: /if \(!agentId && !process\.env\.FLAIR_ADMIN_PASS\) \{/,
    count: 1,
    reads: 1,
    reason: "test guard condition (~45) intentionally checks only FLAIR_ADMIN_PASS",
  },
];

function unwrapExpression(node: ts.Expression): ts.Expression {
  let curr: ts.Expression = node;
  while (true) {
    if (ts.isParenthesizedExpression(curr)) {
      curr = curr.expression;
    } else if (ts.isAsExpression(curr)) {
      curr = curr.expression;
    } else if (ts.isTypeAssertionExpression(curr)) {
      curr = curr.expression;
    } else if (ts.isNonNullExpression(curr)) {
      curr = curr.expression;
    } else if (ts.isSatisfiesExpression && ts.isSatisfiesExpression(curr)) {
      curr = curr.expression;
    } else {
      break;
    }
  }
  return curr;
}

function isProcessEnv(node: ts.Expression): boolean {
  const unwrapped = unwrapExpression(node);
  if (!ts.isPropertyAccessExpression(unwrapped)) return false;
  const innerReceiver = unwrapExpression(unwrapped.expression);
  return (
    ts.isIdentifier(innerReceiver) &&
    innerReceiver.text === "process" &&
    unwrapped.name.text === "env"
  );
}

export interface AmbientReadAst {
  node: ts.Node;
  variable: string;
  line: number;
  character: number;
  text: string;
}

export function findAmbientReadsInAst(sourceFile: ts.SourceFile): AmbientReadAst[] {
  const reads: AmbientReadAst[] = [];

  function visit(node: ts.Node) {
    if (ts.isPropertyAccessExpression(node)) {
      if (isProcessEnv(node.expression)) {
        const prop = node.name.text;
        if (prop === "FLAIR_ADMIN_PASS" || prop === "HDB_ADMIN_PASSWORD") {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          reads.push({
            node,
            variable: prop,
            line: line + 1,
            character: character + 1,
            text: node.getText(sourceFile),
          });
        }
      }
    } else if (ts.isElementAccessExpression(node)) {
      if (isProcessEnv(node.expression)) {
        let arg: string | null = null;
        const argExpr = node.argumentExpression ? unwrapExpression(node.argumentExpression) : null;
        if (argExpr && (ts.isStringLiteral(argExpr) || ts.isNoSubstitutionTemplateLiteral(argExpr))) {
          arg = argExpr.text;
        }
        if (arg === "FLAIR_ADMIN_PASS" || arg === "HDB_ADMIN_PASSWORD") {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          reads.push({
            node,
            variable: arg,
            line: line + 1,
            character: character + 1,
            text: node.getText(sourceFile),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return reads;
}

function matchesAstRead(read: AmbientReadAst, entry: AllowedRead, sf: ts.SourceFile): boolean {
  if (!entry.pattern.source.includes(read.variable)) {
    return false;
  }
  let curr: ts.Node | undefined = read.node;
  while (curr && !ts.isSourceFile(curr)) {
    if (
      ts.isBlock(curr) ||
      ts.isFunctionDeclaration(curr) ||
      ts.isMethodDeclaration(curr) ||
      ts.isFunctionExpression(curr) ||
      ts.isArrowFunction(curr)
    ) {
      break;
    }
    const text = curr.getText(sf);
    if (entry.pattern.test(text)) {
      return true;
    }
    curr = curr.parent;
  }
  return false;
}

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
  const fileEntries = allowlist.filter((entry) => entry.file === relPath);

  // Quick exit if file has neither ambient reads nor allowlist entries
  const containsKeywords = content.includes("FLAIR_ADMIN_PASS") || content.includes("HDB_ADMIN_PASSWORD");
  if (!containsKeywords && fileEntries.length === 0) {
    return [];
  }

  // 1. Walk AST to find property access and string-literal element access on process.env
  // naming either variable, through parentheses and type assertions. Other forms (destructuring,
  // aliases, computed non-literal keys) are not counted.
  const sf = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true);
  const astReads = findAmbientReadsInAst(sf);
  const totalActualReads = astReads.length;
  const totalAllowedReads = fileEntries.reduce(
    (sum, entry) => sum + (entry.reads ?? entry.count),
    0
  );

  if (totalActualReads !== totalAllowedReads) {
    violations.push({
      file: relPath,
      line: 0,
      text: `total ambient reads in AST: ${totalActualReads}`,
      message: `${relPath} has ${totalActualReads} ambient read(s) in syntax tree; expected exactly ${totalAllowedReads}.`,
    });
  }

  // 2. Authorize AST reads via allowlist entries. Exceptions authorize AST reads,
  // not source text; comments never authorize an AST read.
  const readsAuthorizedPerEntry = new Map<AllowedRead, number>();
  for (const entry of fileEntries) {
    readsAuthorizedPerEntry.set(entry, 0);
  }

  for (const read of astReads) {
    const matchedEntry = fileEntries.find((entry) => matchesAstRead(read, entry, sf));
    if (!matchedEntry) {
      violations.push({
        file: relPath,
        line: read.line,
        text: read.text,
        message: `Unexpected ambient read outside allowlist at line ${read.line}: ${read.text}`,
      });
    } else {
      readsAuthorizedPerEntry.set(
        matchedEntry,
        (readsAuthorizedPerEntry.get(matchedEntry) ?? 0) + 1
      );
    }
  }

  // 3. Verify each allowlist entry authorizes its exact expected AST read count.
  for (const entry of fileEntries) {
    const actualReads = readsAuthorizedPerEntry.get(entry) ?? 0;
    const expectedReads = entry.reads ?? entry.count;
    if (actualReads !== expectedReads) {
      violations.push({
        file: relPath,
        line: 0,
        text: entry.pattern.source,
        message: `Allowed expression (${entry.reason}) authorized ${actualReads} read(s) in AST; expected exactly ${expectedReads}.`,
      });
    }
  }

  return violations;
}

describe("source scanner: envAdminPass allowlist (#3093)", () => {
  test("pins AST property access and string-literal element access on process.env through parentheses and type assertions", () => {
    const tsFiles = walkTsFiles(SRC_DIR);
    const violations: { file: string; line: number; text: string }[] = [];

    for (const file of tsFiles) {
      const relPath = relative(SRC_DIR, file).replace(/\\/g, "/");
      const content = readFileSync(file, "utf-8");
      violations.push(...scanFileLines(relPath, content, ALLOWED_READS));
    }

    expect(violations).toEqual([]);
  }, 20000);

  describe("mutation cases", () => {
    test("a fixture with a bare read fails", () => {
      const fixture = `
        const pass = process.env.FLAIR_ADMIN_PASS;
      `;
      const violations = scanFileLines("commands/custom.ts", fixture, ALLOWED_READS);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations.some((v) => v.text.includes("process.env.FLAIR_ADMIN_PASS"))).toBe(true);
    });

    test("a fixture with a parenthesised (a || b) fails", () => {
      const fixture = `
        const pass = (process.env.HDB_ADMIN_PASSWORD || process.env.FLAIR_ADMIN_PASS);
      `;
      const violations = scanFileLines("commands/custom.ts", fixture, ALLOWED_READS);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations.some((v) => v.text.includes("process.env.HDB_ADMIN_PASSWORD"))).toBe(true);
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

    test("scanner goes red on an extra read on an allowed line", () => {
      const original = readFileSync(join(SRC_DIR, "commands", "agent.ts"), "utf-8");
      const target = 'const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";';
      // Adding a second bare read to a line that already holds an allowed expression
      const mutated = original.replace(
        target,
        `${target} const extra = process.env.FLAIR_ADMIN_PASS;`
      );
      expect(mutated).not.toBe(original);
      const violations = scanFileLines("commands/agent.ts", mutated, ALLOWED_READS);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations.some((v) => v.message?.includes("expected exactly"))).toBe(true);
    });

    test("scanner goes red on a missing allowed occurrence", () => {
      const original = readFileSync(join(SRC_DIR, "commands", "agent.ts"), "utf-8");
      const target = 'const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";';
      // Removing one of the two allowed occurrences
      const mutated = original.replace(
        target,
        'const adminPass: string = opts.adminPass ?? "";'
      );
      expect(mutated).not.toBe(original);
      const violations = scanFileLines("commands/agent.ts", mutated, ALLOWED_READS);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations.some((v) => v.message?.includes("expected exactly"))).toBe(true);
    });

    test("scanner goes red on an element access read with string literal: process.env[\"FLAIR_ADMIN_PASS\"]", () => {
      const original = readFileSync(join(SRC_DIR, "commands", "agent.ts"), "utf-8");
      // Baseline check: original file passes cleanly
      expect(scanFileLines("commands/agent.ts", original, ALLOWED_READS)).toEqual([]);

      // Red mutation: swapping property access to element access
      const target = 'const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";';
      const mutated = original.replace(
        target,
        'const adminPass: string = opts.adminPass ?? process.env["FLAIR_ADMIN_PASS"] ?? "";'
      );
      expect(mutated).not.toBe(original);
      const violations = scanFileLines("commands/agent.ts", mutated, ALLOWED_READS);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations.some((v) => v.message?.includes("Unexpected ambient read"))).toBe(true);
    });

    test("scanner goes red on a split-line property access: process.env.\\nFLAIR_ADMIN_PASS", () => {
      const original = readFileSync(join(SRC_DIR, "commands", "agent.ts"), "utf-8");
      // Baseline check: original file passes cleanly
      expect(scanFileLines("commands/agent.ts", original, ALLOWED_READS)).toEqual([]);

      // Red mutation: splitting process.env. and property name across lines
      const target = 'const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";';
      const mutated = original.replace(
        target,
        'const adminPass: string = opts.adminPass ?? process.env.\n        FLAIR_ADMIN_PASS ?? "";'
      );
      expect(mutated).not.toBe(original);
      const violations = scanFileLines("commands/agent.ts", mutated, ALLOWED_READS);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations.some((v) => v.message?.includes("Unexpected ambient read") || v.message?.includes("occurred 1 time(s)") || v.message?.includes("authorized"))).toBe(true);
    });

    test("scanner goes red on parenthesized receiver: (process.env).FLAIR_ADMIN_PASS", () => {
      const original = readFileSync(join(SRC_DIR, "commands", "agent.ts"), "utf-8");
      expect(scanFileLines("commands/agent.ts", original, ALLOWED_READS)).toEqual([]);

      const mutated = original.replace(
        "opts.adminPass || envAdminPass() || \"\"",
        "opts.adminPass || (process.env).FLAIR_ADMIN_PASS || \"\""
      );
      expect(mutated).not.toBe(original);
      const violations = scanFileLines("commands/agent.ts", mutated, ALLOWED_READS);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations.some((v) => v.text.includes("(process.env).FLAIR_ADMIN_PASS"))).toBe(true);
    });

    test("scanner goes red on type-asserted receiver with bracket access: (process.env as NodeJS.ProcessEnv)[\"HDB_ADMIN_PASSWORD\"]", () => {
      const original = readFileSync(join(SRC_DIR, "commands", "agent.ts"), "utf-8");
      expect(scanFileLines("commands/agent.ts", original, ALLOWED_READS)).toEqual([]);

      const mutated = original.replace(
        "opts.adminPass || envAdminPass() || \"\"",
        'opts.adminPass || (process.env as NodeJS.ProcessEnv)["HDB_ADMIN_PASSWORD"] || ""'
      );
      expect(mutated).not.toBe(original);
      const violations = scanFileLines("commands/agent.ts", mutated, ALLOWED_READS);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations.some((v) => v.text.includes("HDB_ADMIN_PASSWORD"))).toBe(true);
    });

    test("replacing an allowed read with bracket access and putting old expression in same-line comment fails", () => {
      const original = readFileSync(join(SRC_DIR, "commands", "agent.ts"), "utf-8");
      expect(scanFileLines("commands/agent.ts", original, ALLOWED_READS)).toEqual([]);

      const target = 'const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";';
      const mutated = original.replace(
        target,
        'const adminPass: string = opts.adminPass ?? process.env["FLAIR_ADMIN_PASS"] ?? ""; // const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";'
      );
      expect(mutated).not.toBe(original);
      const violations = scanFileLines("commands/agent.ts", mutated, ALLOWED_READS);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations.some((v) => v.message?.includes("Unexpected ambient read") || v.message?.includes("authorized"))).toBe(true);
    });
  });
});


