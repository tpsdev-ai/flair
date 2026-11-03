/**
 * feed-skill-withheld-2927.test.ts — flair#2927, isolated.
 *
 * A skill-tagged POST /FeedMemories write takes the per-id Memory write lock
 * (resources/MemoryFeed.ts) and can record the id outcome-unknown. This suite
 * tests withheld write results and an unreadable refusal body. Isolated
 * process: owns the harper mock for MemoryFeed.ts.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  databasesMock, harnessState, installMemoryHarperMock, resetHarnessState,
} from "../helpers/memory-search-harness";
import { memoryWriteOutcomeUnknown, resetMemoryWriteOutcomeUnknownForTest } from "../../resources/memory-write-lock.ts";
import { WRITE_RESPONSE_WITHHELD, WRITE_RESPONSE_WITHHELD_MESSAGE } from "../../resources/memory-write-response.ts";

const versions = new Map<string, any>();
const locks = new Set<string>();
(databasesMock.flair as any).InstructionVersion = {
  primaryStore: {
    tryLock: (key: unknown) => { const k = JSON.stringify(key); if (locks.has(k)) return false; locks.add(k); return true; },
    unlock: (key: unknown) => locks.delete(JSON.stringify(key)),
    resetReadTxn: () => {},
  },
  async *search(query: any) {
    const rows = [...versions.values()].filter((row) => query.conditions.every((c: any) => row[c.attribute] === c.value));
    rows.sort((a, b) => Number(b.version) - Number(a.version));
    yield* rows.slice(0, query.limit ?? rows.length);
  },
  async create(row: any, shared: any) {
    shared.transaction.staged.push(() => versions.set(row.id, { ...row }));
  },
};
const { _resetLocalInstanceIdCacheForTests } = await installMemoryHarperMock();

/** Storage withholds these ids' write result (returns a Response, flair#2857). */
let withholdIds = new Set<string>();
let withholdSuccessor = false;
let attemptedPutIds: string[] = [];
const markedIds = new Set<string>();
const memoryTable: any = databasesMock.flair.Memory;
const realPut = memoryTable.put;
memoryTable.put = async (row: any, shared?: any) => {
  const id = String(row?.id);
  attemptedPutIds.push(id);
  markedIds.add(id);
  const result = await realPut(row, shared);
  return withholdIds.has(id) || (withholdSuccessor && id !== "skill-withheld")
    ? Response.json({ id }) : result;
};

const { FeedMemories } = await import("../../resources/MemoryFeed.ts");

const operator = { request: { tpsAgent: "admin", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "Basic ok" }) } };

function feed(ctx = operator): any {
  const resource: any = new FeedMemories();
  resource.getContext = () => ctx;
  return resource;
}

function skillBody(id: string, content = "procedure"): any {
  return {
    id, agentId: "admin", content, trigger: "when it applies", tags: ["skill"],
    durability: "persistent", visibility: "shared",
  };
}

beforeEach(() => {
  resetHarnessState();
  versions.clear();
  locks.clear();
  withholdIds = new Set();
  withholdSuccessor = false;
  attemptedPutIds = [];
  for (const id of markedIds) resetMemoryWriteOutcomeUnknownForTest(id);
  markedIds.clear();
  _resetLocalInstanceIdCacheForTests();
  resetMemoryWriteOutcomeUnknownForTest("skill-withheld");
});

test("CONTROL: an uncontended skill feed write stores the successor and records no marker", async () => {
  const result = await feed().post(skillBody("skill-withheld"));
  expect(result).not.toBeInstanceOf(Response);
  expect(harnessState.memoryStore.get("skill-withheld")?.skillSubjectId).toBe("skill-withheld");
  expect(memoryWriteOutcomeUnknown("skill-withheld")).toBe(false);
});

test("a skill feed write whose storage result is withheld records the id outcome-unknown", async () => {
  withholdIds = new Set(["skill-withheld"]);
  const response = await feed().post(skillBody("skill-withheld"));
  expect(response).toBeInstanceOf(Response);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: WRITE_RESPONSE_WITHHELD, message: WRITE_RESPONSE_WITHHELD_MESSAGE });
  expect(memoryWriteOutcomeUnknown("skill-withheld")).toBe(true);
  expect(harnessState.memoryStore.has("skill-withheld"), "the withheld write left a row").toBe(false);

  const next = await feed().post(skillBody("skill-withheld", "retry after the unknown outcome"));
  expect(next.status).toBe(503);
  expect(await next.json()).toMatchObject({ error: "write_outcome_unknown" });
  expect(harnessState.memoryStore.has("skill-withheld"), "the refused write left a row").toBe(false);
});

afterEach(() => {
  for (const id of markedIds) resetMemoryWriteOutcomeUnknownForTest(id);
});

async function seedHead(): Promise<void> {
  expect(await feed().post(skillBody("skill-withheld"))).not.toBeInstanceOf(Response);
  attemptedPutIds = [];
}

test("a withheld successor put marks the successor and leaves the unattempted head writable", async () => {
  await seedHead();
  withholdSuccessor = true;
  const response = await feed().post(skillBody("skill-withheld", "updated procedure"));
  expect(response.status).toBe(500);
  expect((await response.json()).error).toBe(WRITE_RESPONSE_WITHHELD);
  expect(attemptedPutIds).toHaveLength(1);
  const [successorId] = attemptedPutIds;
  expect(successorId).not.toBe("skill-withheld");
  expect(memoryWriteOutcomeUnknown(successorId)).toBe(true);
  expect(memoryWriteOutcomeUnknown("skill-withheld"), "the unattempted head was marked").toBe(false);

  withholdSuccessor = false;
  expect(await feed().post(skillBody("skill-withheld", "following write to the head"))).not.toBeInstanceOf(Response);
});

test("a withheld close marks both the attempted successor and head", async () => {
  await seedHead();
  withholdIds.add("skill-withheld");
  const response = await feed().post(skillBody("skill-withheld", "updated procedure"));
  expect(response.status).toBe(500);
  expect((await response.json()).error).toBe(WRITE_RESPONSE_WITHHELD);
  expect(attemptedPutIds).toHaveLength(2);
  const [successorId, headId] = attemptedPutIds;
  expect(successorId).not.toBe("skill-withheld");
  expect(headId).toBe("skill-withheld");
  expect(memoryWriteOutcomeUnknown(successorId)).toBe(true);
  expect(memoryWriteOutcomeUnknown(headId)).toBe(true);
});

test("an unreadable refusal after only the successor put marks only the successor", async () => {
  await seedHead();
  withholdSuccessor = true;
  const clone = spyOn(Response.prototype, "clone").mockImplementation(() => {
    throw new Error("refusal body unreadable");
  });
  let response: Response;
  try {
    response = await feed().post(skillBody("skill-withheld", "updated procedure"));
    expect(clone).toHaveBeenCalled();
  } finally {
    clone.mockRestore();
  }
  expect(response.status).toBe(500);
  expect((await response.json()).error).toBe(WRITE_RESPONSE_WITHHELD);
  expect(attemptedPutIds).toHaveLength(1);
  const [successorId] = attemptedPutIds;
  expect(successorId).not.toBe("skill-withheld");
  expect(memoryWriteOutcomeUnknown(successorId)).toBe(true);
  expect(memoryWriteOutcomeUnknown("skill-withheld")).toBe(false);
});
