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

class Table {
  get() { return { ...initial }; }
  getId() { return initial.id; }
  getContext() { return ctx; }
  async put(content: any) { writes.push(content); return content; }
  async patch(content: any) { writes.push(content); }
  static async get(id: string, context: any) {
    expect(id).toBe(initial.id);
    expect(context).toEqual({});
    expect(ctx.transaction).toBe(owned);
    onCommittedRead();
    if (readFailure) throw new Error("stored read unavailable");
    return committed;
  }
}

mock.module("harper", () => ({ databases: { flair: { Credential: Table } } }));
mock.module("../../resources/agent-auth.js", () => ({
  resolveAgentAuth: async () => ({ kind: "agent", agentId: "owner", isAdmin: false }),
  allowVerified: () => true,
}));
const { Credential } = await import("../../resources/Credential.ts");

beforeEach(() => {
  committed = { ...initial };
  onCommittedRead = () => {};
  writes = [];
  readFailure = false;
  ctx = { transaction: { open: 1, requestOwned: true } };
  owned = { open: 1, owned: true };
  (globalThis as any).transaction = async (context: any, callback: () => Promise<any>) => {
    expect(context.transaction).toBeUndefined();
    context.transaction = owned;
    return callback();
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
      test(`${verb} refuses a committed ${field} change without writing`, async () => {
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

    test(`${verb} refuses a committed deletion without writing`, async () => {
      onCommittedRead = () => { committed = null; };
      const result = await resultOf(verb);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(409);
      expect(writes).toEqual([]);
      expect(committed).toBeNull();
    });

    test(`${verb} refuses an unavailable committed read without writing`, async () => {
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
    });
  }
});
