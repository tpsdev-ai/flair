// flair#2139 S1 — the coverage gate for instruction-version history.
//
// Two tripwires:
//  1. Raw InstructionVersion handles and mutation sinks in resources/**/*.ts are classified,
//     so a NEW writer (a migration, a later slice's reconciler) is a reviewed
//     change to this list, not a silent bypass of the append helper. Same
//     discipline as test/unit/soul-writer-coverage.test.ts.
//  2. Every `recordVersion(` append site is enumerated by file and count.
//     Removing an append (a call in resources/Soul.ts) leaves a classified
//     count with no call site and fails this test — the whole point of the
//     coverage policy: an append cannot disappear unnoticed.
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { rawTableWriteSites } from "../helpers/raw-table-writers";

const classified = new Map<string, string>([
  ["resources/instruction-version-record.ts:alias-source:(databases as any).flair?.InstructionVersion#1", "Head read (readHead) — read-only handle."],
  ["resources/instruction-version-record.ts:alias-source:(databases as any).flair?.InstructionVersion#2", "Subject-type lock store — read-only handle."],
  ["resources/instruction-version-record.ts:alias-source:(databases as any).flair?.InstructionVersion#3", "Raw table handle inside the append transaction."],
  ["resources/instruction-version-record.ts:writer:table.create#1", "Application append: the old subject's tombstone on a subject-identity change."],
  ["resources/instruction-version-record.ts:writer:table.create#2", "Application append for single-row Soul resource writes."],
  ["resources/instruction-version-record.ts:writer:createHash(\"sha256\").update#1", "Hashing, not a table write; listed by the conservative sink scan."],
  ["resources/instruction-version-record.ts:writer:createHash(\"sha256\").update#2", "Hashing, not a table write; listed by the conservative sink scan."],
  ["resources/InstructionVersion.ts:alias-source:(databases as any).flair.InstructionVersion#1", "The resource class extends the table."],
]);

test("raw InstructionVersion handles and mutation sinks in resources/**/*.ts have explicit classifications", () => {
  const sites = [...new Glob("resources/**/*.ts").scanSync(".")].flatMap((file) => rawTableWriteSites(file, readFileSync(file, "utf8"), "InstructionVersion"));
  expect(sites.filter((site) => !classified.has(site.key)).map((site) => site.key)).toEqual([]);
  expect([...classified.keys()].filter((key) => !sites.some((site) => site.key === key))).toEqual([]);
});

test("a new direct, aliased or computed writer fails classification", () => {
  for (const source of [
    "databases.flair.InstructionVersion.put(row)",
    "databases.flair.InstructionVersion.create(row)",
    "const t = databases.flair.InstructionVersion; t.delete(id)",
    'const db = databases.flair; db["InstructionVersion"].patch(row)',
  ]) {
    const sites = rawTableWriteSites("resources/NewWriter.ts", source, "InstructionVersion");
    expect(sites.some((site) => site.kind === "writer" && !classified.has(site.key)), source).toBe(true);
  }
});

// The append enumeration. resources/Soul.ts wires recordVersion into post(),
// put(), patch() and delete(); resources/skill-version-write.ts wires it into
// the skill create/update/delete path; instruction-version-record.ts is the one
// declaration. Removing any one of those calls changes this map and fails.
const EXPECTED_APPEND_SITES: Record<string, number> = {
  "resources/instruction-version-record.ts": 1,
  "resources/Soul.ts": 4,
  "resources/skill-version-write.ts": 1,
};

test("every recordVersion append site is enumerated; removing one fails this test", () => {
  const found: Record<string, number> = {};
  for (const file of new Glob("resources/**/*.ts").scanSync(".")) {
    const count = (readFileSync(file, "utf8").match(/recordVersion\(/g) ?? []).length;
    if (count > 0) found[file] = count;
  }
  expect(found).toEqual(EXPECTED_APPEND_SITES);
});
