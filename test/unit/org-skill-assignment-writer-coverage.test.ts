// flair#2141 S1 — the raw writers of OrgSkillAssignment and its history table.
//
// Same posture as soul-writer-coverage.test.ts: every module that holds a raw
// handle to either table has each mutation sink classified here, so a new
// writer (a migration, the S2 seed reconciler) is a reviewed change to this
// list. Today the only writer of both tables is the resource.
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { rawTableWriteSites } from "../helpers/raw-table-writers";
import { FEDERATION_TABLE_POLICY } from "../../resources/federation-classify";

const TABLES = ["OrgSkillAssignment", "OrgSkillAssignmentHistory"] as const;

const RESOURCE = "Resource boundary: post/put/patch/delete each require the operator source; each write appends a history row in its transaction.";
const classified: Record<(typeof TABLES)[number], Map<string, string>> = {
  OrgSkillAssignment: new Map([
    ["resources/OrgSkillAssignment.ts:alias-source:(databases as any).flair.OrgSkillAssignment#1", "The resource class extends the table."],
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
