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
  decideInstancePrune,
  decideSweepMode,
  formatAdvertisedIdentity,
  formatInstanceRow,
  INSTANCE_ROWS_SQL,
  INSTANCE_ROW_PRUNE_COMMAND,
  INSTANCE_ROW_PRUNE_REMEDY,
  instanceIdentitySummary,
  multipleInstanceRowsMessage,
  probeInstanceIdentity,
  prunePeerWarningLines,
  pruneInstanceRows,
  readAdvertisedInstanceIdentity,
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
    // flair#1883 round 2: the read used to carry `createdAt > "1970-01-01"`, so a
    // row with no createdAt (the schema does not require one) or one dated before
    // 1970 was invisible — and init then inserted a SECOND identity.
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

  it("a body that is not a list reports no rows, never a fabricated one", async () => {
    const { endpoint } = opsEndpointMock(() => jsonResponse({ ok: true }));
    expect(await readInstanceRows(endpoint)).toEqual([]);
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

// ─── the identity peers may have pinned (prune's warning) ────────────────────

describe("readAdvertisedInstanceIdentity", () => {
  it("reads GET /FederationInstance with admin auth and names the row it answers with", async () => {
    const calls: any[] = [];
    const fetchImpl = mock(async (url: string, init: any) => {
      calls.push({ url, init });
      return jsonResponse({ id: "flair_advertised", publicKey: "pinned-key", role: "hub" });
    }) as unknown as typeof fetch;

    const identity = await readAdvertisedInstanceIdentity("http://127.0.0.1:19925/", { user: "admin", pass: "pw" }, fetchImpl);

    expect(identity).toEqual({ id: "flair_advertised", publicKey: "pinned-key", role: "hub" });
    expect(calls[0].url).toBe("http://127.0.0.1:19925/FederationInstance");
    expect(calls[0].init.headers.Authorization).toBe("Basic " + Buffer.from("admin:pw").toString("base64"));
  });

  it("throws with the status when the read fails — never reports an identity it did not read", async () => {
    const fetchImpl = mock(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(
      readAdvertisedInstanceIdentity("http://127.0.0.1:19925", { user: "admin", pass: "pw" }, fetchImpl),
    ).rejects.toThrow("GET /FederationInstance failed (503)");
  });

  it("returns null when the response carries no id", async () => {
    const fetchImpl = mock(async () => jsonResponse({ role: "hub" })) as unknown as typeof fetch;
    expect(
      await readAdvertisedInstanceIdentity("http://127.0.0.1:19925", { user: "admin", pass: "pw" }, fetchImpl),
    ).toBeNull();
  });
});

describe("prunePeerWarningLines", () => {
  const advertised = { id: SPOKE_ROW.id, publicKey: "pinned-key", role: "spoke" };

  it("names the id and key peers may have pinned, and that they must re-pair when it is deleted", () => {
    const lines = prunePeerWarningLines({ advertised, advertisedFailure: null, drop: [SPOKE_ROW, HUB_ROW] });
    const joined = lines.join("\n");
    expect(joined).toContain(`id=${SPOKE_ROW.id}`);
    expect(joined).toContain("publicKey=pinned-key");
    expect(joined).toContain("GET /FederationInstance");
    expect(joined).toContain("must re-pair");
  });

  it("says the pinned row is kept when the deleted rows are not it", () => {
    const lines = prunePeerWarningLines({ advertised, advertisedFailure: null, drop: [HUB_ROW] });
    const joined = lines.join("\n");
    expect(joined).toContain(`id=${SPOKE_ROW.id}`);
    expect(joined).toContain("is not being deleted");
  });

  it("reports an unreadable identity as NOT determinable, and still warns", () => {
    const lines = prunePeerWarningLines({ advertised: null, advertisedFailure: "GET /FederationInstance failed (503)", drop: [HUB_ROW] });
    const joined = lines.join("\n");
    expect(joined).toContain("not determinable");
    expect(joined).toContain("503");
    expect(joined).toContain("must re-pair");
  });

  it("says nothing when nothing is dropped", () => {
    expect(prunePeerWarningLines({ advertised, advertisedFailure: null, drop: [] })).toEqual([]);
  });
});

describe("formatAdvertisedIdentity", () => {
  it("names the id and the key, and says (unknown) rather than printing a blank key", () => {
    expect(formatAdvertisedIdentity({ id: "flair_x", publicKey: "k" })).toBe("id=flair_x publicKey=k");
    expect(formatAdvertisedIdentity({ id: "flair_x", publicKey: null })).toBe("id=flair_x publicKey=(unknown)");
  });
});
