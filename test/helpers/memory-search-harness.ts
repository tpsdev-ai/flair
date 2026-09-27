/**
 * memory-search-harness.ts — SHARED Harper mock for the test/unit files that
 * import resources/Memory.ts.
 *
 * Bun caches a dynamic import by resolved path ACROSS test files in one
 * process, while `mock.module("harper")` is process-global: whichever file's
 * mock wins the race binds `class Memory extends (databases as any).flair.Memory`
 * ONCE. If each file carried its OWN store, the winner's store would be the
 * only one the Memory class ever saw, and the other file's tests would read an
 * empty store. The repo's own fix (test/helpers/harper-mock.ts) is to share ONE
 * store object and define IDENTICAL shapes in each file. This module is that
 * shared store + shape for Memory + MemoryHostSource, so memory-search-scope
 * and memory-host-source tests can run in the same process without racing.
 */
import { mock } from "bun:test";

/** The shared, mutable state both files read and write. */
export const harnessState = {
  memoryStore: new Map<string, any>(),
  pointerStore: new Map<string, any>(),
  instanceRow: null as any,
  pointerSearchCalls: 0,
  failNextPointerPut: false,
};

export function resetHarnessState(): void {
  harnessState.memoryStore.clear();
  harnessState.pointerStore.clear();
  harnessState.instanceRow = null;
  harnessState.pointerSearchCalls = 0;
  harnessState.failNextPointerPut = false;
}

export function matchesCondition(record: any, cond: any): boolean {
  if (cond.operator && Array.isArray(cond.conditions)) {
    const results = cond.conditions.map((c: any) => matchesCondition(record, c));
    return cond.operator === "or" ? results.some(Boolean) : results.every(Boolean);
  }
  const fieldVal = record[cond.attribute];
  if (cond.comparator === "equals") return fieldVal === cond.value;
  if (cond.comparator === "not_equal") return fieldVal !== cond.value;
  return true;
}

export class BaseMemory {
  async get(target?: any) {
    const id = typeof target === "string" ? target : target?.id;
    return harnessState.memoryStore.get(id) ?? null;
  }
  async put(content: any) {
    harnessState.memoryStore.set(content.id, { ...content });
    return { ...content };
  }
  async post(content: any) {
    const id = content.id ?? `mem-${Math.random().toString(36).slice(2)}`;
    content.id = id;
    harnessState.memoryStore.set(id, { ...content });
    return { ...content };
  }
  async patch(content: any) {
    const id = content?.id ?? content;
    const prev = harnessState.memoryStore.get(id) ?? {};
    harnessState.memoryStore.set(id, { ...prev, ...content });
    return { ...harnessState.memoryStore.get(id) };
  }
  async update(id: string, row: any) {
    harnessState.memoryStore.set(id, { ...row });
    return { ...row };
  }
  async delete(id: any) {
    harnessState.memoryStore.delete(typeof id === "string" ? id : id?.id);
    return { ok: true };
  }
  search(query?: any) {
    const topLevel = Array.isArray(query) ? { conditions: query, operator: "and" } : query || {};
    const conds = Array.isArray(topLevel.conditions) ? topLevel.conditions : [];
    const op = topLevel.operator || "and";
    let records = Array.from(harnessState.memoryStore.values());
    if (conds.length > 0) {
      records = records.filter((r) => {
        const results = conds.map((c: any) => matchesCondition(r, c));
        return op === "or" ? results.some(Boolean) : results.every(Boolean);
      });
    }
    async function* gen() {
      for (const r of records) yield r;
    }
    return gen();
  }
}

// Harper's `databases.flair.MemoryHostSource.search/put/get/delete` are
// STATIC-callable (how Memory's writers reach it); the RESOURCE class calls
// super.* on the PROTOTYPE — so the mock defines both.
function mhsGet(target?: any) {
  const id = typeof target === "string" ? target : (target?.memoryId ?? target?.id);
  return Promise.resolve(harnessState.pointerStore.get(id) ?? null);
}
function mhsPut(row: any) {
  if (harnessState.failNextPointerPut) {
    harnessState.failNextPointerPut = false;
    return Promise.reject(new Error("boom: pointer store down"));
  }
  harnessState.pointerStore.set(row.memoryId, { ...row });
  return Promise.resolve({ ...row });
}
function mhsDelete(id: any) {
  harnessState.pointerStore.delete(typeof id === "string" ? id : id?.memoryId);
  return Promise.resolve({ ok: true });
}
function mhsSearch(query?: any) {
  harnessState.pointerSearchCalls++;
  let records = Array.from(harnessState.pointerStore.values());
  const conds = Array.isArray(query?.conditions) ? query.conditions : [];
  if (conds.length > 0) records = records.filter((r) => conds.every((c: any) => matchesCondition(r, c)));
  return (async function* gen() {
    for (const r of records) yield r;
  })();
}
export class BaseMemoryHostSource {
  get(t?: any) {
    return mhsGet(t);
  }
  put(r: any) {
    return mhsPut(r);
  }
  post(r: any) {
    return mhsPut(r);
  }
  delete(id: any) {
    return mhsDelete(id);
  }
  search(q?: any) {
    return mhsSearch(q);
  }
  static get(t?: any) {
    return mhsGet(t);
  }
  static put(r: any) {
    return mhsPut(r);
  }
  static post(r: any) {
    return mhsPut(r);
  }
  static delete(id: any) {
    return mhsDelete(id);
  }
  static search(q?: any) {
    return mhsSearch(q);
  }
}

export const databasesMock = {
  flair: {
    Memory: BaseMemory,
    MemoryHostSource: BaseMemoryHostSource,
    Agent: { get: async () => null, search: async () => [] },
    Instance: {
      search: () => {
        async function* gen() {
          if (harnessState.instanceRow) yield harnessState.instanceRow;
        }
        return gen();
      },
    },
    MemoryGrant: {
      search: () => {
        async function* gen() {};
        return gen();
      },
    },
  },
};

/** Register the shared harper mock and import the resource classes. Call ONCE
 *  at a test file's top level (mock.module must precede the resource import). */
export async function installMemoryHarperMock() {
  mock.module("harper", () => ({
    server: { http: () => {}, getUser: async () => null },
    databases: databasesMock,
    Resource: class {},
  }));
  const { Memory } = await import("../../resources/Memory.ts");
  const { MemoryHostSource } = await import("../../resources/MemoryHostSource.ts");
  const { _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");
  return { Memory, MemoryHostSource, _resetLocalInstanceIdCacheForTests };
}
