import { beforeEach, describe, expect, mock, test } from "bun:test";

type Row = Record<string, any>;
const versions = new Map<string, Row>();
const memories = new Map<string, Row>();
let auth: any;
let returnedHead: Row | undefined;
let hideHead = false;
let failHead = false;
let failMemory = false;

class VersionTable {
  static create() {}
  static async *search(query: any) {
    if (failHead) throw new Error("head unavailable");
    if (hideHead) return;
    if (returnedHead) { yield returnedHead; return; }
    const rows = [...versions.values()].filter(row => query.conditions.every((c: any) => row[c.attribute] === c.value));
    rows.sort((a, b) => b.version - a.version);
    for (const row of rows.slice(0, query.limit)) yield row;
  }
  async get(target: any) {
    const id = typeof target === "string" ? target : target?.id;
    const row = versions.get(id);
    if (!row) return row;
    // Model Harper's own get: a `select`/`property` target is projected here,
    // from the stored row, so a decision made on the result sees only the
    // projected shape (the defect this suite pins).
    const select = typeof target === "object" ? target?.select : undefined;
    const property = typeof target === "object" ? target?.property : undefined;
    if (property != null) return row[property];
    if (Array.isArray(select)) { const picked: Row = {}; for (const key of select) picked[key] = row[key]; return picked; }
    if (typeof select === "string") return row[select];
    return row;
  }
  async *search(query?: any) {
    // Model Harper applying the query's page to the scan (conditions are not
    // modelled — the resource's pushed scope is not what this suite checks).
    let rows = [...versions.values()];
    const offset = typeof query?.offset === "number" ? query.offset : 0;
    const limit = typeof query?.limit === "number" ? query.limit : undefined;
    if (offset > 0) rows = rows.slice(offset);
    if (limit != null) rows = rows.slice(0, limit);
    yield* rows;
  }
}

mock.module("harper", () => ({ databases: { flair: {
  InstructionVersion: VersionTable,
  Memory: { get(id: string) { if (failMemory) throw new Error("memory unavailable"); return memories.get(id); } },
} } }));
mock.module("../../resources/agent-auth.js", () => ({
  resolveAgentAuth: async () => auth,
  allowVerified: async () => auth.kind !== "anonymous",
}));

const { InstructionVersion } = await import("../../resources/InstructionVersion.ts");
const { skillRefReadable } = await import("../../resources/instruction-version-record.ts");
const resource = () => new InstructionVersion();

beforeEach(() => {
  versions.clear(); memories.clear(); returnedHead = undefined; hideHead = false; failHead = false; failMemory = false;
  auth = { kind: "agent", agentId: "reader", isAdmin: false };
  versions.set("old", { id: "old", subjectType: "skill", subjectId: "subject", agentId: "owner", visibility: "shared", kind: "create", memoryId: "old-memory", version: 1 });
  versions.set("head", { id: "head", subjectType: "skill", subjectId: "subject", agentId: "owner", visibility: "shared", kind: "update", memoryId: "current-memory", version: 2 });
  memories.set("current-memory", { id: "current-memory", skillSubjectId: "subject", agentId: "owner", visibility: "shared", tags: ["skill"] });
});

async function expectDenied() {
  for (const reader of ["reader", "owner"]) {
    auth.agentId = reader;
    const byId = await resource().get("old");
    expect(byId).toBeInstanceOf(Response);
    expect((byId as Response).status).toBe(404);
    const listed = [];
    const collection = await resource().get({ isCollection: true });
    expect(collection).not.toBeInstanceOf(Response);
    for await (const row of collection as AsyncGenerator<Row>) listed.push(row.id);
    expect(listed).not.toContain("old");
  }
}

describe("skill version authority", () => {
  test("shared reads resolve the head's live skill subject", async () => {
    expect((await resource().get("old")).id).toBe("old");
    const listed = [];
    for await (const row of await resource().search() as AsyncGenerator<Row>) listed.push(row.id);
    expect(listed).toEqual(["old", "head"]);
  });

  test("paging counts only readable rows (the page is applied over the filtered stream)", async () => {
    versions.clear();
    const row = (id: string, subjectType: string) => ({ id, subjectType, subjectId: id, agentId: "owner", visibility: "shared", kind: "create", memoryId: null, version: 1 });
    versions.set("r1", row("r1", "soul"));
    versions.set("u1", row("u1", "unknown"));
    versions.set("r2", row("r2", "soul"));
    versions.set("u2", row("u2", "unknown"));
    versions.set("r3", row("r3", "soul"));
    const page = async (query?: any) => {
      const out: string[] = [];
      for await (const r of await resource().search(query) as AsyncGenerator<Row>) out.push(r.id);
      return out;
    };
    expect(await page({ limit: 2 })).toEqual(["r1", "r2"]);
    expect(await page({ limit: 2, offset: 1 })).toEqual(["r2", "r3"]);
    expect(await page({ offset: 1 })).toEqual(["r2", "r3"]);
    expect(await page({ limit: 2, offset: 2 })).toEqual(["r3"]);
    expect(await page({ limit: 0 })).toEqual([]);
    expect(await page()).toEqual(["r1", "r2", "r3"]);
  });

  test("a select/property read authorizes the full row before projecting", async () => {
    const selected = await resource().get({ id: "old", select: ["id"] });
    expect(selected).not.toBeInstanceOf(Response);
    expect((selected as Row).id).toBe("old");
    expect((selected as Row).subjectType).toBeUndefined();

    const property = await resource().get({ id: "old", property: "subjectType" });
    expect(property).toBe("skill");

    // A row the reader may not read is still denied when a selection is asked for.
    versions.get("old")!.visibility = "private";
    const denied = await resource().get({ id: "old", select: ["id"] });
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(404);
  });

  for (const [label, patch] of [
    ["unrelated shared Memory", { skillSubjectId: "unrelated" }],
    ["missing subject", { skillSubjectId: null }],
    ["non-skill Memory", { tags: ["note"] }],
    ["missing tags", { tags: null }],
    ["owner mismatch", { agentId: "reader" }],
    ["empty owner", { agentId: "" }],
    ["unknown visibility", { visibility: "public" }],
    ["missing visibility", { visibility: null }],
    ["archived Memory", { archived: true }],
    ["closed Memory", { validTo: "2020-01-01T00:00:00.000Z" }],
    ["expired Memory", { expiresAt: "2020-01-01T00:00:00.000Z" }],
    ["invalid lifetime", { validTo: "unknown" }],
    ["wrong physical id", { id: "unrelated" }],
  ] as const) {
    test(`${label} denies by-id and collection reads`, async () => {
      Object.assign(memories.get("current-memory")!, patch);
      await expectDenied();
    });
  }

  for (const [label, patch] of [
    ["empty head owner", { agentId: "" }],
    ["unknown head visibility", { visibility: "public" }],
    ["missing head visibility", { visibility: null }],
    ["unknown head kind", { kind: "unknown" }],
    ["missing head memoryId", { memoryId: null }],
    ["malformed tombstone", { kind: "delete" }],
  ] as const) {
    test(`${label} denies by-id and collection reads`, async () => {
      Object.assign(versions.get("head")!, patch);
      await expectDenied();
    });
  }

  for (const [label, patch] of [
    ["empty stored owner", { agentId: "" }],
    ["unknown stored visibility", { visibility: "public" }],
    ["missing stored visibility", { visibility: null }],
    ["empty subject", { subjectId: "" }],
    ["unknown subject type", { subjectType: "unknown" }],
  ] as const) {
    test(`${label} denies by-id and collection reads`, async () => {
      Object.assign(versions.get("old")!, patch);
      await expectDenied();
    });
  }

  for (const patch of [{ subjectId: "unrelated" }, { subjectType: "unknown" }]) {
    test(`a mismatched head ${Object.keys(patch)[0]} denies`, async () => {
      returnedHead = { ...versions.get("head"), ...patch };
      await expectDenied();
    });
  }

  test("missing Memory and failed authority reads deny", async () => {
    memories.clear(); await expectDenied();
    failMemory = true; await expectDenied();
    failHead = true; await expectDenied();
    failHead = false; hideHead = true; await expectDenied();
  });

  test("private current authority revokes shared history", async () => {
    memories.get("current-memory")!.visibility = "private";
    expect((await resource().get("old") as Response).status).toBe(404);
    auth.agentId = "owner";
    expect((await resource().get("old")).id).toBe("old");
  });

  test("loosening current authority preserves each version's stored visibility", async () => {
    versions.get("head")!.visibility = "private";
    expect((await resource().get("old")).id).toBe("old");
    expect((await resource().get("head") as Response).status).toBe(404);
  });

  test("a delete head uses its retained authority without a Memory row", async () => {
    Object.assign(versions.get("head")!, { kind: "delete", memoryId: null });
    memories.clear();
    expect((await resource().get("old")).id).toBe("old");
    versions.get("head")!.visibility = "private";
    expect((await resource().get("old") as Response).status).toBe(404);
    auth.agentId = "owner";
    expect((await resource().get("old")).id).toBe("old");
  });

  test("admin/internal retain skill exceptions while unknown subjects deny", async () => {
    memories.clear();
    for (const privileged of [{ kind: "internal" }, { kind: "agent", agentId: "admin", isAdmin: true }]) {
      auth = privileged;
      expect((await resource().get("old")).id).toBe("old");
      versions.get("head")!.subjectType = "unknown";
      expect((await resource().get("head") as Response).status).toBe(404);
    }
  });

  test("anonymous denies and Soul keeps its verified-agent rule", async () => {
    versions.get("old")!.subjectType = "soul";
    expect((await resource().get("old")).id).toBe("old");
    auth = { kind: "anonymous" };
    expect((await resource().get("old") as Response).status).toBe(404);
    expect((await resource().search() as Response).status).toBe(401);
  });

  test("retained references grant only known visibility with a nonempty owner", () => {
    for (const visibility of ["shared", "private"]) {
      expect(skillRefReadable({ agentId: "owner", visibility }, "owner")).toBe(true);
      expect(skillRefReadable({ agentId: "", visibility }, "reader")).toBe(false);
      expect(skillRefReadable({ visibility }, "reader")).toBe(false);
    }
    for (const visibility of ["public", "", null, undefined]) {
      expect(skillRefReadable({ agentId: "owner", visibility }, "owner")).toBe(false);
    }
  });
});
