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
  failNextPointerDelete: false,
  getOverride: null as null | ((id: string) => any),
};

export function resetHarnessState(): void {
  harnessState.memoryStore.clear();
  harnessState.pointerStore.clear();
  harnessState.instanceRow = null;
  harnessState.pointerSearchCalls = 0;
  harnessState.failNextPointerPut = false;
  harnessState.failNextPointerDelete = false;
  harnessState.getOverride = null;
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

/**
 * 0a/0c mock transaction. When a write is handed a context whose
 * `transaction` is one THIS helper created (it carries a `staged` array), the
 * write is STAGED and only applied on `commit()`; `abort()` discards it. This
 * is what lets the unit lane prove "no row after a failed pointer write"
 * without a Harper runtime. A test's own hand-built transaction (no `staged`)
 * is treated as joinable but writes straight through — the mock cannot roll a
 * Map back, so those tests assert the abort flag, not DB state.
 */
export function mockTransaction(ctx: any, cb: (txn: any) => any): any {
  const context = ctx && typeof ctx === "object" ? ctx : {};
  if (context.transaction && context.transaction.open === 1) return cb(context.transaction);
  const staged: Array<() => void> = [];
  const txn: any = {
    open: 1,
    saveCommits: false,
    staged,
    aborted: false,
    abort() { this.open = 0; this.aborted = true; staged.length = 0; },
    commit() { this.open = 0; for (const f of staged) f(); staged.length = 0; },
  };
  context.transaction = txn;
  let result: any;
  try { result = cb(txn); } catch (e) { txn.abort(); throw e; }
  if (result && typeof result.then === "function") {
    return result.then((r: any) => { txn.commit(); return r; }, (e: any) => { txn.abort(); throw e; });
  }
  txn.commit();
  return result;
}

/** Stage `apply` into `ctx`'s mock transaction when it has one (see
 *  mockTransaction); otherwise run it now. */
function stageOrRun(ctx: any, apply: () => void): void {
  const txn = ctx?.transaction;
  if (txn && txn.open === 1 && Array.isArray(txn.staged)) txn.staged.push(apply);
  else apply();
}

export class BaseMemory {
  async get(target?: any) {
    const id = typeof target === "string" ? target : target?.id;
    if (harnessState.getOverride && typeof id === "string") {
      const override = harnessState.getOverride(id);
      if (override !== undefined) return override;
    }
    return harnessState.memoryStore.get(id) ?? null;
  }
  async put(content: any, ctx?: any) {
    stageOrRun(ctx, () => harnessState.memoryStore.set(content.id, { ...content }));
    return { ...content };
  }
  async post(content: any, ctx?: any) {
    const id = content.id ?? `mem-${Math.random().toString(36).slice(2)}`;
    content.id = id;
    stageOrRun(ctx, () => harnessState.memoryStore.set(id, { ...content }));
    return { ...content };
  }
  async patch(content: any) {
    const id = content?.id ?? content;
    const prev = harnessState.memoryStore.get(id) ?? {};
    harnessState.memoryStore.set(id, { ...prev, ...content });
    return { ...harnessState.memoryStore.get(id) };
  }
  async update(id: string, row: any, ctx?: any) {
    stageOrRun(ctx, () => harnessState.memoryStore.set(id, { ...row }));
    return { ...row };
  }
  async delete(id: any, ctx?: any) {
    stageOrRun(ctx, () => harnessState.memoryStore.delete(typeof id === "string" ? id : id?.id));
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
    // Harper's `search({select})` returns ONLY the selected attributes, in
    // select order — a projection, not the full row. Mirror that here (flair#1940
    // A3): without it a test could pass on a field the real server never sends
    // (the pointer join binds on `instanceToken`, which is easy to omit from
    // DEFAULT_SELECT by accident). A query with no `select` still returns the
    // full row (the resource-level search path).
    const select = Array.isArray(topLevel.select) ? topLevel.select : null;
    if (select) {
      records = records.map((r) => {
        const projected: any = {};
        for (const key of select) if (key in r) projected[key] = r[key];
        return projected;
      });
    }
    async function* gen() {
      for (const r of records) yield r;
    }
    return gen();
  }
  // STATIC callables: real writers reach Memory via `databases.flair.Memory.*`
  // (e.g. Memory.put's pre-existing fetch, MemoryMaintenance's scan), not only
  // via the prototype `super.*`. Mirror the MemoryHostSource class below.
  static get(t?: any) {
    return new BaseMemory().get(t);
  }
  static put(c: any, ctx?: any) {
    return new BaseMemory().put(c, ctx);
  }
  static post(c: any, ctx?: any) {
    return new BaseMemory().post(c, ctx);
  }
  static patch(c: any) {
    return new BaseMemory().patch(c);
  }
  static update(id: string, row: any, ctx?: any) {
    return new BaseMemory().update(id, row, ctx);
  }
  static delete(id: any, ctx?: any) {
    return new BaseMemory().delete(id, ctx);
  }
  static search(q?: any) {
    return new BaseMemory().search(q);
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
  if (harnessState.failNextPointerDelete) {
    harnessState.failNextPointerDelete = false;
    return Promise.reject(new Error("boom: pointer delete down"));
  }
  harnessState.pointerStore.delete(typeof id === "string" ? id : id?.memoryId);
  return Promise.resolve({ ok: true });
}
function mhsSearch(query?: any) {
  harnessState.pointerSearchCalls++;
  const conds = Array.isArray(query?.conditions) ? query.conditions : [];
  const op = query?.operator || "and";
  // Harper refuses an `or` with fewer than two conditions — mirror that so a
  // single-id lookup that wrongly emits an `or` fails here rather than in CI.
  if (query?.operator === "or" && conds.length < 2) {
    throw new Error('An "or" operator requires at least two conditions');
  }
  let records = Array.from(harnessState.pointerStore.values());
  if (conds.length > 0) {
    records = records.filter((r) => {
      // A1'' item 4 (j3): honour the operator. A batched pointer lookup is an
      // `or` over memoryIds — evaluating it as `every` returned a wrong
      // per-row outcome.
      const results = conds.map((c: any) => matchesCondition(r, c));
      return op === "or" ? results.some(Boolean) : results.every(Boolean);
    });
  }
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
  // A1'' item 3 (adjudication C): the mock must MODEL patch (write-through)
  // so the r3 assertion is BEHAVIOURAL — it passes only because the resource
  // override refuses, and would go RED (a row written) if that override were
  // removed, rather than erroring on a missing method.
  patch(r: any) {
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
  static patch(r: any) {
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
  // Robust to the shared-process mock race: request-transaction.ts reads the
  // helper off the global (as Harper itself assigns it), not the mock namespace.
  (globalThis as any).transaction = mockTransaction;
  mock.module("harper", () => ({
    server: { http: () => {}, getUser: async () => null },
    databases: databasesMock,
    Resource: class {},
    transaction: mockTransaction,
  }));
  const { Memory } = await import("../../resources/Memory.ts");
  const { MemoryHostSource } = await import("../../resources/MemoryHostSource.ts");
  const { _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");
  return { Memory, MemoryHostSource, _resetLocalInstanceIdCacheForTests };
}
