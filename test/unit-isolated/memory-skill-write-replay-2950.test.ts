// flair#2950 — Memory.put()'s lock-retry body, in process. A body that cannot
// be cloned is refused before the first attempt, so a stale-target retry never
// replays the object an attempt mutated. Mocked transactions/locks, no Harper.
import { beforeEach, expect, test } from "bun:test";
import {
  databasesMock, harnessState, installMemoryHarperMock, resetHarnessState,
} from "../helpers/memory-search-harness";

const versions = new Map<string, any>();
const locks = new Set<string>();
(databasesMock.flair as any).InstructionVersion = {
  validate() {},
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
const { Memory, _resetLocalInstanceIdCacheForTests } = await installMemoryHarperMock();

const operator = { request: { tpsAgent: "admin", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "Basic ok" }) } };

function writer(id: string, ctx: any = operator): any {
  const resource: any = new (Memory as any)();
  resource.getId = () => id;
  resource.getContext = () => ctx;
  return resource;
}

function skill(id: string, content: string, extra: Record<string, unknown> = {}): any {
  return {
    id, agentId: "owner", tags: ["skill"], content, trigger: "when it applies",
    durability: "persistent", visibility: "shared", ...extra,
  };
}

beforeEach(() => {
  resetHarnessState(); versions.clear(); locks.clear();
  _resetLocalInstanceIdCacheForTests();
});

test("a PUT body that cannot be cloned is refused before the stale-target retry reuses it", async () => {
  // The first version at `subject` is closed by a successor; the live head is
  // the successor row. A PUT that addresses `subject` needs a second lock
  // acquisition for the head, so it would replay the body on its retry.
  const subject = "replay-stale-subject";
  const create = await writer(subject).put(skill(subject, "first version"));
  expect(create.id).toBe(subject);
  const update = await writer(subject).put(skill(subject, "successor"));
  expect(update.id).not.toBe(subject);

  const versionsBefore = [...versions.keys()].sort();
  const storeBefore = new Map(harnessState.memoryStore);
  const body: any = skill(subject, "stale write", { note: () => "not JSON" });
  const keysBefore = Object.keys(body).sort();

  const result = await writer(subject).put(body);

  expect(result).toBeInstanceOf(Response);
  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({ error: "memory_body_uncloneable", message: expect.any(String) });
  // The caller's object was never run: no attempt stamped it and no retry saw it.
  expect(Object.keys(body).sort()).toEqual(keysBefore);
  expect(typeof body.note).toBe("function");
  expect(body.createdAt, "the first attempt stamped the caller's body").toBeUndefined();
  expect(body.updatedAt).toBeUndefined();
  expect(harnessState.memoryStore).toEqual(storeBefore);
  expect([...versions.keys()].sort()).toEqual(versionsBefore);
}, 10_000);
