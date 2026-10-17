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

  test("a node missing only an id timestamp greater than its own maximum is lagging, never healthy", () => {
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

  test("in a two-node comparison a node with an extra id and a lagging peer is divergent, and the overall result is divergent", () => {
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T0], ["mem-2", T1], ["mem-3", T2]]),
      read(NODE_B, [["mem-1", T0], ["mem-2", T1]]),
    ]);
    expect(result.verdict).toBe("divergent");
    expect(result.nodes.map((n) => n.verdict)).toEqual(["divergent", "lagging"]);
  });

  test("a missing id timestamp below the local maximum is divergent", () => {
    // B's maximum timestamp is T2; the id it lacks has timestamp T0.
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T0], ["mem-2", T2]]),
      read(NODE_B, [["mem-2", T2]]),
    ]);
    expect(result.verdict).toBe("divergent");
    expect(result.nodes[1].verdict).toBe("divergent");
  });

  test("a missing id timestamp equal to the local maximum is divergent", () => {
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T1], ["mem-2", T1]]),
      read(NODE_B, [["mem-2", T1]]),
    ]);
    expect(result.nodes[1].verdict).toBe("divergent");
  });

  test("an id unique to one of two usable nodes is extra", () => {
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
    expect(result.nodes[0].reason).toContain("no usable peer");
    expect(result.nodes[0].missing).toBe("UNAVAILABLE");
    expect(result.nodes[0].extra).toBe("UNAVAILABLE");
    expect(result.nodes[1]).toMatchObject({ rowCount: "UNAVAILABLE", newestWrite: "UNAVAILABLE", missing: "UNAVAILABLE", extra: "UNAVAILABLE" });
  });

  test("a row with no usable stored timestamp makes its node unknown, not empty", () => {
    const result = classifyNodeSets([
      read(NODE_A, [["mem-1", T0]]),
      { kind: "read", node: NODE_B, rows: [{ id: "mem-1", writeTime: null }] },
    ]);
    expect(result.verdict).toBe("unknown");
    expect(result.nodes[1].verdict).toBe("unknown");
    expect(result.nodes[1].reason).toContain("no usable stored timestamp");
  });

  test("a node missing ids but with no stored timestamp is unknown, never lagging", () => {
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
    expect(b.missing).toMatchObject({ count: NODE_ID_SAMPLE_LIMIT + 2 });
    if (b.missing === "UNAVAILABLE") throw new Error("expected available missing ids");
    expect(b.missing.sample).toHaveLength(NODE_ID_SAMPLE_LIMIT);
    // Only ids — never a content field.
    expect(JSON.stringify(result)).not.toContain("content");
  });

  test("fewer than two nodes is a misuse", () => {
    expect(() => classifyNodeSets([read(NODE_A, [["mem-1", T0]])])).toThrow(/at least two/);
  });
});

describe("flair#2216 — stored-timestamp parsing", () => {
  test("uses the first parseable stored timestamp, or null", () => {
    expect(rowWriteTime({ id: "m", durability: "standard", createdAt: T0, updatedAt: T1 })).toBe(T1);
    expect(rowWriteTime({ id: "m", durability: "standard", createdAt: T0, updatedAt: null })).toBe(T0);
    expect(rowWriteTime({ id: "m", durability: "standard", createdAt: T0 })).toBe(T0);
    expect(rowWriteTime({ id: "m", durability: "standard", createdAt: T0, updatedAt: "invalid" })).toBe(T0);
    expect(rowWriteTime({ id: "m", durability: "standard", createdAt: "October 1, 2026" })).toBe("October 1, 2026");
    expect(rowWriteTime({ id: "m", durability: "standard", createdAt: "not-a-time", updatedAt: "" })).toBeNull();
    expect(rowWriteTime({ id: "m", durability: "standard" })).toBeNull();
    expect(parseWriteTime("2026-10-01T00:00:00.000Z")).toBe(Date.parse(T0));
    expect(parseWriteTime(undefined)).toBeNull();
  });
});

describe("flair#2216 — reading one node with the checkpoint's paged read", () => {
  test("reads ids and stored timestamps through the operations API and rechecks the count", async () => {
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

  test("a non-HTTP(S) node URL is refused before any request", async () => {
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
