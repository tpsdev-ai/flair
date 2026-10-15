import { beforeEach, describe, expect, mock, test } from "bun:test";

const initial = {
  id: "mapping", principalId: "owner", kind: "idp", status: "active",
  idpProvider: "provider", idpSubject: "subject", label: "mapping", createdAt: new Date().toISOString(),
};
let committed: Record<string, unknown> | null;
let onCommittedRead: () => void;
let writes: unknown[];
let ctx: any;
let owned: any;
let readFailure: boolean;
let transactionCount: number;
let onPause: (point: string) => void;
let rows: Map<string, any>;
let events: string[];

class Table {
  constructor(private id = initial.id) {}
  get() { return { ...rows.get(this.id) }; }
  getId() { return this.id; }
  static getResource(this: any, target: any) { return new this(target.id); }
  getContext() { return ctx; }
  async put(content: any) {
    expect(ctx.transaction).toBe(owned);
    events.push(`write:${this.id}`);
    writes.push(content);
    owned.staged.set(this.id, content);
    return content;
  }
  async patch(content: any) {
    expect(ctx.transaction).toBe(owned);
    events.push(`write:${this.id}`);
    writes.push(content);
    owned.staged.set(this.id, { ...rows.get(this.id), ...content });
  }
  static async get(id: string, context: any) {
    events.push(`confirm:${id}`);
    expect(context).toBe(ctx);
    expect(ctx.transaction).toBe(owned);
    onCommittedRead();
    if (readFailure) throw new Error("stored read unavailable");
    return id === initial.id ? committed : rows.get(id);
  }
}

mock.module("harper", () => ({ databases: { flair: { Credential: Table } } }));
mock.module("../../resources/agent-auth.js", () => ({
  resolveAgentAuth: async () => ({ kind: "agent", agentId: "owner", isAdmin: false }),
  allowVerified: () => true,
}));
mock.module("../../resources/txn-pause-point.js", () => ({
  txnPausePoint: (point: string) => {
    events.push(point);
    onPause(point);
    return undefined;
  },
}));
const { Credential } = await import("../../resources/Credential.ts");

beforeEach(() => {
  committed = { ...initial };
  onCommittedRead = () => {};
  writes = [];
  readFailure = false;
  transactionCount = 0;
  events = [];
  onPause = () => {};
  rows = new Map([[initial.id, { ...initial }]]);
  ctx = { transaction: { open: 1, requestOwned: true } };
  owned = { open: 1, owned: true, staged: new Map() };
  (globalThis as any).transaction = async (context: any, callback: () => Promise<any>) => {
    expect(context.transaction).toBeUndefined();
    transactionCount++;
    const transaction = { open: 1, staged: new Map() };
    owned = transaction;
    context.transaction = transaction;
    const result = await callback();
    for (const [id, row] of transaction.staged) rows.set(id, row);
    return result;
  };
});

async function resultOf(verb: "put" | "patch") {
  const resource = new Credential();
  const body = verb === "put" ? { ...initial, label: "owner label" } : { label: "owner label" };
  try { return await resource[verb](body); } catch (error) { return error; }
}

describe("Credential committed-row confirmation", () => {
  for (const verb of ["put", "patch"] as const) {
    for (const [field, value] of Object.entries({
      status: "revoked", kind: "bearer-token", idpProvider: "updated-provider",
      idpSubject: "updated-subject", principalId: "other",
    })) {
      test(`${verb} refuses a ${field} difference at confirmation`, async () => {
        const expected = { ...initial, [field]: value };
        onCommittedRead = () => { committed = expected; };
        const requestTransaction = ctx.transaction;
        const result = await resultOf(verb);
        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(409);
        expect(await (result as Response).json()).toMatchObject({ error: "stored_row_changed" });
        expect(writes).toEqual([]);
        expect(committed).toEqual(expected);
        expect(ctx.transaction).toBe(requestTransaction);
      });
    }

    test(`${verb} refuses an absent row at confirmation`, async () => {
      onCommittedRead = () => { committed = null; };
      const result = await resultOf(verb);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(409);
      expect(writes).toEqual([]);
      expect(committed).toBeNull();
    });

    test(`${verb} refuses a failed confirmation read`, async () => {
      readFailure = true;
      const result = await resultOf(verb);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(503);
      expect(writes).toEqual([]);
    });

    test(`${verb} relabels when the committed mapping fields match`, async () => {
      const result = await resultOf(verb);
      expect(result instanceof Response).toBe(false);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ label: "owner label" });
      expect(events).toEqual([
        "credential-row-write", `confirm:${initial.id}`, "credential-row-write-confirmed", `write:${initial.id}`,
      ]);
    });
  }
});


describe("Credential array PUT transaction", () => {
  test("array PUT aborts when an element returns a refusal", async () => {
    const sibling = { ...initial, id: "sibling" };
    rows.set(sibling.id, sibling);
    const resource = Credential.getResource({ id: undefined }, ctx, { isCollection: true, method: "put" });
    let result: any;
    try {
      result = await resource.put({}, [{ ...sibling, label: "owner label" }, { ...initial, kind: "invalid" }]);
    } catch (error) { result = error; }
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(400);
    expect(rows.get(sibling.id)).toEqual(sibling);
    expect(transactionCount).toBe(1);
  });

  for (const changed of [false, true]) {
    test(`array PUT uses one transaction when confirmation differs: ${changed}`, async () => {
      const sibling = { ...initial, id: "sibling" };
      rows.set(sibling.id, sibling);
      onPause = (point) => {
        if (point === "credential-batch-row-write" && changed) committed = { ...initial, status: "revoked" };
      };
      const resource = Credential.getResource({ id: undefined }, ctx, { isCollection: true, method: "put" });
      let result: any;
      try {
        result = await resource.put({}, [{ ...sibling, label: "owner label" }, { ...initial, label: "owner label" }]);
      } catch (error) { result = error; }
      expect(transactionCount).toBe(1);
      if (changed) {
        expect(result).toBeInstanceOf(Response);
        expect(result.status).toBe(409);
        expect(await result.json()).toMatchObject({ error: "stored_row_changed" });
        expect(rows.get(sibling.id)).toEqual(sibling);
        expect(rows.get(initial.id)).toEqual(initial);
      } else {
        expect(result instanceof Response).toBe(false);
        expect(rows.get(sibling.id).label).toBe("owner label");
        expect(rows.get(initial.id).label).toBe("owner label");
      }
    });
  }
});
