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
  // flair#2213: Flair's deletion writers append records here in the row delete's transaction.
  deletionStore: new Map<string, any>(),
  instanceRow: null as any,
  pointerSearchCalls: 0,
  failNextPointerPut: false,
  failNextPointerDelete: false,
  getOverride: null as null | ((id: string) => any),
  // flair#1940 round 13 (blocker 6): observe what the HANDLER passes to the base
  // table read — proof that the by-id/collection scope read is UNSELECTED.
  baseSearchCalls: 0,
  lastBaseGetTarget: null as any,
  lastBaseSearchQuery: null as any,
  // flair#1940 round 22 (fix 3): how many rows the base search generator has
  // actually YIELDED, and the size of each batched pointer query. Together
  // they prove a chunked pointer join streams (yields before the source is
  // exhausted) and keeps every pointer query bounded.
  baseSearchYields: 0,
  pointerQuerySizes: [] as number[],
};

export function resetHarnessState(): void {
  harnessState.memoryStore.clear();
  harnessState.pointerStore.clear();
  harnessState.deletionStore.clear();
  harnessState.instanceRow = null;
  harnessState.pointerSearchCalls = 0;
  harnessState.failNextPointerPut = false;
  harnessState.failNextPointerDelete = false;
  harnessState.getOverride = null;
  harnessState.baseSearchCalls = 0;
  harnessState.lastBaseGetTarget = null;
  harnessState.lastBaseSearchQuery = null;
  harnessState.baseSearchYields = 0;
  harnessState.pointerQuerySizes = [];
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
  /** Real Harper binds the resource to the URL target (`getId()`); a PUT writes
   *  to THAT id. `_targetId` models the URL-bound target; unset for a direct
   *  in-process call, where the body id IS the write key. See
   *  resources/originator-instance.ts. */
  getId() { return (this as any)._targetId; }
  async get(target?: any) {
    harnessState.lastBaseGetTarget = target;
    const id = typeof target === "string" ? target : target?.id;
    if (harnessState.getOverride && typeof id === "string") {
      const override = harnessState.getOverride(id);
      if (override !== undefined) return override;
    }
    const row = harnessState.memoryStore.get(id) ?? null;
    // Harper's `get(target)` honours `target.property` / `target.select` exactly
    // like search(): a single property (or a string select) returns that field's
    // value; an array select returns only the selected attributes the row
    // carries, in select order. Mirror it here (flair#1940 rounds 11-12) so a
    // caller-selected by-id read can be driven at the handler level, the same
    // way the `search` mock below mirrors `search({select})`.
    if (target?.property) return row?.[target.property];
    const select = target?.select;
    if (typeof select === "string") return row?.[select];
    if (Array.isArray(select) && row && typeof row === "object") {
      const projected: any = {};
      for (const key of select) if (key in row) projected[key] = row[key];
      return projected;
    }
    return row;
  }
  async put(content: any, ctx?: any) {
    const id = this.getId?.() ?? content.id;
    stageOrRun(ctx, () => harnessState.memoryStore.set(id, { ...content, id }));
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
    return true;
  }
  search(query?: any) {
    harnessState.baseSearchCalls++;
    harnessState.lastBaseSearchQuery = query;
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
      for (const r of records) {
        harnessState.baseSearchYields++;
        yield r;
      }
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
  }  static post(c: any, ctx?: any) {
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
  harnessState.pointerQuerySizes.push(conds.length);
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

export class BaseMemoryDeletionHistory {
  async put(row: any, ctx?: any) {
    stageOrRun(ctx, () => harnessState.deletionStore.set(row.id, { ...row }));
    return { ...row };
  }
  static put(row: any, ctx?: any) {
    return new BaseMemoryDeletionHistory().put(row, ctx);
  }
}

export const databasesMock = {
  flair: {
    Memory: BaseMemory,
    MemoryHostSource: BaseMemoryHostSource,
    MemoryDeletionHistory: BaseMemoryDeletionHistory,
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

/** flair#1940 round 13 — a minimal stand-in for Harper's `RequestTarget`. The
 *  resource builds a FRESH one carrying only the id for an unselected scope read
 *  (#1975); extends URLSearchParams like the real class so `instanceof` checks
 *  behave the same. */
export class MockRequestTarget extends URLSearchParams {
  id: any;
  isCollection: any;
  pathname: any;
  search: any;
  constructor(target?: any) {
    super();
    if (target === undefined) return; // fresh instance: id/isCollection left unset
    const t = String(target);
    const qi = t.indexOf("?");
    if (qi > -1) {
      this.pathname = t.slice(0, qi);
      const s = t.slice(qi + 1);
      this.search = s;
      new URLSearchParams(s).forEach((v, k) => this.append(k, v));
    } else {
      this.pathname = t;
    }
    let path = this.pathname ?? "";
    if (path.startsWith("/")) path = path.slice(1);
    if (path.endsWith("/")) {
      this.isCollection = true;
      this.id = null;
    } else {
      this.isCollection = false;
      this.id = decodeURIComponent(path.split("/").pop() ?? "");
    }
  }
}

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
    RequestTarget: MockRequestTarget,
  }));
  const { Memory } = await import("../../resources/Memory.ts");
  const { MemoryHostSource } = await import("../../resources/MemoryHostSource.ts");
  const { _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");
  return { Memory, MemoryHostSource, _resetLocalInstanceIdCacheForTests };
}
