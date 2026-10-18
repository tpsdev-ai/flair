import { expect, mock, test } from "bun:test";

const events: Record<string, any>[] = [];
const versions: Record<string, any>[] = [];
const memories: Record<string, any>[] = [];
const empty = { async *search() {}, async get() { return null; } };
mock.module("harper", () => ({
  Resource: class {},
  databases: { flair: {
    Memory: empty, Soul: empty, Agent: empty, Instance: empty,
    OrgSkillAssignment: empty, Relationship: empty, Presence: empty,
    InstructionVersion: {
      primaryStore: { tryLock: () => true, unlock() {}, resetReadTxn() {} },
      async *search(query: any, ctx: any) {
        for (const version of ctx.transaction.versions) {
          if (query.conditions.every((condition: any) => version[condition.attribute] === condition.value)) yield version;
        }
      },
      async create(record: any, ctx: any) { ctx.transaction.versions.push(record); },
    },
    OrgEvent: {
      async create(record: any, ctx: any) { ctx.transaction.events.push(record); },
      async *search(query: any) {
        for (const event of events) {
          yield Object.fromEntries(query.select.map((field: string) => [field, event[field]]));
        }
      },
    },
  } },
}));
mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async () => [1, 0], getModelId: () => "test", getMode: () => "local", EMBEDDING_ENGINE: "gguf",
}));
const { recordVersion } = await import("../../resources/instruction-version-record.ts");
const { BootstrapMemories } = await import("../../resources/MemoryBootstrap.ts");

test("default bootstrap preserves distinct instruction refs, agent scope and content-free detail", async () => {
  const createdAt = new Date().toISOString();
  (globalThis as any).transaction = async (ctx: any, work: (txn: any) => Promise<any>) => {
    const txn = { open: 1, saveCommits: false, versions: [...versions], events: [...events], memories: [...memories] };
    ctx.transaction = txn;
    const result = await work(txn);
    txn.open = 0;
    versions.splice(0, versions.length, ...txn.versions);
    events.splice(0, events.length, ...txn.events);
    memories.splice(0, memories.length, ...txn.memories);
    return result;
  };
  const ctx = { request: { tpsAgent: "owner", tpsAgentIsAdmin: false } };
  for (const subjectId of ["skill-a", "skill-b"]) {
    const content = "PRIVATE-CONTENT-SENTINEL";
    const outcome = await recordVersion(ctx, {
      subjectType: "skill", subjectId, agentId: "owner", kind: "create", rowId: subjectId,
      memoryId: subjectId, visibility: "private", value: content,
    }, async (shared) => {
      shared.transaction.memories.push({
        id: subjectId, agentId: "owner", content, createdAt,
        tags: ["skill"], trigger: "PRIVATE-TRIGGER-SENTINEL", durability: "persistent",
      });
      return { id: subjectId };
    });
    expect(outcome.ok).toBe(true);
  }
  expect(memories).toHaveLength(2);
  expect(versions).toHaveLength(2);
  expect(events).toHaveLength(2);
  const records = versions;
  events.push({ id: "ordinary", authorId: "owner", kind: "status", summary: "ordinary", detail: "optional detail", createdAt });
  const bootstrap: any = new BootstrapMemories();
  bootstrap.getContext = () => ({ request: { tpsAgent: "reader", tpsAgentIsAdmin: false } });
  const result = await bootstrap.post({ agentId: "reader", includeContext: false });
  const delivered = result.events.filter((event: any) => event.kind === "skill.changed");
  expect(delivered).toHaveLength(2);
  expect(delivered.map((event: any) => event.refId).sort()).toEqual(records.map((record) => record.id).sort());
  for (const event of delivered) {
    expect(event.scope).toBe("owner");
    expect(event.id).toBe(`instruction-change:${event.refId}`);
    expect(JSON.parse(event.detail)).toEqual({
      subjectType: "skill", subjectId: records.find((record) => record.id === event.refId)!.subjectId,
      key: null, changeKind: "create", actorKind: "agent", actorId: "owner", sourceClass: "agent",
    });
    expect(JSON.stringify(event)).not.toContain("PRIVATE-");
  }
  expect(result.events.find((event: any) => event.id === "ordinary")).not.toHaveProperty("detail");
});
