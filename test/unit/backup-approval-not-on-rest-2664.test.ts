/**
 * backup-approval-not-on-rest-2664.test.ts — flair#2664 slice 1c: no REST
 * route can approve, revoke, list or read the local approval store.
 *
 * Harper's REST surface is the classes the server build exports
 * (config.yaml `jsResource: dist/resources/*.js`, compiled by tsconfig.json
 * from resources/**) and the tables in schemas/*.graphql. The store is plain
 * files reached only through src/lib/backup-approval-store.ts, which only
 * the CLI imports. This inventory checks:
 *   1. the server build's module closure (every file the TypeScript program
 *      for tsconfig.json loads, followed through imports) contains neither
 *      the store module nor the backup-approval command; a positive control
 *      proves the closure follows resources/ into src/;
 *   2. no resource source, schema or config.yaml line names the store, its
 *      directory or the command;
 *   3. no schema declares an approval type.
 * Slice 2's server writer will read approved bytes; it must narrow this test
 * to read-only access by that one resource, never approve, revoke or list.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const root = realpathSync(join(import.meta.dir, "..", ".."));
const STORE_MODULE = join(root, "src", "lib", "backup-approval-store.ts");
const COMMAND_MODULE = join(root, "src", "commands", "backup-approval.ts");
const NAMES = ["approved-archives", "backup-approval", "APPROVAL_STORE_DIRNAME", "loadApprovedArchive", "approveArchive"];

function serverProgramFiles(): string[] {
  const configPath = join(root, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
  return program.getSourceFiles().map((file) => realpathSync(file.fileName)).filter((file) => !file.includes(`${join("node_modules")}`));
}

describe("the approval store is not reachable through the server's REST surface (#2664)", () => {
  const files = serverProgramFiles();

  test("the server build's module closure follows resources/ into src/ (positive control)", () => {
    const rel = files.map((file) => relative(root, file));
    expect(rel).toContain(join("resources", "Memory.ts"));
    expect(rel).toContain(join("src", "rem", "promote-policy.ts"));
    expect(rel.filter((file) => file.startsWith(`resources${"/"}`)).length).toBeGreaterThan(50);
  });

  test("the server build's module closure contains neither the store nor the backup-approval command", () => {
    expect(files).not.toContain(STORE_MODULE);
    expect(files).not.toContain(COMMAND_MODULE);
    expect(files.filter((file) => /backup-approval/.test(file))).toEqual([]);
  });

  test("no resource source, schema or config.yaml names the store or the command", () => {
    const hits: string[] = [];
    const scanned = [
      ...new Bun.Glob("resources/**/*.ts").scanSync({ cwd: root }),
      ...new Bun.Glob("schemas/*.graphql").scanSync({ cwd: root }),
      "config.yaml",
    ];
    expect(scanned.length).toBeGreaterThan(50);
    for (const file of scanned) {
      const text = readFileSync(join(root, file), "utf8");
      for (const name of NAMES) if (text.includes(name)) hits.push(`${file}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  test("no schema declares an approval table or type", () => {
    const declared: string[] = [];
    for (const file of new Bun.Glob("schemas/*.graphql").scanSync({ cwd: root })) {
      for (const match of readFileSync(join(root, file), "utf8").matchAll(/\b(?:type|input|interface)\s+(\w+)/g)) {
        if (/approv/i.test(match[1]!)) declared.push(`${file}: ${match[1]}`);
      }
    }
    expect(declared).toEqual([]);
  });
});
