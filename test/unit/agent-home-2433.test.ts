/**
 * agent-home-2433.test.ts — unit tests for the CLI-side Agent "home instance"
 * rule (flair#2433).
 *
 * The creation paths that write an Agent row through the operations API
 * (`seedAgentViaOpsApi`, `flair principal add`, the IdP-mapping principal insert,
 * `flair mcp grant`) bypass the Agent resource, so they must stamp the home
 * themselves. Everything here is pure or fetch-mocked: the real-Harper seam is
 * covered by test/integration/agent-home-2433.test.ts.
 */
import { describe, expect, test, spyOn } from "bun:test";
import {
  AGENT_HOME_IMMUTABLE_ERROR,
  AGENT_HOME_STAMP_REMEDY,
  agentHomeChangeRefusal,
  agentHomeEndpoint,
  agentRowId,
  isHomeLessAgentRow,
  isSyncOriginatedAgentRow,
  planAgentHomeStamps,
  planAgentHomeWrite,
  readAgentHomeRows,
  readStoredAgentHome,
  resolveTargetInstanceId,
} from "../../src/lib/agent-home.js";
import { describeAgentHomeFinding } from "../../src/doctor-client.js";
import { INSTANCE_ROW_PRUNE_REMEDY } from "../../src/lib/instance-identity-row.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Install a fetch that answers by inspecting the request body's `operation`. */
function installOpsFetch(handlers: Partial<Record<string, () => Response>>): {
  calls: Array<{ op?: string; body: any }>;
  restore: () => void;
} {
  const calls: Array<{ op?: string; body: any }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: any, opts: any) => {
    const body = opts?.body ? JSON.parse(String(opts.body)) : {};
    calls.push({ op: body?.operation, body });
    const handler = handlers[body?.operation as string];
    if (!handler) throw new Error(`unexpected operation ${body?.operation}`);
    return handler();
  }) as any;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

describe("planAgentHomeStamps — the remedy's split", () => {
  test("a home-less row with no sync provenance is stampable; a sync-originated row is listed only", () => {
    const rows = [
      { id: "local-a" },
      { id: "local-b", originatorInstanceId: null },
      { id: "imported-c", originatorInstanceId: "", _syncedFrom: "peer-1" },
      { id: "has-home", originatorInstanceId: "inst-x" },
    ];
    const plan = planAgentHomeStamps(rows, "inst-local");
    expect(plan.homeLess).toEqual(["imported-c", "local-a", "local-b"]);
    expect(plan.sync).toEqual(["imported-c"]);
    expect(plan.stampable).toEqual(["local-a", "local-b"]);
  });

  test("_originatorInstanceId alone also marks a row as sync-originated", () => {
    const plan = planAgentHomeStamps([{ id: "a", _originatorInstanceId: "recv" }], "inst-local");
    expect(plan.sync).toEqual(["a"]);
    expect(plan.stampable).toEqual([]);
  });

  test("a row with no usable id is not listed and never stamped", () => {
    const plan = planAgentHomeStamps([{ name: "no-id" }, { id: "" }], "inst-local");
    expect(plan.homeLess).toEqual([]);
    expect(plan.stampable).toEqual([]);
  });
});

describe("isHomeLessAgentRow / isSyncOriginatedAgentRow / agentRowId", () => {
  test("null, absent and empty homes all read as home-less", () => {
    expect(isHomeLessAgentRow({ id: "a" })).toBe(true);
    expect(isHomeLessAgentRow({ id: "a", originatorInstanceId: null })).toBe(true);
    expect(isHomeLessAgentRow({ id: "a", originatorInstanceId: "" })).toBe(true);
    expect(isHomeLessAgentRow({ id: "a", originatorInstanceId: "inst" })).toBe(false);
  });

  test("sync provenance is a non-empty _syncedFrom or _originatorInstanceId", () => {
    expect(isSyncOriginatedAgentRow({ _syncedFrom: "peer" })).toBe(true);
    expect(isSyncOriginatedAgentRow({ _originatorInstanceId: "recv" })).toBe(true);
    expect(isSyncOriginatedAgentRow({ _syncedFrom: "" })).toBe(false);
    expect(isSyncOriginatedAgentRow({})).toBe(false);
    expect(isSyncOriginatedAgentRow(null)).toBe(false);
  });

  test("agentRowId accepts only a non-empty string id", () => {
    expect(agentRowId({ id: "a" })).toBe("a");
    expect(agentRowId({ id: 5 as unknown as string })).toBeNull();
    expect(agentRowId({ id: "" })).toBeNull();
    expect(agentRowId({})).toBeNull();
  });
});

describe("describeAgentHomeFinding — what doctor prints", () => {
  test("no home-less row → no finding", () => {
    expect(describeAgentHomeFinding([{ id: "a", originatorInstanceId: "inst" }], { kind: "one", id: "inst" })).toBeNull();
  });

  test("an identity and a home-less row is an advisory, not counted, naming the remedy and the stamps/lists split", () => {
    const finding = describeAgentHomeFinding(
      [{ id: "a" }, { id: "b", _syncedFrom: "peer" }],
      { kind: "one", id: "inst-local" },
    );
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("advisory");
    expect(finding!.isIssue).toBe(false);
    expect(finding!.homeLessIds).toEqual(["a", "b"]);
    expect(finding!.stampableIds).toEqual(["a"]);
    expect(finding!.syncIds).toEqual(["b"]);
    expect(finding!.fixHint).toBe(AGENT_HOME_STAMP_REMEDY);
    expect(finding!.message).toContain("inst-local");
    expect(finding!.message).toContain("federation");
  });

  test("a fresh instance (no Instance row) is info and not counted", () => {
    const finding = describeAgentHomeFinding([{ id: "a" }], { kind: "none" });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("info");
    expect(finding!.isIssue).toBe(false);
    expect(finding!.message).toContain("no Instance row");
    expect(finding!.message).toContain("local-origin");
  });

  test("several Instance rows is info, not counted, and names the prune remedy", () => {
    const finding = describeAgentHomeFinding([{ id: "a" }], { kind: "multiple", count: 2 });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("info");
    expect(finding!.isIssue).toBe(false);
    expect(finding!.message).toContain("2 Instance rows");
    expect(finding!.fixHint).toContain(INSTANCE_ROW_PRUNE_REMEDY);
  });

  test("an unreadable Instance table is info and not counted", () => {
    const finding = describeAgentHomeFinding([{ id: "a" }], { kind: "unreadable" });
    expect(finding!.severity).toBe("info");
    expect(finding!.isIssue).toBe(false);
  });
});

describe("planAgentHomeWrite — the home is immutable after create", () => {
  test("a new id proceeds and stamps the resolved home", () => {
    expect(planAgentHomeWrite({ state: "absent" }, "inst-local", "a")).toEqual({ refuse: false, stamp: true, home: "inst-local" });
  });

  test("a stored home equal to the next one proceeds without writing a home", () => {
    expect(planAgentHomeWrite({ state: "found", home: "inst-local" }, "inst-local", "a")).toEqual({ refuse: false, stamp: false, home: "inst-local" });
  });

  test("a stored NULL home is left untouched by principal add", () => {
    const plan = planAgentHomeWrite({ state: "found", home: null }, "inst-local", "a");
    expect(plan.refuse).toBe(false);
    if (!plan.refuse) expect(plan.stamp).toBe(false);
  });

  test("a stored home that differs is REFUSED with the named error", () => {
    const plan = planAgentHomeWrite({ state: "found", home: "inst-other" }, "inst-local", "a");
    expect(plan.refuse).toBe(true);
    if (plan.refuse) {
      expect(plan.message).toContain(AGENT_HOME_IMMUTABLE_ERROR);
      expect(plan.message).toContain("inst-other");
      expect(plan.message).toContain("inst-local");
    }
  });

  test("an unreadable read is refused, never treated as no home", () => {
    const plan = planAgentHomeWrite({ state: "unreadable", reason: "HTTP 500" }, "inst-local", "a");
    expect(plan.refuse).toBe(true);
    if (plan.refuse) expect(plan.message).toContain("HTTP 500");
  });
});

describe("agentHomeChangeRefusal", () => {
  test("names the error code and both values", () => {
    const message = agentHomeChangeRefusal("agent-a", "inst-old", "inst-new");
    expect(message).toContain(AGENT_HOME_IMMUTABLE_ERROR);
    expect(message).toContain("inst-old");
    expect(message).toContain("inst-new");
    expect(message).toContain("immutable");
  });
});

describe("resolveTargetInstanceId — the one shared decision over the ops API", () => {
  test("exactly one Instance row → its id", async () => {
    const f = installOpsFetch({ sql: () => jsonResponse([{ id: "inst-local", role: "hub" }]) });
    try {
      const id = await resolveTargetInstanceId(agentHomeEndpoint(19925, "admin", "pw"));
      expect(id).toBe("inst-local");
    } finally {
      f.restore();
    }
  });

  test("no Instance row → null (the local-origin state, never invented)", async () => {
    const f = installOpsFetch({ sql: () => jsonResponse([]) });
    try {
      expect(await resolveTargetInstanceId(agentHomeEndpoint(19925, "admin", "pw"))).toBeNull();
    } finally {
      f.restore();
    }
  });

  test("several Instance rows → null (no canonical identity)", async () => {
    const f = installOpsFetch({ sql: () => jsonResponse([{ id: "a" }, { id: "b" }]) });
    try {
      expect(await resolveTargetInstanceId(agentHomeEndpoint(19925, "admin", "pw"))).toBeNull();
    } finally {
      f.restore();
    }
  });

  test("a read that FAILED → null, not a fabricated id", async () => {
    const f = installOpsFetch({ sql: () => jsonResponse({ error: "nope" }, 503) });
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => { errors.push(a); };
    try {
      expect(await resolveTargetInstanceId(agentHomeEndpoint(19925, "admin", "pw"))).toBeNull();
      expect(errors.length).toBe(1);
    } finally {
      console.error = origError;
      f.restore();
    }
  });
});

describe("readStoredAgentHome — absent / found / unreadable are distinct", () => {
  const args = { opsUrl: "http://127.0.0.1:19925/", authHeader: "Basic x", id: "agent-a" };

  test("no row → absent", async () => {
    const f = installOpsFetch({ search_by_id: () => jsonResponse([]) });
    try {
      expect(await readStoredAgentHome(args)).toEqual({ state: "absent" });
    } finally {
      f.restore();
    }
  });

  test("a row with a home → found with the value", async () => {
    const f = installOpsFetch({ search_by_id: () => jsonResponse([{ id: "agent-a", originatorInstanceId: "inst-x" }]) });
    try {
      expect(await readStoredAgentHome(args)).toEqual({ state: "found", home: "inst-x" });
    } finally {
      f.restore();
    }
  });

  test("a row with a null home → found with null", async () => {
    const f = installOpsFetch({ search_by_id: () => jsonResponse([{ id: "agent-a", originatorInstanceId: null }]) });
    try {
      expect(await readStoredAgentHome(args)).toEqual({ state: "found", home: null });
    } finally {
      f.restore();
    }
  });

  test("a non-OK response → unreadable, never absent", async () => {
    const f = installOpsFetch({ search_by_id: () => jsonResponse({ error: "boom" }, 500) });
    try {
      const read = await readStoredAgentHome(args);
      expect(read.state).toBe("unreadable");
    } finally {
      f.restore();
    }
  });

  test("a thrown fetch → unreadable", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("down"); }) as any;
    try {
      const read = await readStoredAgentHome(args);
      expect(read.state).toBe("unreadable");
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("readAgentHomeRows", () => {
  const args = { opsUrl: "http://127.0.0.1:19925/", authHeader: "Basic x" };

  test("returns the row list on a successful read", async () => {
    const f = installOpsFetch({ search_by_value: () => jsonResponse([{ id: "a" }, { id: "b" }]) });
    try {
      expect(await readAgentHomeRows(args)).toEqual([{ id: "a" }, { id: "b" }]);
    } finally {
      f.restore();
    }
  });

  test("a non-OK response → null (a failed read is never 'no rows')", async () => {
    const f = installOpsFetch({ search_by_value: () => jsonResponse({ error: "x" }, 503) });
    try {
      expect(await readAgentHomeRows(args)).toBeNull();
    } finally {
      f.restore();
    }
  });
});

describe("agentHomeEndpoint", () => {
  test("a numeric port builds a loopback URL; credentials ride when a pass is given", () => {
    const withPass = agentHomeEndpoint(19925, "admin", "pw");
    expect(withPass.opsUrl).toBe("http://127.0.0.1:19925");
    expect(withPass.credentials).toEqual({ user: "admin", pass: "pw" });
    const without = agentHomeEndpoint(19925, "admin");
    expect(without.credentials).toBeUndefined();
  });
});

describe("seedAgentViaOpsApi stamps the home only when the caller resolved one", () => {
  test("the insert body carries the home instance id", async () => {
    const { seedAgentViaOpsApi } = await import("../../src/cli.js");
    const bodies: any[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: any, opts: any) => {
      bodies.push(JSON.parse(String(opts.body)));
      return new Response("", { status: 200 });
    }) as any;
    try {
      await seedAgentViaOpsApi(19925, "agent-a", "pubkey", "admin", "pw", undefined, "inst-local");
      const record = bodies[bodies.length - 1].records[0];
      expect(record.originatorInstanceId).toBe("inst-local");
      expect(bodies[bodies.length - 1].operation).toBe("insert");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("with no resolved home the field is left off the row (unchanged pre-fix shape)", async () => {
    const { seedAgentViaOpsApi } = await import("../../src/cli.js");
    const bodies: any[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: any, opts: any) => {
      bodies.push(JSON.parse(String(opts.body)));
      return new Response("", { status: 200 });
    }) as any;
    try {
      await seedAgentViaOpsApi(19925, "agent-a", "pubkey", "admin", "pw");
      expect("originatorInstanceId" in bodies[bodies.length - 1].records[0]).toBe(false);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
