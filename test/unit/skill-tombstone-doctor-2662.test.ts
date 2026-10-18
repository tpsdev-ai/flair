/**
 * skill-tombstone-doctor-2662.test.ts — the pure decision and read-failure
 * paths of the `flair doctor` skill-tombstone check (flair#2662).
 */
import { describe, expect, it } from "bun:test";
import {
  describeLiveSkillTombstones,
  findLiveSkillTombstones,
  readSkillTombstoneTables,
} from "../../src/lib/skill-tombstone-doctor.js";

const deleteVersion = {
  id: "skill:skill-a:2",
  subjectType: "skill",
  subjectId: "skill-a",
  version: 2,
  kind: "delete",
  rowId: "row-a",
};

describe("findLiveSkillTombstones", () => {
  it("passes a clean store", () => {
    expect(findLiveSkillTombstones([
      { id: "skill:skill-a:1", subjectType: "skill", subjectId: "skill-a", version: 1, kind: "create", rowId: "row-a" },
    ], [{ id: "row-a", skillSubjectId: "skill-a", validTo: null }])).toEqual([]);
    expect(describeLiveSkillTombstones([], [])).toBeNull();
  });

  it("names a delete tombstone whose Memory row is still live", () => {
    expect(describeLiveSkillTombstones([deleteVersion], [
      { id: "row-a", skillSubjectId: "skill-a", validTo: null },
    ])).toBe("1 skill subject whose newest InstructionVersion is a delete tombstone still has a live Memory row: skill-a (tombstone skill:skill-a:2, live row row-a)");
  });

  it("passes a closed or absent Memory row", () => {
    expect(findLiveSkillTombstones([deleteVersion], [
      { id: "row-a", skillSubjectId: "skill-a", validTo: "2026-10-18T00:00:00.000Z" },
    ])).toEqual([]);
    expect(findLiveSkillTombstones([deleteVersion], [])).toEqual([]);
    expect(findLiveSkillTombstones([deleteVersion], [
      { id: "row-a", skillSubjectId: "skill-a", validTo: "" },
    ])).toHaveLength(1);
  });

  it("uses the newest version per subject, not any delete row", () => {
    expect(findLiveSkillTombstones([
      deleteVersion,
      { id: "skill:skill-a:3", subjectType: "skill", subjectId: "skill-a", version: 3, kind: "create", rowId: "row-b" },
    ], [{ id: "row-a", skillSubjectId: "skill-a", validTo: null }])).toEqual([]);
    expect(findLiveSkillTombstones([
      { id: "skill:skill-a:1", subjectType: "skill", subjectId: "skill-a", version: "1", kind: "create", rowId: "row-a" },
      { ...deleteVersion, version: "2" },
    ], [{ id: "row-a", skillSubjectId: "skill-a", validTo: null }])).toHaveLength(1);
  });

  it("ignores non-skill and malformed version rows", () => {
    expect(findLiveSkillTombstones([
      { ...deleteVersion, subjectType: "soul" },
      { ...deleteVersion, subjectId: "" },
      { ...deleteVersion, version: null },
      { ...deleteVersion, version: 1.5 },
    ], [{ id: "row-a", skillSubjectId: "skill-a", validTo: null }])).toEqual([]);
  });

  it("finds the live row by rowId even when skillSubjectId is absent", () => {
    expect(findLiveSkillTombstones([deleteVersion], [
      { id: "row-a", validTo: null },
    ])).toEqual([{ subjectId: "skill-a", tombstoneId: "skill:skill-a:2", liveRowId: "row-a" }]);
  });

  it("lists every subject when more than ten are live", () => {
    const versions = Array.from({ length: 12 }, (_, i) => ({
      id: `skill:skill-${i}:1`,
      subjectType: "skill",
      subjectId: `skill-${i}`,
      version: 1,
      kind: "delete",
      rowId: `row-${i}`,
    }));
    const memories = Array.from({ length: 12 }, (_, i) => ({
      id: `row-${i}`,
      skillSubjectId: `skill-${i}`,
      validTo: null,
    }));
    const findings = findLiveSkillTombstones(versions, memories);
    expect(findings).toHaveLength(12);
    const description = describeLiveSkillTombstones(versions, memories)!;
    expect(description).toContain("12 skill subjects");
    for (let i = 0; i < 12; i++) {
      expect(description).toContain(`skill-${i} (tombstone skill:skill-${i}:1, live row row-${i})`);
    }
  });
});

describe("readSkillTombstoneTables", () => {
  const table = (rows: unknown) => ({
    ok: true,
    json: async () => rows,
  }) as unknown as Response;

  it("reads both tables", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return String(init.body).includes("InstructionVersion")
        ? table([deleteVersion])
        : table({ results: [{ id: "row-a", skillSubjectId: "skill-a", validTo: null }] });
    }) as unknown as typeof fetch;
    const tables = await readSkillTombstoneTables({ opsUrl: "http://127.0.0.1:1/", authHeader: "Basic x", fetchImpl });
    expect(tables?.versions).toHaveLength(1);
    expect(tables?.memories).toHaveLength(1);
    expect(bodies).toHaveLength(2);
  });

  it("returns null when either read is not ok, not a row array, or throws", async () => {
    const notOk = (async () => ({ ok: false, json: async () => [] }) as unknown as Response) as unknown as typeof fetch;
    expect(await readSkillTombstoneTables({ opsUrl: "http://127.0.0.1:1/", authHeader: "Basic x", fetchImpl: notOk })).toBeNull();

    let call = 0;
    const malformed = (async () => {
      call++;
      return call === 1 ? table([deleteVersion]) : table({ nope: true });
    }) as unknown as typeof fetch;
    expect(await readSkillTombstoneTables({ opsUrl: "http://127.0.0.1:1/", authHeader: "Basic x", fetchImpl: malformed })).toBeNull();

    const throws = (async () => { throw new Error("unreadable"); }) as unknown as typeof fetch;
    expect(await readSkillTombstoneTables({ opsUrl: "http://127.0.0.1:1/", authHeader: "Basic x", fetchImpl: throws })).toBeNull();
  });
});
