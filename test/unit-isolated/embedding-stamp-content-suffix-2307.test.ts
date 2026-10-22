/**
 * embedding-stamp-content-suffix-2307.test.ts — flair#2307, the embedding-stamp
 * migration's re-embed of a stale row whose id ends in `.content`.
 *
 * That row is re-embedded through the raw table handle (the loopback
 * `PATCH /Memory/:id` cannot address it), from the text Memory's write paths
 * embed for it (a skill row's `trigger`, else `content`). The re-embed stages an
 * incremental `update` of only the embedding fields, then confirms the committed
 * row is still the one it read; a row gone or distinguishably changed at
 * confirmation aborts. A change committed after the confirm and before commit
 * is not seen (Harper has no compare-and-set; see the PR residual-gap note).
 *
 * Runs in its own process (test/unit-isolated): it mocks
 * resources/embeddings-provider.ts, which other unit files import for real.
 * The success path against real Harper is
 * test/integration/embedding-stamp-content-suffix-2307.test.ts; a change
 * committed while the transaction is paused after its read, against real
 * Harper, is test/integration/embedding-stamp-contention-2307.test.ts.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { hashEmbeddedText } from "../../resources/memory-embed-hash.ts";
import { memoryLockDouble } from "../helpers/memory-lock-double.ts";

const CURRENT = "current-model";
let embedImpl: (text: string) => Promise<unknown> = async () => [0.5, 0.25, 0.125];
let embedded: string[] = [];

// The fallback writes under the per-id Memory lock (flair#2478): the mock table
// supplies one on its primaryStore, as Harper's table does.
const memoryLock = memoryLockDouble();
mock.module("harper", () => ({ server: { http: () => {}, getUser: async () => null }, databases: { flair: { Memory: { primaryStore: memoryLock } } }, Resource: class {} }));
mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: (text: string) => {
    embedded.push(text);
    return embedImpl(text);
  },
  getModelId: () => CURRENT,
  EMBEDDING_ENGINE: "gguf",
  getMode: () => "local",
}));
// resources/request-transaction.ts reads Harper's `transaction` from the global.
// This stand-in stages the writes made through the transaction's context and
// applies them when the callback returns, whether or not a row it read changed
// meanwhile (Harper has no compare-and-set); a callback that throws discards
// them (an abort).
(globalThis as any).transaction = async (ctx: any, cb: (ctx: any) => any) => {
  const staged: { id: string; patch: Row }[] = [];
  ctx.transaction = { staged };
  const result = await cb(ctx);
  for (const { id, patch } of staged) {
    if (dropOnCommit.has(id)) {
      dropOnCommit.delete(id);
      continue;
    }
    commitPatch(id, patch);
  }
  afterCommit?.();
  return result;
};

const { createEmbeddingStampMigration } = await import("../../resources/migrations/embedding-stamp.ts");

type Row = Record<string, unknown> & { id: string };
const LEGACY_ID = "legacy-row.content";
const STALE = { embedding: [0.1, 0.1, 0.1], embeddingModel: "ancient-model" };

let store: Map<string, Row>;
/** Rows whose next staged write is dropped by the commit. */
let dropOnCommit: Set<string>;
/** Rows committed to the store by an update (a staged update counts once its transaction commits). */
let puts: Row[];
/** The method and the field names of every write the migration issued (flair#2494). */
let writeCalls: { method: "put" | "update"; id: string; fields: string[] }[];
/** Runs after an update is staged in a transaction, before that transaction commits. */
let afterStage: (() => void) | null = null;
/** Runs after the transaction commits, before the migration reads the row back. */
let afterCommit: (() => void) | null = null;

function commitPatch(id: string, patch: Row): void {
  const merged = { ...(store.get(id) ?? {}), ...structuredClone(patch), id };
  puts.push(structuredClone(merged));
  store.set(id, merged);
}

function matches(row: Row, cond: any): boolean {
  if (cond.operator && Array.isArray(cond.conditions)) {
    const results = cond.conditions.map((c: any) => matches(row, c));
    return cond.operator === "or" ? results.some(Boolean) : results.every(Boolean);
  }
  if (cond.comparator === "not_equals" || cond.comparator === "not_equal") return row[cond.attribute] !== cond.value;
  if (cond.comparator === "equals") return row[cond.attribute] === cond.value;
  return true;
}

const table = {
  async get(id: string) {
    const row = store.get(id);
    return row ? structuredClone(row) : null;
  },
  async put(row: Row, ctx?: any) {
    // The migration no longer uses a full-row put; kept so an accidental
    // reintroduction would still stage/commit predictably in this fake.
    writeCalls.push({ method: "put", id: row.id, fields: Object.keys(row).sort() });
    const staged = ctx?.transaction?.staged;
    if (!Array.isArray(staged)) return commitPatch(row.id, row);
    staged.push({ id: row.id, patch: structuredClone(row) });
    afterStage?.();
  },
  async update(id: string, patch: Row, ctx?: any) {
    writeCalls.push({ method: "update", id, fields: Object.keys(patch).sort() });
    const staged = ctx?.transaction?.staged;
    if (!Array.isArray(staged)) return commitPatch(id, patch);
    staged.push({ id, patch: structuredClone(patch) });
    afterStage?.();
  },
  search(query: any): AsyncIterable<Row> {
    const conditions = Array.isArray(query?.conditions) ? query.conditions : [];
    let rows = [...store.values()];
    for (const c of conditions) rows = rows.filter((r) => matches(r, c));
    rows = rows.slice(0, typeof query?.limit === "number" ? query.limit : Infinity);
    return (async function* () {
      for (const r of rows) yield structuredClone(r);
    })();
  },
};

function migration() {
  return createEmbeddingStampMigration(
    () => table,
    () => CURRENT,
    async (id) => {
      throw new Error(`the loopback regen must not be used for ${id}`);
    },
  );
}

beforeEach(() => {
  store = new Map([[LEGACY_ID, { id: LEGACY_ID, agentId: "a", content: "legacy body", ...STALE }]]);
  dropOnCommit = new Set();
  puts = [];
  writeCalls = [];
  embedded = [];
  embedImpl = async () => [0.5, 0.25, 0.125];
  afterStage = null;
  afterCommit = null;
});

describe("flair#2307 — the content-suffix re-embed validates the vector and committed re-read", () => {
  it("a usable vector is stamped current, and the rest of the row is kept", async () => {
    const result = await migration().run(10);
    expect(result).toEqual({ processed: 1, touchedIds: [LEGACY_ID] });
    expect(store.get(LEGACY_ID)).toMatchObject({ id: LEGACY_ID, agentId: "a", content: "legacy body", embedding: [0.5, 0.25, 0.125], embeddingModel: CURRENT });
    // flair#2465: an incremental update, never a full-row put — updatedAt and the
    // embedded-text hash binding are the only other fields the write touches.
    expect(Object.keys(store.get(LEGACY_ID)!).sort()).toEqual(["agentId", "content", "embeddedContentHash", "embedding", "embeddingModel", "id", "updatedAt"]);
    // Exactly one update, naming only the embedding fields, their text binding and
    // updatedAt; no full-row put (flair#2494). A whole-row update would name extra
    // fields and fail this assertion; a full-row put would fail the method check.
    expect(writeCalls).toEqual([{ method: "update", id: LEGACY_ID, fields: ["embeddedContentHash", "embedding", "embeddingModel", "updatedAt"] }]);
    expect(await migration().countPending()).toBe(0);
  });

  it("flair#2478: the vector is computed before the id's lock is taken, and the commit and its read-back run while it is held", async () => {
    const key = JSON.stringify(["memory", LEGACY_ID]);
    const heldDuringEmbed: boolean[] = [];
    embedImpl = async () => {
      heldDuringEmbed.push(memoryLock.held.has(key));
      return [0.5, 0.25, 0.125];
    };
    let heldAtCommit = false;
    afterCommit = () => { heldAtCommit = memoryLock.held.has(key); };
    const result = await migration().run(10);
    expect(result).toEqual({ processed: 1, touchedIds: [LEGACY_ID] });
    expect(heldDuringEmbed).toEqual([false]);
    expect(heldAtCommit, "the transaction committed after the lock was released").toBe(true);
    expect(memoryLock.held.has(key), "the lock was not released").toBe(false);
  });

  it("flair#2478: a held id is not written and not counted, and is written once it is free", async () => {
    const key = ["memory", LEGACY_ID];
    expect(memoryLock.tryLock(key)).toBe(true);
    try {
      const result = await migration().run(10);
      expect(result.processed).toBe(0);
      expect(writeCalls).toEqual([]);
      expect(store.get(LEGACY_ID)).toMatchObject(STALE);
    } finally {
      memoryLock.unlock(key);
    }
    expect(await migration().run(10)).toEqual({ processed: 1, touchedIds: [LEGACY_ID] });
  });

  it("a write the commit drops after confirmation is retried and lands, not reported success while missing", async () => {
    dropOnCommit.add(LEGACY_ID);
    const result = await migration().run(10);
    expect(result).toEqual({ processed: 1, touchedIds: [LEGACY_ID] });
    expect(store.get(LEGACY_ID)).toMatchObject({
      id: LEGACY_ID, agentId: "a", content: "legacy body", embedding: [0.5, 0.25, 0.125], embeddingModel: CURRENT,
    });
    expect(await migration().countPending()).toBe(0);
  });

  for (const [name, value] of [
    ["null (the provider's failure value)", null],
    ["an empty array", []],
    ["a non-finite component", [0.5, Number.NaN]],
    ["a non-array", "vector"],
  ] as const) {
    it(`a provider result of ${name} leaves the row pending and unwritten`, async () => {
      embedImpl = async () => value;
      const result = await migration().run(10);
      expect(result.processed).toBe(0);
      expect(puts).toEqual([]);
      expect(store.get(LEGACY_ID)).toMatchObject(STALE);
      expect(await migration().countPending()).toBe(1);
    });
  }

  it("a provider that throws leaves the row pending and unwritten", async () => {
    embedImpl = async () => {
      throw new Error("engine down");
    };
    const result = await migration().run(10);
    expect(result.processed).toBe(0);
    expect(puts).toEqual([]);
    expect(await migration().countPending()).toBe(1);
  });

  it("a row edited while its embedding was computed is not overwritten", async () => {
    embedImpl = async () => {
      store.set(LEGACY_ID, { ...store.get(LEGACY_ID)!, content: "edited meanwhile" });
      return [0.5, 0.25, 0.125];
    };
    const result = await migration().run(10);
    expect(result.processed).toBe(0);
    expect(puts).toEqual([]);
    expect(store.get(LEGACY_ID)).toMatchObject({ content: "edited meanwhile", ...STALE });
  });

  for (const [name, change] of [
    ["edited", () => store.set(LEGACY_ID, { ...store.get(LEGACY_ID)!, content: "edited after the read" })],
    ["deleted", () => store.delete(LEGACY_ID)],
  ] as const) {
    it(`a row ${name} after its write is staged aborts the stamp`, async () => {
      afterStage = () => {
        afterStage = null;
        change(); // a competing write commits while this transaction's write is staged
      };
      const result = await migration().run(10);
      expect(result.processed).toBe(0);
      expect(puts).toEqual([]); // assertion: the staged write was discarded, not committed
      if (name === "edited") {
        expect(store.get(LEGACY_ID)).toMatchObject({ content: "edited after the read", ...STALE });
        expect(await migration().countPending()).toBe(1);
      } else {
        expect(store.has(LEGACY_ID)).toBe(false);
      }
    });
  }

  it("a content edit committed after the update and before its read-back is not counted as that vector's", async () => {
    afterCommit = () => {
      afterCommit = null;
      store.set(LEGACY_ID, { ...store.get(LEGACY_ID)!, content: "edited after the commit" });
    };
    const result = await migration().run(10);
    // The text check rejects the first staged vector, and the retry computes a
    // vector for the edited text; only that one is counted.
    expect(result).toEqual({ processed: 1, touchedIds: [LEGACY_ID] });
    expect(store.get(LEGACY_ID)).toMatchObject({ content: "edited after the commit", embeddingModel: CURRENT });
    expect(store.get(LEGACY_ID)!.embeddedContentHash).toBe(hashEmbeddedText("a", "edited after the commit"));
  });

  it("a row another writer made current after the commit is not counted", async () => {
    afterCommit = () => {
      afterCommit = null;
      store.set(LEGACY_ID, {
        ...store.get(LEGACY_ID)!,
        embedding: [0.9, 0.8, 0.7],
        embeddingModel: CURRENT,
        embeddedContentHash: hashEmbeddedText("a", "edited by another writer"),
        content: "edited by another writer",
      });
    };
    const result = await migration().run(10);
    expect(result).toEqual({ processed: 0, touchedIds: [] });
  });

  it("a row re-created under the same id by another owner after staging is not patched", async () => {
    afterStage = () => {
      afterStage = null;
      // Delete + same-id re-create: a fresh incarnation the migration never read.
      store.set(LEGACY_ID, { id: LEGACY_ID, agentId: "b", content: "replacement", ...STALE });
    };
    const result = await migration().run(10);
    expect(result.processed).toBe(0);
    expect(puts).toEqual([]); // assertion: the staged update was discarded, not patched onto the replacement
    // The replacement keeps exactly what re-created it — no embedding fields patched on.
    expect(store.get(LEGACY_ID)).toMatchObject({ agentId: "b", content: "replacement", ...STALE });
  });

  it("a row deleted while its embedding was computed is not recreated", async () => {
    embedImpl = async () => {
      store.delete(LEGACY_ID);
      return [0.5, 0.25, 0.125];
    };
    const result = await migration().run(10);
    expect(result.processed).toBe(0);
    expect(puts).toEqual([]);
    expect(store.has(LEGACY_ID)).toBe(false);
  });
});

describe("flair#2307 — the content-suffix re-embed uses the text Memory embeds for the row", () => {
  const SKILL_ID = "legacy-skill.content";
  const TRIGGER = "when the greenhouse humidity climbs overnight";
  const PROCEDURE = "open the roof vents, then log the reading";

  it("a skill row is embedded from its trigger, not its content, and only then stamped current", async () => {
    store = new Map([[SKILL_ID, { id: SKILL_ID, agentId: "a", tags: ["skill"], trigger: TRIGGER, content: PROCEDURE, ...STALE }]]);
    embedImpl = async (text) => (text === TRIGGER ? [0.75, 0.5, 0.25] : [0.01, 0.02, 0.03]);
    const result = await migration().run(10);
    expect(embedded).toEqual([TRIGGER]); // assertion: the provider is asked for the trigger's vector
    expect(result).toEqual({ processed: 1, touchedIds: [SKILL_ID] });
    expect(store.get(SKILL_ID)).toMatchObject({ trigger: TRIGGER, content: PROCEDURE, embedding: [0.75, 0.5, 0.25], embeddingModel: CURRENT });
  });

  it("a skill row without a trigger is embedded from its content", async () => {
    store = new Map([[SKILL_ID, { id: SKILL_ID, agentId: "a", tags: ["skill"], content: PROCEDURE, ...STALE }]]);
    const result = await migration().run(10);
    expect(embedded).toEqual([PROCEDURE]);
    expect(result.processed).toBe(1);
    expect(store.get(SKILL_ID)).toMatchObject({ embeddingModel: CURRENT });
  });

  for (const [name, row] of [
    ["no content", { id: LEGACY_ID, agentId: "a", ...STALE }],
    ["empty content", { id: LEGACY_ID, agentId: "a", content: "", ...STALE }],
    ["a skill with no trigger and no content", { id: LEGACY_ID, agentId: "a", tags: ["skill"], ...STALE }],
  ] as const) {
    it(`a row with ${name} is not embedded and stays pending`, async () => {
      store = new Map([[LEGACY_ID, { ...row }]]);
      const result = await migration().run(10);
      expect(embedded).toEqual([]);
      expect(result.processed).toBe(0);
      expect(puts).toEqual([]);
      expect(await migration().countPending()).toBe(1);
    });
  }
});
