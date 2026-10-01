// flair#2141 S1 — the raw writers of OrgSkillAssignment and its history table.
//
// Same posture as soul-writer-coverage.test.ts: each TypeScript module under
// resources/ and src/ that holds a raw handle to either table has its mutation
// sinks classified here, so a new writer there (a migration, the S2 seed
// reconciler) is a reviewed change to this list. Today the only writer found
// there is the resource.
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { rawTableWriteSites } from "../helpers/raw-table-writers";
import { FEDERATION_TABLE_POLICY } from "../../resources/federation-classify";

const TABLES = ["OrgSkillAssignment", "OrgSkillAssignmentHistory"] as const;

const RESOURCE = "Resource boundary: post/put/patch/delete each require the operator source; each write appends a history row in its transaction.";
const classified: Record<(typeof TABLES)[number], Map<string, string>> = {
  OrgSkillAssignment: new Map([
    ["resources/OrgSkillAssignment.ts:alias-source:(databases as any).flair.OrgSkillAssignment#1", "The per-assignment lock reads the table's primary store for tryLock/unlock/resetReadTxn only."],
    ["resources/OrgSkillAssignment.ts:alias-source:(databases as any).flair.OrgSkillAssignment#2", "The resource class extends the table."],
    ["resources/OrgSkillAssignment.ts:writer:super.post#1", RESOURCE],
    ["resources/OrgSkillAssignment.ts:writer:super.put#1", RESOURCE],
    ["resources/OrgSkillAssignment.ts:writer:super.patch#1", RESOURCE],
    ["resources/OrgSkillAssignment.ts:writer:super.delete#1", RESOURCE],
    ["resources/OrgSkillAssignment.ts:writer:(databases as any).flair.OrgSkillAssignmentHistory.put#1", RESOURCE],
    ["resources/OrgSkillAssignment.ts:writer:createHash(\"sha256\").update#1", "Hashing, not a table write; listed by the conservative sink scan."],
  ]),
  OrgSkillAssignmentHistory: new Map([
    ["resources/OrgSkillAssignment.ts:writer:(databases as any).flair.OrgSkillAssignmentHistory.put#1", "The only history writer: one appended row per assignment write."],
    ["resources/OrgSkillAssignment.ts:writer:super.post#1", RESOURCE],
    ["resources/OrgSkillAssignment.ts:writer:super.put#1", RESOURCE],
    ["resources/OrgSkillAssignment.ts:writer:super.patch#1", RESOURCE],
    ["resources/OrgSkillAssignment.ts:writer:super.delete#1", RESOURCE],
    ["resources/OrgSkillAssignment.ts:writer:createHash(\"sha256\").update#1", "Hashing, not a table write; listed by the conservative sink scan."],
  ]),
};

const files = [...new Glob("{resources,src}/**/*.ts").scanSync(".")];

for (const table of TABLES) {
  test(`every raw ${table} handle and mutation sink has an explicit classification`, () => {
    const sites = files.flatMap((file) => rawTableWriteSites(file, readFileSync(file, "utf8"), table));
    expect(sites.filter((site) => !classified[table].has(site.key)).map((site) => site.key)).toEqual([]);
    expect([...classified[table].keys()].filter((key) => !sites.some((site) => site.key === key))).toEqual([]);
  });
}

test("a new direct, aliased or computed writer of either table fails classification", () => {
  for (const table of TABLES) {
    for (const source of [
      `databases.flair.${table}.put(row)`,
      `const t = databases.flair.${table}; t.delete(id)`,
      `const db = databases.flair; db["${table}"].patch(row)`,
    ]) {
      const sites = rawTableWriteSites("resources/NewWriter.ts", source, table);
      expect(sites.some((site) => site.kind === "writer" && !classified[table].has(site.key)), source).toBe(true);
    }
  }
});

test("neither table is in the federation table policy", () => {
  const federated = Object.keys(FEDERATION_TABLE_POLICY);
  expect(federated).toContain("Soul");
  for (const table of TABLES) expect(federated).not.toContain(table);
});

test("put, patch and delete read the stored row and write inside the assignment lock and an owned transaction", () => {
  const src = readFileSync("resources/OrgSkillAssignment.ts", "utf8");
  for (const method of ["put", "patch", "delete"]) {
    const start = src.indexOf(`  async ${method}(`);
    expect(start, `${method}() not found`).toBeGreaterThan(-1);
    const next = src.indexOf("\n  async ", start + 1);
    const body = src.slice(start, next === -1 ? undefined : next);
    const scope = body.indexOf("withAssignmentLock(id, () => withOwnedTransaction(");
    expect(scope, `${method}() does not open the lock and an owned transaction`).toBeGreaterThan(-1);
    expect(body.indexOf("resolveStoredRow("), `${method}() reads the stored row outside the lock`).toBeGreaterThan(scope);
    expect(body.indexOf("appendHistory("), `${method}() appends history outside the lock`).toBeGreaterThan(scope);
  }
});
