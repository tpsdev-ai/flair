/**
 * `flair init --remote` against a REAL Harper (flair#1883).
 *
 * The unit tests mock the ops API, so they prove the requests we SEND. They
 * cannot prove Harper accepts them — a `search_by_conditions` on `flair.Instance`
 * or an `update` whose result we verify via `update_hashes` is only real when a
 * Harper answers it. This file runs the real reconcile against a spawned Harper
 * (HOME-isolated by the harness, and swept by `stopHarper`).
 *
 * The cases the issue names:
 *   - fresh            → one row, role === "hub"
 *   - re-run           → still one row, same id
 *   - an existing spoke row → the SAME row becomes the hub (id and key kept)
 *   - two rows         → refused, naming both, and nothing written
 *   - prune --keep     → the other row goes, one row left
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { reconcileFederationInstanceViaOpsApi } from "../../src/cli";
import {
  INSTANCE_ROW_PRUNE_COMMAND,
  pruneInstanceRows,
  readInstanceRows,
  type InstanceIdentityRow,
  type OpsEndpoint,
} from "../../src/lib/instance-identity-row";

let harper: HarperInstance;
let endpoint: OpsEndpoint;

async function ops(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${harper.opsURL.replace(/\/$/, "")}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops ${String(body.operation)} failed (${res.status}): ${await res.text()}`);
  return await res.json().catch(() => null);
}

async function rows(): Promise<InstanceIdentityRow[]> {
  return await readInstanceRows(endpoint);
}

/** Start each case from a known table: no Instance rows at all. */
async function clearInstanceRows(): Promise<void> {
  for (const row of await rows()) {
    await ops({ operation: "delete", database: "flair", table: "Instance", hash_values: [row.id] });
  }
}

async function insertRow(row: Record<string, unknown>): Promise<void> {
  await ops({ operation: "insert", database: "flair", table: "Instance", records: [row] });
}

describe("init --remote identity reconcile (live Harper)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    endpoint = {
      opsUrl: harper.opsURL,
      credentials: { user: harper.admin.username, pass: harper.admin.password },
    };
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test("fresh instance → creates ONE row with role hub", async () => {
    await clearInstanceRows();

    const result = await reconcileFederationInstanceViaOpsApi(
      harper.opsURL,
      { instanceId: "flair_live_fresh", publicKey: "live-fresh-key" },
      harper.admin.username,
      harper.admin.password,
    );

    expect(result).toEqual({ action: "created", id: "flair_live_fresh" });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("flair_live_fresh");
    expect(all[0].role).toBe("hub");
  }, 60_000);

  test("a re-run is a no-op: still one row, same id", async () => {
    await clearInstanceRows();
    await reconcileFederationInstanceViaOpsApi(
      harper.opsURL,
      { instanceId: "flair_live_rerun", publicKey: "live-rerun-key" },
      harper.admin.username,
      harper.admin.password,
    );

    const second = await reconcileFederationInstanceViaOpsApi(
      harper.opsURL,
      { instanceId: "flair_live_other_id", publicKey: "live-other-key" },
      harper.admin.username,
      harper.admin.password,
    );

    expect(second).toEqual({ action: "already-hub", id: "flair_live_rerun" });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("flair_live_rerun");
    expect(all[0].role).toBe("hub");
  }, 60_000);

  test("an existing spoke row becomes the hub, keeping its id and key", async () => {
    await clearInstanceRows();
    await insertRow({
      id: "flair_live_spoke",
      publicKey: "peer-known-key",
      role: "spoke",
      status: "active",
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
    });

    const result = await reconcileFederationInstanceViaOpsApi(
      harper.opsURL,
      { instanceId: "flair_live_never_used", publicKey: "never-used-key" },
      harper.admin.username,
      harper.admin.password,
    );

    expect(result).toEqual({ action: "updated", id: "flair_live_spoke" });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("flair_live_spoke");
    expect(all[0].role).toBe("hub");
    expect(all[0].publicKey).toBe("peer-known-key");
  }, 60_000);

  test("two rows → refused, naming both, and NOTHING is written", async () => {
    await clearInstanceRows();
    await insertRow({
      id: "flair_live_row_a",
      publicKey: "key-a",
      role: "spoke",
      status: "active",
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
    });
    await insertRow({
      id: "flair_live_row_b",
      publicKey: "key-b",
      role: "hub",
      status: "active",
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
    });

    const error = await reconcileFederationInstanceViaOpsApi(
      harper.opsURL,
      { instanceId: "flair_live_row_c", publicKey: "key-c" },
      harper.admin.username,
      harper.admin.password,
    ).then(
      () => null,
      (err: unknown) => err as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("flair_live_row_a");
    expect(error?.message).toContain("flair_live_row_b");
    expect(error?.message).toContain(INSTANCE_ROW_PRUNE_COMMAND);

    // Both rows survive, in their original roles: the refusal wrote nothing.
    const all = await rows();
    expect(all.map((r) => r.id).sort()).toEqual(["flair_live_row_a", "flair_live_row_b"]);
    expect(all.find((r) => r.id === "flair_live_row_a")?.role).toBe("spoke");
    expect(all.find((r) => r.id === "flair_live_row_b")?.role).toBe("hub");
  }, 60_000);

  test("prune --keep deletes the other row and leaves the kept one alone", async () => {
    // The two-row state the refused reconcile leaves behind.
    const before = await rows();
    expect(before).toHaveLength(2);

    const { dropped } = await pruneInstanceRows(endpoint, "flair_live_row_b");

    expect(dropped).toEqual(["flair_live_row_a"]);
    const after = await rows();
    expect(after.map((r) => r.id)).toEqual(["flair_live_row_b"]);
    expect(after[0].role).toBe("hub");
  }, 60_000);

  test("an unknown --keep id is refused, not silently treated as nothing to do", async () => {
    // Two rows: an id that names neither of them must be an error, because a
    // typo otherwise reads as a successful prune of the row the operator meant.
    await insertRow({
      id: "flair_live_extra",
      publicKey: "key-extra",
      role: "spoke",
      status: "active",
      createdAt: "2026-09-22T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:00.000Z",
    });

    await expect(pruneInstanceRows(endpoint, "flair_not_a_row")).rejects.toThrow("names no Instance row");

    // The refusal wrote nothing: both rows survive.
    expect((await rows()).map((r) => r.id).sort()).toEqual(["flair_live_extra", "flair_live_row_b"]);
    await clearInstanceRows();
  }, 60_000);
});
