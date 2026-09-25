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
  formatInstanceRow,
  INSTANCE_ROW_PRUNE_COMMAND,
  multipleInstanceRowsMessage,
  probeInstanceIdentity,
  pruneInstanceRows,
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

describe("multipleInstanceRowsMessage", () => {
  it("names each row's id, role and creation time, and the resolving command", () => {
    const message = multipleInstanceRowsMessage([SPOKE_ROW, HUB_ROW]);
    expect(message).toContain(SPOKE_ROW.id);
    expect(message).toContain(HUB_ROW.id);
    expect(message).toContain(SPOKE_ROW.createdAt!);
    expect(message).toContain("role=spoke");
    expect(message).toContain(INSTANCE_ROW_PRUNE_COMMAND);
    expect(message).toContain("--keep <id>");
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

  it("an id naming no row when there is at most one row is nothing to do", () => {
    expect(decideInstancePrune([HUB_ROW], "flair_typo")).toEqual({ kind: "nothing" });
    expect(decideInstancePrune([], "flair_typo")).toEqual({ kind: "nothing" });
  });
});

// ─── ops-API helpers ─────────────────────────────────────────────────────────

describe("readInstanceRows", () => {
  it("asks for every Instance row and returns them all", async () => {
    const { endpoint, calls } = opsEndpointMock(() => jsonResponse([SPOKE_ROW, HUB_ROW]));

    const rows = await readInstanceRows(endpoint);

    expect(rows.map((r) => r.id)).toEqual([SPOKE_ROW.id, HUB_ROW.id]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:19925/");
    expect(calls[0].body.operation).toBe("search_by_conditions");
    expect(calls[0].body.schema).toBe("flair");
    expect(calls[0].body.table).toBe("Instance");
    expect(calls[0].body.get_attributes).toContain("role");
    expect(calls[0].body.get_attributes).toContain("createdAt");
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
    await expect(readInstanceRows(endpoint)).rejects.toThrow("Instance search via ops API failed (403)");
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
      body.operation === "search_by_conditions"
        ? jsonResponse([HUB_ROW])
        : jsonResponse([{ role: "flair_pair_initiator" }]),
    );

    const probe = await probeInstanceIdentity(endpoint);

    expect(probe.rows?.map((r) => r.id)).toEqual([HUB_ROW.id]);
    expect(probe.roleNames).toEqual(["flair_pair_initiator"]);
  });

  it("reports rows:null when the table read fails, and still tries the roles read", async () => {
    const { endpoint, calls } = opsEndpointMock((body) =>
      body.operation === "search_by_conditions" ? new Response("no", { status: 500 }) : jsonResponse([]),
    );

    const probe = await probeInstanceIdentity(endpoint);

    expect(probe.rows).toBeNull();
    expect(probe.roleNames).toEqual([]);
    expect(calls.map((c) => c.body.operation)).toEqual(["search_by_conditions", "list_roles"]);
  });
});

describe("pruneInstanceRows", () => {
  it("deletes every row except the kept one and reports what went", async () => {
    const { endpoint, calls } = opsEndpointMock((body) =>
      body.operation === "search_by_conditions"
        ? jsonResponse([HUB_ROW, SPOKE_ROW, SECOND_HUB_ROW])
        : jsonResponse({ deleted_hashes: [body.hash_value] }),
    );

    const { dropped } = await pruneInstanceRows(endpoint, HUB_ROW.id);

    expect(dropped).toEqual([SPOKE_ROW.id, SECOND_HUB_ROW.id]);
    const deletes = calls.filter((c) => c.body.operation === "delete");
    expect(deletes.map((c) => c.body.hash_value)).toEqual([SPOKE_ROW.id, SECOND_HUB_ROW.id]);
    expect(deletes.every((c) => c.body.table === "Instance")).toBe(true);
    // The kept row is never deleted.
    expect(deletes.some((c) => c.body.hash_value === HUB_ROW.id)).toBe(false);
  });

  it("refuses an unknown --keep id and writes nothing", async () => {
    const { endpoint, calls } = opsEndpointMock(() => jsonResponse([HUB_ROW, SPOKE_ROW]));

    await expect(pruneInstanceRows(endpoint, "flair_typo")).rejects.toThrow("names no Instance row");

    expect(calls.some((c) => c.body.operation === "delete")).toBe(false);
  });

  it("does nothing when there is at most one row", async () => {
    const { endpoint, calls } = opsEndpointMock(() => jsonResponse([HUB_ROW]));
    const { dropped } = await pruneInstanceRows(endpoint, HUB_ROW.id);
    expect(dropped).toEqual([]);
    expect(calls.some((c) => c.body.operation === "delete")).toBe(false);
  });
});
