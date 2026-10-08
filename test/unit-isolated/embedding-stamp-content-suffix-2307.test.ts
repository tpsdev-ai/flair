/**
 * embedding-stamp-content-suffix-2307.test.ts — flair#2307, the embedding-stamp
 * migration's re-embed of a stale row whose id ends in `.content`.
 *
 * That row is re-embedded through the raw table handle (the loopback
 * `PUT /Memory/:id` cannot address it), from the text Memory's write paths
 * embed for it (a skill row's `trigger`, else `content`). A change visible at
 * the committed re-read aborts; later changes follow Harper's timestamp order
 * (see the PR residual-gap note).
 *
 * Runs in its own process (test/unit-isolated): it mocks
 * resources/embeddings-provider.ts, which other unit files import for real.
 * The success path against real Harper is
 * test/integration/embedding-stamp-content-suffix-2307.test.ts; a change
 * committed while the transaction is paused after its read, against real
 * Harper, is test/integration/embedding-stamp-contention-2307.test.ts.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

const CURRENT = "current-model";
let embedImpl: (text: string) => Promise<unknown> = async () => [0.5, 0.25, 0.125];
let embedded: string[] = [];

mock.module("harper", () => ({ server: { http: () => {}, getUser: async () => null }, databases: {}, Resource: class {} }));
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
  const staged: Row[] = [];
  ctx.transaction = { staged };
  const result = await cb(ctx);
  for (const row of staged) commitRow(row);
  return result;
};

const { createEmbeddingStampMigration } = await import("../../resources/migrations/embedding-stamp.ts");

type Row = Record<string, unknown> & { id: string };
const LEGACY_ID = "legacy-row.content";
const STALE = { embedding: [0.1, 0.1, 0.1], embeddingModel: "ancient-model" };

let store: Map<string, Row>;
/** Rows committed to the store by a put (a staged put counts once its transaction commits). */
let puts: Row[];
/** Runs after a put is staged in a transaction, before that transaction commits. */
let afterStage: (() => void) | null = null;

function commitRow(row: Row): void {
  puts.push(structuredClone(row));
  store.set(row.id, structuredClone(row));
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
    const staged = ctx?.transaction?.staged;
    if (!Array.isArray(staged)) return commitRow(row);
    staged.push(structuredClone(row));
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
  puts = [];
  embedded = [];
  embedImpl = async () => [0.5, 0.25, 0.125];
  afterStage = null;
});

describe("flair#2307 — the content-suffix re-embed validates the vector and committed re-read", () => {
  it("a usable vector is stamped current, and the rest of the row is kept", async () => {
    const result = await migration().run(10);
    expect(result).toEqual({ processed: 1, touchedIds: [LEGACY_ID] });
    expect(store.get(LEGACY_ID)).toEqual({ id: LEGACY_ID, agentId: "a", content: "legacy body", embedding: [0.5, 0.25, 0.125], embeddingModel: CURRENT });
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
    it(`a row ${name} before the committed re-read aborts the stamp`, async () => {
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
