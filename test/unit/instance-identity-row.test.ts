/**
 * Unit tests for the ONE canonical Instance identity row (flair#1883).
 *
 * The decisions are pure functions over the rows, so every branch is asserted
 * here directly: what a hub's `init --remote` must do (create / set the one
 * row's role / no-op / refuse), what the cleanup sweep must conclude, which
 * rows `prune --keep` deletes, and what doctor must report (see
 * doctor-instance-identity.test.ts for the findings).
 *
 * The ops-API helpers run against an injected fetch, so the request body — the
 * thing Harper actually obeys — is asserted, not just the return value.
 */

import { describe, it, expect, mock } from "bun:test";
import {
  canonicalInstanceRole,
  decideHubReconcile,
  decideInstanceAnswer,
  decideInstancePrune,
  decideSweepMode,
  deleteInstanceRow,
  formatInstanceRow,
  INSTANCE_ROWS_SQL,
  INSTANCE_ROW_PRUNE_COMMAND,
  INSTANCE_ROW_PRUNE_REMEDY,
  instanceIdentitySummary,
  multipleInstanceRowsMessage,
  probeInstanceIdentity,
  prunePeerWarningLines,
  pruneInstanceRows,
  readableInstanceRows,
  readInstanceRows,
  readRoleNames,
  updateInstanceRole,
  usableInstanceRows,
  type InstanceIdentityRow,
  type OpsEndpoint,
} from "../../src/lib/instance-identity-row.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const HUB_ROW: InstanceIdentityRow = {
  id: "flair_aaaaaaaa",
  role: "hub",
  publicKey: "hub-key",
  createdAt: "2026-09-01T00:00:00.000Z",
};

const SPOKE_ROW: InstanceIdentityRow = {
  id: "flair_bbbbbbbb",
  role: "spoke",
  publicKey: "spoke-key",
  createdAt: "2026-09-02T00:00:00.000Z",
};

const SECOND_HUB_ROW: InstanceIdentityRow = {
  id: "flair_cccccccc",
  role: "hub",
  publicKey: "second-key",
  createdAt: "2026-09-03T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface OpsCall {
  url: string;
  body: any;
  headers: Record<string, string>;
}

function opsEndpointMock(
  handler: (body: any) => Response | Promise<Response>,
): { endpoint: OpsEndpoint; calls: OpsCall[] } {
  const calls: OpsCall[] = [];
  const fetchImpl = mock(async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers ?? {} });
    return await handler(body);
  });
  return {
    endpoint: {
      opsUrl: "http://127.0.0.1:19925",
      credentials: { user: "admin", pass: "test-pass" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    },
    calls,
  };
}

// ─── classify helpers ────────────────────────────────────────────────────────

describe("usableInstanceRows / formatInstanceRow / canonicalInstanceRole", () => {
  it("drops rows with no usable id and keeps the rest in read order", () => {
    const rows = [HUB_ROW, { id: "" } as InstanceIdentityRow, { id: "x" } as InstanceIdentityRow];
    expect(usableInstanceRows(rows).map((r) => r.id)).toEqual([HUB_ROW.id, "x"]);
  });

  it("treats a missing or non-array row list as empty", () => {
    expect(usableInstanceRows(null)).toEqual([]);
    expect(usableInstanceRows(undefined)).toEqual([]);
  });

  it("names every field, and never prints an empty role or date as blank", () => {
    expect(formatInstanceRow(HUB_ROW)).toBe(
      `id=flair_aaaaaaaa role=hub createdAt=2026-09-01T00:00:00.000Z`,
    );
    expect(formatInstanceRow({ id: "flair_x", role: null, createdAt: null })).toBe(
      "id=flair_x role=(none) createdAt=(unknown)",
    );
  });

  it("has a canonical role only when exactly one row exists", () => {
    expect(canonicalInstanceRole([HUB_ROW])).toBe("hub");
    expect(canonicalInstanceRole([])).toBeNull();
    expect(canonicalInstanceRole([HUB_ROW, SPOKE_ROW])).toBeNull();
  });

  it("normalises case and surrounding space in the role", () => {
    expect(canonicalInstanceRole([{ ...SPOKE_ROW, role: "  HUB " }])).toBe("hub");
  });
});

// ─── init --remote: reconcile ────────────────────────────────────────────────

describe("decideHubReconcile", () => {
  it("no row → create", () => {
    expect(decideHubReconcile([])).toEqual({ kind: "create" });
    expect(decideHubReconcile(null)).toEqual({ kind: "create" });
  });

  it("one row already hub → already-hub (a re-run writes nothing)", () => {
    expect(decideHubReconcile([HUB_ROW])).toEqual({ kind: "already-hub", id: HUB_ROW.id });
  });

  it("one spoke row → update that row's role, keeping its id", () => {
    expect(decideHubReconcile([SPOKE_ROW])).toEqual({ kind: "update-role", id: SPOKE_ROW.id });
  });

  it("a row whose role is missing is not a hub either", () => {
    expect(decideHubReconcile([{ id: "flair_norole", role: null }])).toEqual({
      kind: "update-role",
      id: "flair_norole",
    });
  });

  it("two rows → refuse, naming both", () => {
    const decision = decideHubReconcile([SPOKE_ROW, HUB_ROW]);
    expect(decision.kind).toBe("refuse-multiple");
    if (decision.kind === "refuse-multiple") {
      expect(decision.rows.map((r) => r.id)).toEqual([SPOKE_ROW.id, HUB_ROW.id]);
    }
  });

  it("role comparison ignores case/space, so \"Hub\" is a hub", () => {
    expect(decideHubReconcile([{ ...HUB_ROW, role: " Hub " }]).kind).toBe("already-hub");
  });
});

// ─── answering with one identity (the readers) ───────────────────────────────

describe("decideInstanceAnswer", () => {
  it("no rows → none: the one state a reader may create an identity from", () => {
    expect(decideInstanceAnswer([])).toEqual({ kind: "none" });
    expect(decideInstanceAnswer(null)).toEqual({ kind: "none" });
  });

  it("exactly one row → that row, whatever its role", () => {
    expect(decideInstanceAnswer([HUB_ROW])).toEqual({ kind: "answer", row: HUB_ROW });
    expect(decideInstanceAnswer([SPOKE_ROW])).toEqual({ kind: "answer", row: SPOKE_ROW });
  });

  it("two rows → a refusal naming BOTH, in either table order", () => {
    // The defect was order-dependence, so the same two rows are fed both ways.
    for (const order of [[HUB_ROW, SPOKE_ROW], [SPOKE_ROW, HUB_ROW]] as const) {
      const decision = decideInstanceAnswer([...order]);
      expect(decision.kind).toBe("refuse-multiple");
      if (decision.kind !== "refuse-multiple") throw new Error("unreachable");
      expect(decision.rows.map((r) => r.id)).toEqual(order.map((r) => r.id));
    }
  });

  it("never picks one row when three exist", () => {
    const decision = decideInstanceAnswer([HUB_ROW, SPOKE_ROW, SECOND_HUB_ROW]);
    expect(decision.kind).toBe("refuse-multiple");
    if (decision.kind !== "refuse-multiple") throw new Error("unreachable");
    expect(decision.rows).toHaveLength(3);
  });

  it("ignores rows with no usable id, so a blank row cannot fake a refusal", () => {
    expect(decideInstanceAnswer([HUB_ROW, { id: "" } as InstanceIdentityRow])).toEqual({
      kind: "answer",
      row: HUB_ROW,
    });
  });
});

describe("INSTANCE_ROW_PRUNE_REMEDY", () => {
  it("names the command, the placeholder and BOTH forms — a dry run deletes nothing", () => {
    expect(INSTANCE_ROW_PRUNE_REMEDY).toContain(INSTANCE_ROW_PRUNE_COMMAND);
    expect(INSTANCE_ROW_PRUNE_REMEDY).toContain("--keep <id>");
    expect(INSTANCE_ROW_PRUNE_REMEDY).toContain("dry run");
    expect(INSTANCE_ROW_PRUNE_REMEDY).toContain("--apply");
  });
});

describe("multipleInstanceRowsMessage", () => {
  it("names each row's id, role and creation time, and the resolving command", () => {
    const message = multipleInstanceRowsMessage([SPOKE_ROW, HUB_ROW]);
    expect(message).toContain(SPOKE_ROW.id);
    expect(message).toContain(HUB_ROW.id);
    expect(message).toContain(SPOKE_ROW.createdAt!);
    expect(message).toContain("role=spoke");
    expect(message).toContain(INSTANCE_ROW_PRUNE_COMMAND);
    expect(message).toContain("--keep <id>");
    // The remedy must be the form that DELETES, or name the one that does.
    expect(message).toContain("--apply");
  });
});

// ─── cleanup sweep mode ──────────────────────────────────────────────────────

describe("decideSweepMode", () => {
  it("one hub row → hub", () => {
    expect(decideSweepMode([HUB_ROW])).toBe("hub");
  });

  it("one spoke row → not-hub", () => {
    expect(decideSweepMode([SPOKE_ROW])).toBe("not-hub");
  });

  it("no rows → not-hub (a hub whose row has not been written yet)", () => {
    expect(decideSweepMode([])).toBe("not-hub");
  });

  it("a failed read is unreadable, never a spoke", () => {
    expect(decideSweepMode(null)).toBe("unreadable");
  });

  it("two rows → multiple, never \"first row wins\"", () => {
    expect(decideSweepMode([HUB_ROW, SPOKE_ROW])).toBe("multiple");
    expect(decideSweepMode([SPOKE_ROW, HUB_ROW])).toBe("multiple");
  });

  it("a later-written hub row is a hub (the role is re-read, not remembered)", () => {
    expect(decideSweepMode([])).toBe("not-hub");
    expect(decideSweepMode([HUB_ROW])).toBe("hub");
  });
});

// ─── prune --keep ────────────────────────────────────────────────────────────

describe("decideInstancePrune", () => {
  it("keeps the named row and drops the others", () => {
    const decision = decideInstancePrune([HUB_ROW, SPOKE_ROW, SECOND_HUB_ROW], SPOKE_ROW.id);
    expect(decision.kind).toBe("keep");
    if (decision.kind === "keep") {
      expect(decision.keep.id).toBe(SPOKE_ROW.id);
      expect(decision.drop.map((r) => r.id)).toEqual([HUB_ROW.id, SECOND_HUB_ROW.id]);
    }
  });

  it("an id that names no row is refused, not silently \"nothing\"", () => {
    const decision = decideInstancePrune([HUB_ROW, SPOKE_ROW], "flair_typo");
    expect(decision.kind).toBe("unknown-id");
  });

  it("a single row that IS the kept row is nothing to do", () => {
    expect(decideInstancePrune([HUB_ROW], HUB_ROW.id)).toEqual({ kind: "nothing" });
  });

  it("an id naming no row is refused at EVERY row count — one row, or none", () => {
    // A typo must not read as a successful prune of the row the operator meant
    // to keep, and "there is only one row anyway" is not a reason to accept it.
    expect(decideInstancePrune([HUB_ROW], "flair_typo")).toEqual({
      kind: "unknown-id",
      rows: [HUB_ROW],
    });
    expect(decideInstancePrune([], "flair_typo")).toEqual({ kind: "unknown-id", rows: [] });
  });
});

// ─── doctor's summary line ──────────────────────────────────────────────────

describe("instanceIdentitySummary", () => {
  it("describes a consistent instance as one row with its role", () => {
    expect(instanceIdentitySummary({ rows: [HUB_ROW], roleNames: [] })).toEqual({
      level: "ok",
      text: "one row, role=hub",
    });
  });

  it("describes an instance with no identity row", () => {
    expect(instanceIdentitySummary({ rows: [], roleNames: [] })).toEqual({ level: "ok", text: "no rows" });
  });

  it("an unreadable role list is UNVERIFIED, not a pass, and keeps the row facts", () => {
    // The rows were read, so they are reported; the pairing-role check did not
    // run, so it must not read as green.
    const summary = instanceIdentitySummary({ rows: [HUB_ROW], roleNames: null });
    expect(summary.level).toBe("unverified");
    expect(summary.text).toContain("one row, role=hub");
    expect(summary.text).toContain("UNVERIFIED");
    expect(summary.text).toContain("pairing-role check");
  });
});

// ─── ops-API helpers ─────────────────────────────────────────────────────────

describe("readInstanceRows", () => {
  it("reads EVERY row: one unconditional statement, no condition a row can fall outside of", async () => {
    // flair#1883 round 2: the read used to carry `createdAt > "1970-01-01"`, so
    // every row whose createdAt compares BELOW that string (a date before 1970,
    // an empty string) was invisible — and init then inserted a SECOND identity.
    // (`createdAt` is REQUIRED by the schema — `createdAt: String! @indexed` — so
    // no legal row omits it.)
    const { endpoint, calls } = opsEndpointMock(() => jsonResponse([SPOKE_ROW, HUB_ROW]));

    const rows = await readInstanceRows(endpoint);

    expect(rows.map((r) => r.id)).toEqual([SPOKE_ROW.id, HUB_ROW.id]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:19925/");
    expect(calls[0].body.operation).toBe("sql");
    expect(calls[0].body.sql).toBe(INSTANCE_ROWS_SQL);
    expect(calls[0].body.sql).not.toMatch(/where/i);
    expect(calls[0].body.sql).toContain("flair.Instance");
    for (const attribute of ["id", "role", "publicKey", "status", "createdAt"]) {
      expect(calls[0].body.sql).toContain(attribute);
    }
    // No condition object at all — the search_by_conditions shape is gone.
    expect(calls[0].body.conditions).toBeUndefined();
  });

  it("keeps a row that carries no createdAt, and one dated before 1970", async () => {
    const noCreatedAt = { id: "flair_nodate", role: "hub" };
    const oldRow = { id: "flair_1969", role: "spoke", createdAt: "1969-12-31T23:59:59.000Z" };
    const { endpoint } = opsEndpointMock(() => jsonResponse([noCreatedAt, oldRow]));

    const rows = await readInstanceRows(endpoint);

    expect(rows.map((r) => r.id)).toEqual(["flair_nodate", "flair_1969"]);
    expect(rows[0].createdAt).toBeUndefined();
  });

  it("reads a row whose id is the only thing it carries (a row the old filter hid)", async () => {
    // The row shapes the filter used to hide, in the rawest form the reader can
    // see them: no createdAt at all, and an EMPTY string (which compares below
    // "1970-01-01").
    const { endpoint } = opsEndpointMock(() =>
      jsonResponse([{ id: "flair_bare", role: "spoke" }, { id: "flair_blank", createdAt: "" }]),
    );
    expect((await readInstanceRows(endpoint)).map((r) => r.id)).toEqual(["flair_bare", "flair_blank"]);
  });

  it("sends Basic auth when credentials are configured", async () => {
    const { endpoint, calls } = opsEndpointMock(() => jsonResponse([]));
    await readInstanceRows(endpoint);
    expect(calls[0].headers.Authorization).toBe(
      "Basic " + Buffer.from("admin:test-pass").toString("base64"),
    );
  });

  it("sends no Authorization header when the caller has no credential", async () => {
    const { endpoint, calls } = opsEndpointMock(() => jsonResponse([]));
    await readInstanceRows({ ...endpoint, credentials: undefined });
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it("tolerates a wrapped response envelope", async () => {
    const { endpoint } = opsEndpointMock(() => jsonResponse({ results: [HUB_ROW] }));
    expect((await readInstanceRows(endpoint)).map((r) => r.id)).toEqual([HUB_ROW.id]);
  });

  it("throws on a non-ok response rather than reporting zero rows", async () => {
    const { endpoint } = opsEndpointMock(() => new Response("nope", { status: 403 }));
    await expect(readInstanceRows(endpoint)).rejects.toThrow("Instance read via ops API failed (403)");
  });

  it("throws on an unparseable 200 rather than reporting zero rows (flair#1883 round 3)", async () => {
    // The old contract: `[].` A read that established nothing then licensed
    // creating an identity, which is the whole defect.
    const { endpoint } = opsEndpointMock(() => new Response("<html>gateway</html>", { status: 200 }));
    await expect(readInstanceRows(endpoint)).rejects.toThrow("UNREADABLE");
  });

  it("throws on a 200 whose body is not a row list, never reports no rows", async () => {
    // This test used to codify `[]` — the fallback that made a malformed read
    // look like an instance with no identity. It now codifies the refusal.
    const { endpoint } = opsEndpointMock(() => jsonResponse({ ok: true }));
    await expect(readInstanceRows(endpoint)).rejects.toThrow("Instance read via ops API answered 200");
  });

  it("throws when the envelope carries no results array either", async () => {
    const { endpoint } = opsEndpointMock(() => jsonResponse({ results: null }));
    await expect(readInstanceRows(endpoint)).rejects.toThrow("UNREADABLE");
  });

  // ─── a malformed row is not a missing row (flair#1883 round 4) ──────
  //
  // `usableInstanceRows` DROPS an entry without a usable id, so a body like
  // `[{}]` or `{results: [null]}` came back as `[]` — the same value a
  // successful read of zero rows returns. `flair init --remote` then created an
  // identity on a read that never established the table, and `flair doctor`
  // printed "no rows" for a table it only part saw. The read is UNREADABLE
  // instead: the failed-read path.
  const MALFORMED_BODIES: Array<[label: string, body: unknown]> = [
    ["an entry that is an empty object", [{}]],
    ["a null entry inside the results envelope", { results: [null] }],
    ["a good row followed by an unnameable one", [HUB_ROW, {}]],
    ["an unnameable row followed by a good one", [{}, HUB_ROW]],
    ["an entry whose id is empty", [{ id: "" }]],
    ["an entry whose id is not a string", [{ id: 42 }]],
  ];

  for (const [label, body] of MALFORMED_BODIES) {
    it(`refuses a 200 carrying ${label} — UNREADABLE, never the rows it could name`, async () => {
      const { endpoint } = opsEndpointMock(() => jsonResponse(body));

      await expect(readInstanceRows(endpoint)).rejects.toThrow("UNREADABLE");
    });
  }

  it("names the position of the first row it cannot use", async () => {
    const { endpoint } = opsEndpointMock(() => jsonResponse([HUB_ROW, {}, SPOKE_ROW]));
    await expect(readInstanceRows(endpoint)).rejects.toThrow("row 2 of 3");
  });

  it("a successful 200 of zero rows is still zero rows — the one state that may create", async () => {
    const { endpoint } = opsEndpointMock(() => jsonResponse([]));
    expect(await readInstanceRows(endpoint)).toEqual([]);
  });
});

describe("readableInstanceRows — every entry of a completed read, or an unreadable read", () => {
  it("returns every nameable entry, in order, untouched", () => {
    const rows = readableInstanceRows([HUB_ROW, { id: "flair_bare", role: "spoke" }]);
    expect(rows.map((r) => r.id)).toEqual([HUB_ROW.id, "flair_bare"]);
  });

  it("throws — naming the position — for the first entry without a usable id", () => {
    expect(() => readableInstanceRows([HUB_ROW, null, SPOKE_ROW])).toThrow("row 2 of 3");
  });

  it("an empty read is a successful read of zero rows, not a refusal", () => {
    expect(readableInstanceRows([])).toEqual([]);
  });
});

describe("readRoleNames", () => {
  it("returns role names from both the string and the object shape", async () => {
    const { endpoint } = opsEndpointMock(() =>
      jsonResponse([{ role: "flair_pair_initiator" }, "flair_agent"]),
    );
    expect(await readRoleNames(endpoint)).toEqual(["flair_pair_initiator", "flair_agent"]);
  });

  it("returns null (unverified) when the read fails", async () => {
    const { endpoint } = opsEndpointMock(() => new Response("boom", { status: 500 }));
    expect(await readRoleNames(endpoint)).toBeNull();
  });
});

describe("updateInstanceRole", () => {
  it("updates the row's role and keeps the id", async () => {
    const { endpoint, calls } = opsEndpointMock(() =>
      jsonResponse({ update_hashes: [HUB_ROW.id], skipped_hashes: [] }),
    );

    await updateInstanceRole(endpoint, HUB_ROW.id, "hub");

    expect(calls[0].body.operation).toBe("update");
    expect(calls[0].body.table).toBe("Instance");
    expect(calls[0].body.records[0].id).toBe(HUB_ROW.id);
    expect(calls[0].body.records[0].role).toBe("hub");
    // The key is NOT part of the write: peers know this identity.
    expect(calls[0].body.records[0].publicKey).toBeUndefined();
  });

  it("refuses when the ops API reports the row was skipped (HTTP 200 is not success)", async () => {
    const { endpoint } = opsEndpointMock(() =>
      jsonResponse({ update_hashes: [], skipped_hashes: [HUB_ROW.id] }),
    );
    await expect(updateInstanceRole(endpoint, HUB_ROW.id, "hub")).rejects.toThrow("changed no row");
  });

  it("refuses when no update result is reported at all", async () => {
    const { endpoint } = opsEndpointMock(() => jsonResponse({ ok: true }));
    await expect(updateInstanceRole(endpoint, HUB_ROW.id, "hub")).rejects.toThrow("changed no row");
  });
});

describe("probeInstanceIdentity", () => {
  it("returns rows and role names on a healthy instance", async () => {
    const { endpoint } = opsEndpointMock((body) =>
      body.operation === "sql"
        ? jsonResponse([HUB_ROW])
        : jsonResponse([{ role: "flair_pair_initiator" }]),
    );

    const probe = await probeInstanceIdentity(endpoint);

    expect(probe.rows?.map((r) => r.id)).toEqual([HUB_ROW.id]);
    expect(probe.roleNames).toEqual(["flair_pair_initiator"]);
  });

  it("reports rows:null when the table read fails, and still tries the roles read", async () => {
    const { endpoint, calls } = opsEndpointMock((body) =>
      body.operation === "sql" ? new Response("no", { status: 500 }) : jsonResponse([]),
    );

    const probe = await probeInstanceIdentity(endpoint);

    expect(probe.rows).toBeNull();
    expect(probe.roleNames).toEqual([]);
    expect(calls.map((c) => c.body.operation)).toEqual(["sql", "list_roles"]);
  });

  it("reports rows:null for a 200 with an unnameable row — doctor renders UNVERIFIED, not 'no rows'", async () => {
    // `flair doctor` branches on `probe.rows === null` and prints "Instance
    // identity: UNVERIFIED (could not read the Instance table via the ops API)".
    // A malformed row must land THERE, not in the "no rows" summary line a
    // successful read of zero rows produces (flair#1883 round 4).
    const { endpoint } = opsEndpointMock((body) =>
      body.operation === "sql" ? jsonResponse([{ id: "" }]) : jsonResponse([]),
    );

    const probe = await probeInstanceIdentity(endpoint);

    expect(probe.rows).toBeNull();
    expect(probe.roleNames).toEqual([]);
  });
});

describe("pruneInstanceRows", () => {
  it("deletes every row except the kept one and reports what went", async () => {
    const { endpoint, calls } = opsEndpointMock((body) =>
      body.operation === "sql"
        ? jsonResponse([HUB_ROW, SPOKE_ROW, SECOND_HUB_ROW])
        : jsonResponse({ deleted_hashes: body.hash_values }),
    );

    const { dropped } = await pruneInstanceRows(endpoint, HUB_ROW.id);

    expect(dropped).toEqual([SPOKE_ROW.id, SECOND_HUB_ROW.id]);
    const deletes = calls.filter((c) => c.body.operation === "delete");
    expect(deletes.map((c) => c.body.hash_values)).toEqual([[SPOKE_ROW.id], [SECOND_HUB_ROW.id]]);
    expect(deletes.every((c) => c.body.table === "Instance")).toBe(true);
    // The kept row is never deleted.
    expect(deletes.some((c) => c.body.hash_values.includes(HUB_ROW.id))).toBe(false);
  });

  it("refuses an unknown --keep id and writes nothing", async () => {
    const { endpoint, calls } = opsEndpointMock(() => jsonResponse([HUB_ROW, SPOKE_ROW]));

    await expect(pruneInstanceRows(endpoint, "flair_typo")).rejects.toThrow("names no Instance row");

    expect(calls.some((c) => c.body.operation === "delete")).toBe(false);
  });

  it("refuses an unknown --keep id even when there is at most one row", async () => {
    const { endpoint, calls } = opsEndpointMock(() => jsonResponse([HUB_ROW]));

    await expect(pruneInstanceRows(endpoint, "flair_typo")).rejects.toThrow("names no Instance row");

    expect(calls.some((c) => c.body.operation === "delete")).toBe(false);
  });

  it("does nothing when the only row IS the kept row", async () => {
    const { endpoint, calls } = opsEndpointMock(() => jsonResponse([HUB_ROW]));
    const { dropped } = await pruneInstanceRows(endpoint, HUB_ROW.id);
    expect(dropped).toEqual([]);
    expect(calls.some((c) => c.body.operation === "delete")).toBe(false);
  });
});

describe("deleteInstanceRow — HTTP 200 is not success", () => {
  it("sends the hash_values list Harper requires and accepts a reported deletion", async () => {
    const { endpoint, calls } = opsEndpointMock(() =>
      jsonResponse({ deleted_hashes: [HUB_ROW.id], skipped_hashes: [] }),
    );

    await deleteInstanceRow(endpoint, HUB_ROW.id);

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      operation: "delete",
      database: "flair",
      table: "Instance",
      hash_values: [HUB_ROW.id],
    });
  });

  it("refuses a 200 whose deleted_hashes does not name the id, and names what was skipped", async () => {
    // Harper can answer 200 and still skip the row (the contract
    // `updateInstanceRole` already checks). The skipped id here is NOT the id we
    // asked to delete, so it can only reach the message through skipped_hashes.
    const { endpoint } = opsEndpointMock(() =>
      jsonResponse({ deleted_hashes: [SECOND_HUB_ROW.id], skipped_hashes: [HUB_ROW.id] }),
    );

    const err = (await deleteInstanceRow(endpoint, HUB_ROW.id).catch((e) => e as Error)) as Error;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("removed no row");
    expect(err.message).toContain("skipped: flair_aaaaaaaa");
  });

  it("refuses a 200 that reports no delete result at all", async () => {
    const { endpoint } = opsEndpointMock(() => jsonResponse({ ok: true }));

    const err = (await deleteInstanceRow(endpoint, HUB_ROW.id).catch((e) => e as Error)) as Error;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("removed no row");
    expect(err.message).toContain("skipped: unknown");
  });

  it("prune reports only rows it deleted: a 200 that skips a row is an error, never a 'deleted' line", async () => {
    // End to end through the command the operator runs: `prune --apply` must not
    // print a row the ops API did not actually delete (flair#1883 round 5).
    const { endpoint } = opsEndpointMock((body) =>
      body.operation === "sql"
        ? jsonResponse([HUB_ROW, SPOKE_ROW, SECOND_HUB_ROW])
        : jsonResponse({
            deleted_hashes: body.hash_values.filter((h: string) => h !== SECOND_HUB_ROW.id),
            skipped_hashes: body.hash_values.filter((h: string) => h === SECOND_HUB_ROW.id),
          }),
    );

    const err = (await pruneInstanceRows(endpoint, HUB_ROW.id).catch((e) => e as Error)) as Error;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(SECOND_HUB_ROW.id);
    expect(err.message).toContain("removed no row");
  });
});

// ─── the prune's warning (a peer's identity may be one of the deleted rows) ───

describe("prunePeerWarningLines", () => {
  it("says plainly that ANY deleted row may be the identity a peer pinned, and that those peers must re-pair", () => {
    const joined = prunePeerWarningLines({ drop: [SPOKE_ROW, HUB_ROW] }).join("\n");
    expect(joined).toContain("POST /FederationPair");
    expect(joined).toContain("Any of the 2 row(s) being deleted may be the identity a paired peer pinned");
    expect(joined).toContain("must re-pair");
    // HISTORICAL, not present tense (flair#1883 round 4): with several rows the
    // pair response is a 409 now, so the warning is about peers that paired
    // BEFORE the fix, while the response still was the first row of the search.
    expect(joined).toContain("While the table held more than one Instance row, that response was whichever row");
    expect(joined).not.toMatch(/that response is whichever/);
  });

  it("never names a row as the one a peer pinned, and never claims to know", () => {
    // Round 2 named "the row this hub answers GET /FederationInstance with" as the
    // identity peers pinned. That is the guess this warning must not make: with
    // several rows the GET refuses, and a peer was handed the PAIR response.
    const joined = prunePeerWarningLines({ drop: [SPOKE_ROW, HUB_ROW] }).join("\n");
    expect(joined).not.toContain("GET /FederationInstance");
    expect(joined).not.toContain("pinned this instance's identity as");
    expect(joined).not.toContain("is not being deleted");
    expect(joined).toContain("cannot be determined here");
  });

  it("counts the rows it is about to delete", () => {
    expect(prunePeerWarningLines({ drop: [HUB_ROW] }).join("\n")).toContain("Any of the 1 row(s)");
    expect(prunePeerWarningLines({ drop: [HUB_ROW, SPOKE_ROW, SECOND_HUB_ROW] }).join("\n")).toContain(
      "Any of the 3 row(s)",
    );
  });

  it("says nothing when nothing is dropped", () => {
    expect(prunePeerWarningLines({ drop: [] })).toEqual([]);
  });
});
