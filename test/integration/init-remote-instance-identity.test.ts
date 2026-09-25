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
 *
 * Round 3 adds the two READERS, which still answered with the first row of an
 * unordered search: `GET /FederationInstance`, and the hub identity in the
 * `POST /FederationPair` response that a spoke pins. Both must REFUSE with two
 * rows, in either table order, and the pairing refusal must leave the one-time
 * token unconsumed and write no peer.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
// The CLI this file drives is BUILT here (flair#1898): `bun run build` does not
// emit dist/cli.js — `bun run build:cli` does — so a file that assumes a
// pre-built dist/cli.js fails as though the product were broken. `ensureCliBuild`
// is the same helper the CLI-spawning unit files use (`test/unit/workspace-set.test.ts`
// and its siblings): one bounded build per process, skipped when dist/cli.js is
// already fresh.
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { reconcileFederationInstanceViaOpsApi } from "../../src/cli";
import {
  INSTANCE_ROW_PRUNE_COMMAND,
  INSTANCE_ROWS_SQL,
  pruneInstanceRows,
  readInstanceRows,
  type InstanceIdentityRow,
  type OpsEndpoint,
} from "../../src/lib/instance-identity-row";

let harper: HarperInstance;
let endpoint: OpsEndpoint;
/**
 * The shipped CLI (`dist/cli.js`), so the prune's printed output is the real one.
 * Built by this file's own `beforeAll` (`ensureCliBuild`) — the file is
 * self-sufficient and does not depend on a build a prior test lane happened to
 * run.
 */
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

/** Every row a table holds, from the one ops read that can say "all". */
async function sqlRows(sql: string): Promise<any[]> {
  const parsed = await ops({ operation: "sql", sql });
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : null;
  if (rows === null) throw new Error(`sql read returned no row array: ${JSON.stringify(parsed)}`);
  return rows;
}

async function clearTable(table: string): Promise<void> {
  for (const row of await sqlRows(`SELECT id FROM flair.${table}`)) {
    await ops({ operation: "delete", database: "flair", table, hash_values: [row.id] });
  }
}

/** A one-time pairing token, minted the way `flair federation token` mints one. */
async function mintPairingToken(id: string): Promise<void> {
  await ops({
    operation: "insert",
    database: "flair",
    table: "PairingToken",
    records: [
      {
        id,
        createdBy: "admin",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: new Date().toISOString(),
      },
    ],
  });
}

/** A signed pairing request from a fresh spoke keypair — what a spoke sends. */
function spokePairBody(pairingToken: string): Record<string, unknown> {
  const kp = nacl.sign.keyPair();
  return signBodyFresh(
    {
      instanceId: `flair_live_spoke_${Buffer.from(nacl.randomBytes(4)).toString("hex")}`,
      publicKey: Buffer.from(kp.publicKey).toString("base64url"),
      role: "spoke",
      endpoint: "http://127.0.0.1:19999",
      pairingToken,
    },
    kp.secretKey,
  );
}

/** POST /FederationPair as a spoke: public endpoint, signed body, no auth header. */
async function postPair(body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${harper.httpURL.replace(/\/$/, "")}/FederationPair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
    // dist/cli.js is a build INPUT of this file's own cases (the prune cases spawn
    // it), so build it here rather than inheriting a dist/ that `bun run build`
    // alone does not produce. The build budget is the helper's own (90 s), inside
    // this hook's 240 s.
    ensureCliBuild();
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
    // That condition hides every row whose createdAt compares BELOW that string
    // — a date before 1970, an empty string — and a row init cannot see is a row
    // init inserts a second identity beside. This is the live proof of
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

  test("GET /FederationInstance REFUSES with two rows — both insertion orders — instead of answering one (flair#1883 round 3)", async () => {
    // Two writers can still leave two rows (an old install, or the
    // read-then-insert window). This GET used to report the first row
    // `search()` yielded, so the identity the instance ADVERTISED depended on the
    // table's own ordering. Both orderings are exercised live.
    const rowA = {
      id: "flair_live_get_a",
      publicKey: "key-a",
      role: "spoke",
      status: "active",
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
    };
    const rowB = {
      id: "flair_live_get_b",
      publicKey: "key-b",
      role: "hub",
      status: "active",
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
    };

    for (const order of [[rowA, rowB], [rowB, rowA]]) {
      await clearInstanceRows();
      for (const row of order) await insertRow(row);

      const res = await fetch(`${harper.httpURL.replace(/\/$/, "")}/FederationInstance`, {
        headers: { Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
      });

      expect(res.status).toBe(409);
      const body: any = await res.json();
      expect(body.error).toBe("multiple_instance_rows");
      // Every row is named, and the command that resolves them.
      expect(body.detail).toContain("flair_live_get_a");
      expect(body.detail).toContain("flair_live_get_b");
      expect(body.detail).toContain(INSTANCE_ROW_PRUNE_COMMAND);
      expect(body.detail).toContain("--apply");
      // Both rows survive: a refusal writes nothing.
      expect((await rows()).map((r) => r.id).sort()).toEqual(["flair_live_get_a", "flair_live_get_b"]);
    }

    await clearInstanceRows();
  }, 60_000);

  test("POST /FederationPair REFUSES with two rows: the token stays unconsumed and NO peer is written (flair#1883 round 3)", async () => {
    // A spoke PINS what this response hands it. The response used to be read
    // AFTER the token was consumed and the peer written, so a hub with two rows
    // burned a one-time token, recorded the peer, and then answered with
    // whichever row the search yielded first. The check now comes first.
    const rowA = {
      id: "flair_live_pair_a",
      publicKey: "key-a",
      role: "spoke",
      status: "active",
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
    };
    const rowB = {
      id: "flair_live_pair_b",
      publicKey: "key-b",
      role: "hub",
      status: "active",
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
    };

    await clearTable("Peer");
    await clearTable("PairingToken");

    for (const order of [[rowA, rowB], [rowB, rowA]]) {
      await clearInstanceRows();
      for (const row of order) await insertRow(row);

      const token = `pair-token-live-${order[0].id.slice(-1)}`;
      await mintPairingToken(token);

      const res = await postPair(spokePairBody(token));

      expect(res.status).toBe(409);
      const text = await res.text();
      const body: any = JSON.parse(text);
      expect(body.error).toBe("multiple_instance_rows");
      expect(body.detail).toContain(INSTANCE_ROW_PRUNE_COMMAND);
      // A public route, refusing before the token or key check: no row in the answer.
      expect(Object.keys(body).sort()).toEqual(["detail", "error"]);
      expect(text).not.toContain("flair_live_pair_a");
      expect(text).not.toContain("flair_live_pair_b");

      // The refusal ran BEFORE the token was consumed...
      const tokenRow = (await sqlRows("SELECT id, consumedBy FROM flair.PairingToken")).find((r) => r.id === token);
      expect(tokenRow).toBeTruthy();
      expect(tokenRow.consumedBy ?? null).toBeNull();
      // ...and before any peer was recorded from a pairing that did not happen.
      expect(await sqlRows("SELECT id FROM flair.Peer")).toEqual([]);

      await ops({ operation: "delete", database: "flair", table: "PairingToken", hash_values: [token] });
    }

    await clearInstanceRows();
  }, 60_000);

  test("prune warns that ANY deleted row may be the identity a peer pinned, and the printed --apply form really deletes", async () => {
    // Two rows: the kept identity and a stray one.
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
      // The pinned identity is the POST /FederationPair response — a row it cannot
      // know which of — so the warning says exactly that, and does NOT name one row
      // as "the identity peers pinned" (flair#1883 round 3).
      expect(dry.out).toContain("POST /FederationPair");
      expect(dry.out).toContain("Any of the 1 row(s) being deleted may be the identity a paired peer pinned");
      expect(dry.out).toContain("re-pair");
      expect(dry.out).not.toContain("GET /FederationInstance");
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
      expect(applied.out).toContain("Any of the 1 row(s) being deleted may be the identity a paired peer pinned");
      expect((await rows()).map((r) => r.id)).toEqual(["flair_live_keep"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    await clearInstanceRows();
  }, PRUNE_CASE_BUDGET_MS);
});
