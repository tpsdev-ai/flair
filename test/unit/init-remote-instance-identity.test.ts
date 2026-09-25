/**
 * `flair init --remote` reconciles the Instance identity row (flair#1883).
 *
 * The reconcile reads the rows FIRST and then decides: no row → create one with
 * `role: hub`; exactly one row → set THAT row's role to `hub` (keeping its id
 * and key, because peers know that identity); already a hub → write nothing;
 * more than one row → refuse, naming every row and the command that resolves it,
 * and write nothing at all.
 *
 * Once it has written, it RE-READS (flair#1883 round 2): the read-then-write
 * window is real, and a `GET /FederationInstance` landing in it leaves two rows.
 * That must be reported with the prune remedy, never returned as `created`.
 *
 * The behaviour this replaces INSERTed a fresh-id hub row on every run, so a hub
 * that had already answered `GET /FederationInstance` (which find-or-creates a
 * `spoke` row) carried two rows and no canonical identity.
 *
 * The ops API is mocked at the global fetch boundary, exactly as the ops-API
 * integration tests do, because the create path goes through cli.ts's own
 * retrying insert helper.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { reconcileFederationInstanceViaOpsApi } from "../../src/cli.js";
import { INSTANCE_ROW_PRUNE_COMMAND } from "../../src/lib/instance-identity-row.js";

const OPS_URL = "http://127.0.0.1:19925";
const CREATE = { instanceId: "flair_newidentity", publicKey: "new-public-key" };

let calls: any[] = [];
let origFetch: typeof fetch;
/** The Instance table the mock serves; writes mutate it, so a re-read sees them. */
let table: any[] = [];
let reads = 0;
/** A row that appears between the decision and the write — a racing GET. */
let raceOnSecondRead: any[] | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  reads = 0;
  raceOnSecondRead = null;
  origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

function mockOps(rows: unknown, opts: { searchStatus?: number } = {}) {
  table = Array.isArray(rows) ? [...(rows as any[])] : [];
  globalThis.fetch = mock(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    switch (body.operation) {
      case "sql":
        reads++;
        if (opts.searchStatus && opts.searchStatus !== 200) {
          return new Response("read refused", { status: opts.searchStatus });
        }
        if (raceOnSecondRead && reads === 2) table = [...table, ...raceOnSecondRead];
        return json(table);
      case "insert": {
        const record = body.records[0];
        table = [...table, record];
        return json({ inserted_hashes: [record.id] });
      }
      case "update": {
        const record = body.records[0];
        table = table.map((r) => (r.id === record.id ? { ...r, ...record } : r));
        return json({ update_hashes: [record.id], skipped_hashes: [] });
      }
      case "list_roles":
        return json([]);
      default:
        return json({ ok: true });
    }
  }) as unknown as typeof fetch;
}

const opsOf = (operation: string) => calls.filter((c) => c.operation === operation);

describe("reconcileFederationInstanceViaOpsApi", () => {
  it("no row → creates one with role hub and the generated id/key", async () => {
    mockOps([]);

    const result = await reconcileFederationInstanceViaOpsApi(OPS_URL, CREATE, "admin", "test-pass");

    expect(result).toEqual({ action: "created", id: CREATE.instanceId });
    const inserts = opsOf("insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("Instance");
    expect(inserts[0].records[0]).toMatchObject({
      id: CREATE.instanceId,
      publicKey: CREATE.publicKey,
      role: "hub",
    });
    // The row is not written before the rows were read.
    expect(calls[0].operation).toBe("sql");
    // ...and the write is verified by re-reading, not assumed.
    expect(opsOf("sql")).toHaveLength(2);
  });

  it("one spoke row → sets THAT row's role to hub, keeping its id and key", async () => {
    mockOps([{ id: "flair_existing", role: "spoke", publicKey: "peer-known-key", createdAt: "2026-09-02T00:00:00Z" }]);

    const result = await reconcileFederationInstanceViaOpsApi(OPS_URL, CREATE, "admin", "test-pass");

    expect(result).toEqual({ action: "updated", id: "flair_existing" });
    // No second row, ever.
    expect(opsOf("insert")).toHaveLength(0);
    const updates = opsOf("update");
    expect(updates).toHaveLength(1);
    expect(updates[0].records[0].id).toBe("flair_existing");
    expect(updates[0].records[0].role).toBe("hub");
    // The key is not rewritten — peers know this identity.
    expect(updates[0].records[0].publicKey).toBeUndefined();
  });

  it("an existing hub row is a no-op: re-running writes nothing", async () => {
    mockOps([{ id: "flair_already_hub", role: "hub", publicKey: "k", createdAt: "2026-09-01T00:00:00Z" }]);

    const result = await reconcileFederationInstanceViaOpsApi(OPS_URL, CREATE, "admin", "test-pass");

    expect(result).toEqual({ action: "already-hub", id: "flair_already_hub" });
    expect(opsOf("insert")).toHaveLength(0);
    expect(opsOf("update")).toHaveLength(0);
  });

  it("two rows → refuses, naming both rows and the resolving command, writing nothing", async () => {
    mockOps([
      { id: "flair_spoke_row", role: "spoke", createdAt: "2026-09-02T00:00:00Z" },
      { id: "flair_hub_row", role: "hub", createdAt: "2026-09-03T00:00:00Z" },
    ]);

    const error = await reconcileFederationInstanceViaOpsApi(OPS_URL, CREATE, "admin", "test-pass").then(
      () => null,
      (err: unknown) => err as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("flair_spoke_row");
    expect(error?.message).toContain("flair_hub_row");
    expect(error?.message).toContain("role=spoke");
    expect(error?.message).toContain(INSTANCE_ROW_PRUNE_COMMAND);
    expect(opsOf("insert")).toHaveLength(0);
    expect(opsOf("update")).toHaveLength(0);
  });

  it("a row that appears while the insert is in flight is REPORTED, not claimed as success", async () => {
    // The read-then-insert window is real: `GET /FederationInstance`
    // find-or-creates a row. The re-read must name both rows and the remedy
    // instead of returning `created`.
    mockOps([]);
    raceOnSecondRead = [{ id: "flair_raced", role: "spoke", createdAt: "2026-09-24T00:00:00Z" }];

    const error = await reconcileFederationInstanceViaOpsApi(OPS_URL, CREATE, "admin", "test-pass").then(
      () => null,
      (err: unknown) => err as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(CREATE.instanceId);
    expect(error?.message).toContain("flair_raced");
    expect(error?.message).toContain(INSTANCE_ROW_PRUNE_COMMAND);
  });

  it("a row that appears while the role update is in flight is reported too", async () => {
    mockOps([{ id: "flair_existing", role: "spoke", publicKey: "peer-known-key" }]);
    raceOnSecondRead = [{ id: "flair_raced_update", role: "hub", createdAt: "2026-09-24T00:00:00Z" }];

    const error = await reconcileFederationInstanceViaOpsApi(OPS_URL, CREATE, "admin", "test-pass").then(
      () => null,
      (err: unknown) => err as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("flair_existing");
    expect(error?.message).toContain("flair_raced_update");
    expect(opsOf("insert")).toHaveLength(0);
  });

  it("an unreadable Instance table fails the command rather than guessing", async () => {
    mockOps([], { searchStatus: 500 });

    await expect(
      reconcileFederationInstanceViaOpsApi(OPS_URL, CREATE, "admin", "test-pass"),
    ).rejects.toThrow("Instance read via ops API failed (500)");
    expect(opsOf("insert")).toHaveLength(0);
  });
});
