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
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { reconcileFederationInstanceViaOpsApi } from "../../src/cli";
import {
  INSTANCE_ROW_PRUNE_COMMAND,
  INSTANCE_ROWS_SQL,
  pruneInstanceRows,
  readAdvertisedInstanceIdentity,
  readInstanceRows,
  type InstanceIdentityRow,
  type OpsEndpoint,
} from "../../src/lib/instance-identity-row";

let harper: HarperInstance;
let endpoint: OpsEndpoint;
/** The shipped CLI (`dist/cli.js`), so the prune's printed output is the real one. */
const CLI = join(process.cwd(), "dist", "cli.js");
// The CLI child's OWN deadline (the spawn's `timeout:`), so a hung child is
// killed and reported BY NAME, with its output — not as a bare bun "timed out
// after 5000ms" that names neither the leg nor what it printed (flair#1807's
// class; scripts/ci/check-cli-spawn-budgets.mjs is the line).
const CHILD_DEADLINE_MS = 20_000;
// One budget for the prune case, not one per leg: it runs TWO CLI legs (dry run,
// then --apply) plus the live reads around them, so it needs 2 x the deadline
// plus margin — a shorter budget would kill the CASE before a leg's own deadline
// could fire and produce the named message.
const PRUNE_CASE_BUDGET_MS = 2 * CHILD_DEADLINE_MS + 15_000;

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

/** Run the shipped CLI with an isolated HOME; returns stdout+stderr+code. */
async function runCli(args: string[], home: string): Promise<{ code: number | null; out: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME: home,
        FLAIR_URL: harper.httpURL,
        FLAIR_TOKEN: "",
        FLAIR_ADMIN_PASS: "",
      },
      timeout: CHILD_DEADLINE_MS,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(
          new Error(
            `cli ${args.join(" ")} was killed by ${signal} at the ${CHILD_DEADLINE_MS}ms deadline. Output so far:\n${out}`,
          ),
        );
        return;
      }
      resolve({ code, out });
    });
  });
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

  test("a row the old date filter HID is read now — and reconciled, not duplicated", async () => {
    // The ops read used to carry `createdAt > "1970-01-01"` (a
    // search_by_conditions needs a condition, so the module had to name one).
    // That condition hides every row whose createdAt is not after 1970 — a date
    // before it, or a value that is not a date at all — and a row init cannot see
    // is a row init inserts a second identity beside. This is the live proof of
    // both halves: the old read returns nothing, the new read returns the row,
    // and the reconcile adopts that row instead of minting another.
    await clearInstanceRows();
    await insertRow({
      id: "flair_live_1969",
      publicKey: "key-1969",
      role: "spoke",
      status: "active",
      createdAt: "1969-07-20T00:00:00.000Z",
      updatedAt: "1969-07-20T00:00:00.000Z",
    });
    await insertRow({
      id: "flair_live_undated",
      publicKey: "key-undated",
      role: "spoke",
      status: "active",
      createdAt: "",
    });

    // The read the CLI used to send, run live against the same table: zero rows.
    const oldStyle = await ops({
      operation: "search_by_conditions",
      schema: "flair",
      table: "Instance",
      operator: "and",
      conditions: [
        { search_attribute: "createdAt", search_type: "greater_than", search_value: "1970-01-01" },
      ],
      get_attributes: ["id", "role", "publicKey", "status", "createdAt"],
    });
    expect(oldStyle).toEqual([]);

    // The read it sends now: both rows, on a real Harper.
    expect((await rows()).map((r) => r.id).sort()).toEqual(["flair_live_1969", "flair_live_undated"]);

    // `prune --keep` can name either row, whatever its createdAt (the ops read
    // is unconditional, so a row cannot be invisible to the command that is
    // supposed to resolve them).
    await expect(pruneInstanceRows(endpoint, "flair_live_undated")).resolves.toEqual({
      dropped: ["flair_live_1969"],
    });

    // With the one hidden-before row left, init ADOPTS it: the role update lands
    // on that row's id, and no second identity is inserted.
    const result = await reconcileFederationInstanceViaOpsApi(
      harper.opsURL,
      { instanceId: "flair_live_dupe", publicKey: "key-dupe" },
      harper.admin.username,
      harper.admin.password,
    );
    expect(result).toEqual({ action: "updated", id: "flair_live_undated" });
    const after = await rows();
    expect(after.map((r) => r.id)).toEqual(["flair_live_undated"]);
    expect(after[0].role).toBe("hub");

    // Sanity: the statement the CLI sends is the unconditional one.
    expect(INSTANCE_ROWS_SQL).not.toMatch(/where/i);
    await clearInstanceRows();
  }, 60_000);

  test("a second row present when init runs is REPORTED, not swallowed", async () => {
    // The read-then-insert window is real: `GET /FederationInstance`
    // find-or-creates a row, and init's writer cannot see one that did not exist
    // when it read. What it must never do is claim success over such a window
    // (the unit test drives the exact race with an injected second read): the
    // second row is named, with the remedy.
    await clearInstanceRows();
    const first = await reconcileFederationInstanceViaOpsApi(
      harper.opsURL,
      { instanceId: "flair_live_first", publicKey: "key-first" },
      harper.admin.username,
      harper.admin.password,
    );
    expect(first).toEqual({ action: "created", id: "flair_live_first" });

    // A row that appeared after the decision is what the refusal is for.
    await insertRow({
      id: "flair_live_raced",
      publicKey: "key-raced",
      role: "spoke",
      status: "active",
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
    });
    const error = await reconcileFederationInstanceViaOpsApi(
      harper.opsURL,
      { instanceId: "flair_live_third", publicKey: "key-third" },
      harper.admin.username,
      harper.admin.password,
    ).then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(INSTANCE_ROW_PRUNE_COMMAND);
    await clearInstanceRows();
  }, 60_000);

  test("GET /FederationInstance does not invent a second row while one exists", async () => {
    await clearInstanceRows();
    await insertRow({
      id: "flair_live_get",
      publicKey: "key-get",
      role: "spoke",
      status: "active",
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T00:00:00.000Z",
    });

    const res = await fetch(`${harper.httpURL.replace(/\/$/, "")}/FederationInstance`, {
      headers: { Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.id).toBe("flair_live_get");
    // The create branch ran on a SUCCESSFUL read of zero rows only.
    expect((await rows()).map((r) => r.id)).toEqual(["flair_live_get"]);
  }, 60_000);

  test("prune names the identity peers may have pinned, and the printed --apply form really deletes", async () => {
    // Two rows: the hub's identity (which the GET answers with) and a stray one.
    await clearInstanceRows();
    await insertRow({
      id: "flair_live_keep",
      publicKey: "key-keep",
      role: "spoke",
      status: "active",
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
    });
    await insertRow({
      id: "flair_live_stray",
      publicKey: "key-stray",
      role: "spoke",
      status: "active",
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
    });

    // Which row the hub answers GET /FederationInstance with is what a peer was
    // handed — read it the same way a peer does.
    const advertised = await readAdvertisedInstanceIdentity(harper.httpURL, {
      user: harper.admin.username,
      pass: harper.admin.password,
    });
    expect(advertised).not.toBeNull();
    expect(["flair_live_keep", "flair_live_stray"]).toContain(advertised!.id);

    const home = await mkdtemp(join(tmpdir(), "flair-1883-cli-"));
    try {
      const dry = await runCli(
        [
          "federation", "instance", "prune", "--keep", "flair_live_keep",
          "--target", harper.httpURL,
          "--ops-target", harper.opsURL,
          "--admin-user", harper.admin.username,
          "--admin-pass", harper.admin.password,
        ],
        home,
      );
      expect(dry.out).toContain("dry-run");
      expect(dry.out).toContain("flair_live_stray");
      // The pinned identity and the re-pair obligation, named.
      expect(dry.out).toContain(`id=${advertised!.id}`);
      expect(dry.out).toContain("GET /FederationInstance");
      expect(dry.out).toContain("re-pair");
      // A dry run deletes nothing.
      expect((await rows()).map((r) => r.id).sort()).toEqual(["flair_live_keep", "flair_live_stray"]);

      const applied = await runCli(
        [
          "federation", "instance", "prune", "--keep", "flair_live_keep", "--apply",
          "--target", harper.httpURL,
          "--ops-target", harper.opsURL,
          "--admin-user", harper.admin.username,
          "--admin-pass", harper.admin.password,
        ],
        home,
      );
      expect(applied.out).toContain("deleted 1 row(s)");
      expect(applied.out).toContain(`id=${advertised!.id}`);
      expect((await rows()).map((r) => r.id)).toEqual(["flair_live_keep"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    await clearInstanceRows();
  }, PRUNE_CASE_BUDGET_MS);
});
