import { describe, test, expect, mock } from "bun:test";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { FlairChatMessageHistory } from "../src/nodes/FlairChatMemory/FlairChatMessageHistory";

function makeFlairClient(stored: any[]) {
  const calls: any[] = [];
  const client: any = {
    memory: {
      list: mock(async (opts: any) => {
        calls.push({ method: "list", opts });
        return stored;
      }),
      write: mock(async (content: string, opts: any) => {
        calls.push({ method: "write", content, opts });
        return { id: `mock-${calls.length}`, content, ...opts };
      }),
      delete: mock(async (id: string) => {
        calls.push({ method: "delete", id });
      }),
    },
  };
  return { client, calls };
}

describe("FlairChatMessageHistory", () => {
  test("addMessage writes a single memory with correct shape", async () => {
    const { client, calls } = makeFlairClient([]);
    const history = new FlairChatMessageHistory(client, "subj-1");
    await history.addMessage(new HumanMessage("hello world"));

    expect(calls).toHaveLength(1);
    const w = calls[0];
    expect(w.method).toBe("write");
    expect(w.opts.subject).toBe("subj-1");
    expect(w.opts.type).toBe("session");
    expect(w.opts.durability).toBe("ephemeral");
    expect(w.opts.tags).toContain("n8n-chat");
    expect(w.opts.tags).toContain("role:human");
    // Content is stringified StoredMessage envelope
    const parsed = JSON.parse(w.content);
    expect(parsed.type).toBe("human");
    expect(parsed.data.content).toBe("hello world");
  });

  test("addMessage tags AI vs Human roles distinctly", async () => {
    const { client, calls } = makeFlairClient([]);
    const history = new FlairChatMessageHistory(client, "subj-2");
    await history.addMessage(new HumanMessage("Q"));
    await history.addMessage(new AIMessage("A"));

    expect(calls[0].opts.tags).toContain("role:human");
    expect(calls[1].opts.tags).toContain("role:ai");
  });

  test("getMessages reconstructs BaseMessage[] in createdAt-ascending order", async () => {
    const { client } = makeFlairClient([
      // Out-of-order on purpose; getMessages should sort by createdAt asc
      {
        id: "m2",
        content: JSON.stringify({ type: "ai", data: { content: "answer" } }),
        createdAt: "2026-05-03T22:00:02.000Z",
      },
      {
        id: "m1",
        content: JSON.stringify({ type: "human", data: { content: "question" } }),
        createdAt: "2026-05-03T22:00:01.000Z",
      },
    ]);
    const history = new FlairChatMessageHistory(client, "subj-3");
    const msgs = await history.getMessages();

    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toBeInstanceOf(HumanMessage);
    expect(msgs[0].content).toBe("question");
    expect(msgs[1]).toBeInstanceOf(AIMessage);
    expect(msgs[1].content).toBe("answer");
  });

  test("getMessages skips memories whose content isn't a valid StoredMessage", async () => {
    const { client } = makeFlairClient([
      {
        id: "m1",
        content: JSON.stringify({ type: "human", data: { content: "ok" } }),
        createdAt: "2026-05-03T22:00:01.000Z",
      },
      {
        id: "m2",
        content: "not-json",
        createdAt: "2026-05-03T22:00:02.000Z",
      },
      {
        id: "m3",
        content: JSON.stringify({ type: "ai", data: { content: "reply" } }),
        createdAt: "2026-05-03T22:00:03.000Z",
      },
    ]);
    const history = new FlairChatMessageHistory(client, "subj-4");
    const msgs = await history.getMessages();

    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe("ok");
    expect(msgs[1].content).toBe("reply");
  });

  test("getMessages requests up to windowK*2 memories filtered by subject", async () => {
    const { client, calls } = makeFlairClient([]);
    const history = new FlairChatMessageHistory(client, "subj-5", 7);
    await history.getMessages();

    const listCall = calls.find((c) => c.method === "list");
    expect(listCall).toBeDefined();
    expect(listCall.opts.subject).toBe("subj-5");
    expect(listCall.opts.type).toBe("session");
    expect(listCall.opts.limit).toBe(14); // 7 * 2
  });

  test("addMessages writes each message sequentially", async () => {
    const { client, calls } = makeFlairClient([]);
    const history = new FlairChatMessageHistory(client, "subj-6");
    await history.addMessages([
      new SystemMessage("sys"),
      new HumanMessage("u"),
      new AIMessage("a"),
    ]);

    const writes = calls.filter((c) => c.method === "write");
    expect(writes).toHaveLength(3);
    expect(writes[0].opts.tags).toContain("role:system");
    expect(writes[1].opts.tags).toContain("role:human");
    expect(writes[2].opts.tags).toContain("role:ai");
  });

  test("clear deletes every session memory under the subject", async () => {
    const { client, calls } = makeFlairClient([
      { id: "m1", content: "{}", createdAt: "x" },
      { id: "m2", content: "{}", createdAt: "y" },
      { id: "m3", content: "{}", createdAt: "z" },
    ]);
    const history = new FlairChatMessageHistory(client, "subj-7");
    await history.clear();

    const deletes = calls.filter((c) => c.method === "delete");
    expect(deletes).toHaveLength(3);
    expect(deletes.map((d) => d.id)).toEqual(["m1", "m2", "m3"]);
  });
});
