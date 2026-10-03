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
  async get(id: string) { return versions.get(id); }
  async *search() { yield* versions.values(); }
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
