/** Memory node id-set comparison: the classifier, the row read, and the report. */
import { describe, expect, test } from "bun:test";
import {
  classifyNodeSets,
  parseWriteTime,
  readNode,
  renderCompareNodesHuman,
  rowWriteTime,
  COMPARE_EXIT_CODES,
  NODE_ID_SAMPLE_LIMIT,
  type NodeReading,
} from "../../src/memory-node-compare.ts";

const NODE_A = "https://node-a.example.invalid";
const NODE_B = "https://node-b.example.invalid";

/** A node reading from (id, writeTime) pairs. */
function read(node: string, spec: [string, string][]): NodeReading {
  return { kind: "read", node, rows: spec.map(([id, writeTime]) => ({ id, writeTime })) };
}

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const T2 = "2026-10-03T00:00:00.000Z";

describe("flair#2216 — node id-set classifier", () => {
  test("identical id sets are healthy and every node in-sync", () => {
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T0], ["mem-2", T1]]),
      read(NODE_B, [["mem-1", T0], ["mem-2", T1]]),
    ]);
    expect(result.verdict).toBe("healthy");
    expect(result.nodes.map((n) => n.verdict)).toEqual(["in-sync", "in-sync"]);
  });

  test("two empty nodes are healthy (identical empty sets)", () => {
    expect(classifyNodeSets([read(NODE_A, []), read(NODE_B, [])]).verdict).toBe("healthy");
  });

  test("a node missing only an id newer than its own newest write is lagging, never healthy", () => {
    // The lagging id is held by two other nodes, so no node counts it as an id
    // no other node has; the overall result is lagging, not divergent.
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T0], ["mem-2", T1], ["mem-3", T2]]),
      read(NODE_B, [["mem-1", T0], ["mem-2", T1], ["mem-3", T2]]),
      read("https://node-c.example.invalid", [["mem-1", T0], ["mem-2", T1]]),
    ]);
    expect(result.verdict).toBe("lagging");
    expect(result.nodes.map((n) => n.verdict)).toEqual(["in-sync", "in-sync", "lagging"]);
    expect(result.nodes[2].missing).toEqual({ count: 1, sample: ["mem-3"] });
    expect(COMPARE_EXIT_CODES.lagging).not.toBe(0);
  });

  test("in a two-node comparison a node ahead of a lagging peer is divergent, and the overall result is divergent", () => {
    // The lagging node's missing id is held by exactly one node, so that node
    // holds an id no other node has.
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T0], ["mem-2", T1], ["mem-3", T2]]),
      read(NODE_B, [["mem-1", T0], ["mem-2", T1]]),
    ]);
    expect(result.verdict).toBe("divergent");
    expect(result.nodes.map((n) => n.verdict)).toEqual(["divergent", "lagging"]);
  });

  test("a node missing an id older than its own newest write is divergent", () => {
    // B's newest write is T2; the id it lacks was written at T0.
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T0], ["mem-2", T2]]),
      read(NODE_B, [["mem-2", T2]]),
    ]);
    expect(result.verdict).toBe("divergent");
    expect(result.nodes[1].verdict).toBe("divergent");
  });

  test("a tie at the boundary is divergent: an id written exactly at the node's newest write is not lag", () => {
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T1], ["mem-2", T1]]),
      read(NODE_B, [["mem-2", T1]]),
    ]);
    expect(result.nodes[1].verdict).toBe("divergent");
  });

  test("a node holding an id no other node has is divergent", () => {
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T0]]),
      read(NODE_B, [["mem-1", T0], ["only-on-b", T1]]),
    ]);
    expect(result.verdict).toBe("divergent");
    expect(result.nodes[1].extra).toEqual({ count: 1, sample: ["only-on-b"] });
  });

  test("mixed classes: an in-sync node, a lagging node and a divergent node in one result", () => {
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T0], ["mem-2", T2], ["mem-3", T0]]),
      read(NODE_B, [["mem-1", T0], ["mem-3", T0]]),
      read("https://node-c.example.invalid", [["mem-1", T0], ["mem-2", T2]]),
    ]);
    expect(result.nodes.map((n) => n.verdict)).toEqual(["in-sync", "lagging", "divergent"]);
    expect(result.verdict).toBe("divergent");
  });

  test("a failed read makes its node unknown and the overall result unknown, never healthy", () => {
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T0]]),
      read(NODE_B, [["mem-1", T0]]),
      { kind: "failed", node: "https://node-c.example.invalid", reason: "operations API read returned HTTP 503" },
    ]);
    expect(result.verdict).toBe("unknown");
    expect(result.nodes.map((n) => n.verdict)).toEqual(["in-sync", "in-sync", "unknown"]);
    expect(result.nodes[2].reason).toContain("503");
    expect(COMPARE_EXIT_CODES.unknown).not.toBe(0);
  });

  test("a single readable node is unknown, not in-sync (there is nothing to compare against)", () => {
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T0]]),
      { kind: "failed", node: NODE_B, reason: "unreachable" },
    ]);
    expect(result.verdict).toBe("unknown");
    expect(result.nodes[0].verdict).toBe("unknown");
    expect(result.nodes[0].reason).toContain("no other node");
  });

  test("a row with no usable write time makes its node unknown, not empty", () => {
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T0]]),
      { kind: "read", node: NODE_B, rows: [{ id: "mem-1", writeTime: null }] },
    ]);
    expect(result.verdict).toBe("unknown");
    expect(result.nodes[1].verdict).toBe("unknown");
    expect(result.nodes[1].reason).toContain("no usable write time");
  });

  test("a node missing ids but with no persisted write time is unknown, never lagging", () => {
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T0]]),
      read(NODE_B, []),
    ]);
    expect(result.verdict).toBe("unknown");
    expect(result.nodes[1].verdict).toBe("unknown");
  });

  test("missing and extra ids are capped with a count, and carry no row content", () => {
    const many: [string, string][] = Array.from({ length: NODE_ID_SAMPLE_LIMIT + 2 }, (_, i) => [`mem-${i}`, T0]);
    const result = classifyNodeSets([read(NODE_A, many), read(NODE_B, [])]);
    const b = result.nodes[1];
    expect(b.missing.count).toBe(NODE_ID_SAMPLE_LIMIT + 2);
    expect(b.missing.sample).toHaveLength(NODE_ID_SAMPLE_LIMIT);
    // Only ids — never a content field.
    expect(JSON.stringify(result)).not.toContain("content");
  });

  test("fewer than two nodes is a misuse", () => {
    expect(() => classifyNodeSets([read(NODE_A, [["mem-1", T0]])])).toThrow(/at least two/);
  });
});

describe("flair#2216 — write-time parsing", () => {
  test("updatedAt wins over createdAt; a missing or unparseable value is null", () => {
    expect(rowWriteTime({ id: "m", durability: "standard", createdAt: T0, updatedAt: T1 })).toBe(T1);
    expect(rowWriteTime({ id: "m", durability: "standard", createdAt: T0, updatedAt: null })).toBe(T0);
    expect(rowWriteTime({ id: "m", durability: "standard", createdAt: T0 })).toBe(T0);
    expect(rowWriteTime({ id: "m", durability: "standard", createdAt: "not-a-time", updatedAt: "" })).toBeNull();
    expect(rowWriteTime({ id: "m", durability: "standard" })).toBeNull();
    expect(parseWriteTime("2026-10-01T00:00:00.000Z")).toBe(Date.parse(T0));
    expect(parseWriteTime(undefined)).toBeNull();
  });
});

describe("flair#2216 — reading one node with the checkpoint's paged read", () => {
  test("reads ids and write times through the operations API and rechecks the count", async () => {
    const calls: Record<string, unknown>[] = [];
    const opsPost = async (body: Record<string, unknown>) => {
      calls.push(body);
      if (body.operation === "describe_table") return { record_count: 1 };
      return [{ id: "mem-1", durability: "standard", createdAt: T0, updatedAt: T1 }];
    };
    const reading = await readNode(NODE_A, { opsPost });
    expect(reading).toEqual({ kind: "read", node: NODE_A, rows: [{ id: "mem-1", writeTime: T1 }] });
    const sql = calls.filter((c) => c.operation === "sql");
    expect(sql).toEqual([{ operation: "sql", sql: "SELECT id, durability, createdAt, updatedAt FROM flair.Memory ORDER BY id LIMIT 10000" }]);
  }, 5_000);

  test("a failed read is reported as failed, never as an empty node", async () => {
    const reading = await readNode(NODE_A, { opsPost: async () => { throw new Error("operations API read returned HTTP 401"); } });
    expect(reading.kind).toBe("failed");
    if (reading.kind === "failed") expect(reading.reason).toContain("401");
  }, 5_000);

  test("a node URL that is not an HTTP(S) origin is refused before any request", async () => {
    let called = false;
    const reading = await readNode("file:///etc/passwd", { opsPost: async () => { called = true; return []; } });
    expect(reading.kind).toBe("failed");
    expect(called).toBe(false);
  }, 5_000);
});

describe("flair#2216 — human report", () => {
  test("names each node, its class, and the missing ids", () => {
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T0], ["mem-2", T1]]),
      read(NODE_B, [["mem-2", T1]]),
    ]);
    const text = renderCompareNodesHuman(result);
    expect(text).toContain("Memory node comparison: DIVERGENT");
    expect(text).toContain(NODE_B);
    expect(text).toContain("DIVERGENT");
  });
});
