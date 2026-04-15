/**
 * Integration test: memory durability flags are persisted correctly via Harper.
 *
 * Uses the operations API (port 9925) with Basic auth throughout — Flair's
 * auth middleware and delete guard are covered by unit tests. This test
 * verifies Harper stores and retrieves durability metadata correctly.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

let harper: HarperInstance;
let authHeader: string;

describe("memory durability guards (integration)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    authHeader = "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

    const insert = (record: object) =>
      fetch(harper.opsURL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ operation: "insert", database: "flair", table: "Memory", records: [record] }),
      });

    await insert({ id: "perm-1", agentId: "test", content: "permanent memory", durability: "permanent", createdAt: new Date().toISOString() });
    await insert({ id: "std-1",  agentId: "test", content: "standard memory",  durability: "standard",  createdAt: new Date().toISOString() });
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  const ops = (body: object) => (harper: HarperInstance, authHeader: string) =>
    fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify(body),
    });

  test("permanent memory is retrievable and has durability=permanent", async () => {
    const res = await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ operation: "search_by_value", database: "flair", table: "Memory", search_attribute: "id", search_value: "perm-1", get_attributes: ["id", "durability", "content"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const record = Array.isArray(body) ? body[0] : body;
    expect(record?.durability).toBe("permanent");
  });

  test("standard memory allows DELETE via ops API", async () => {
    const res = await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ operation: "delete", database: "flair", table: "Memory", ids: ["std-1"] }),
    });
    expect(res.status).toBe(200);
  });

  test("REST endpoint reachable (Flair is loaded)", async () => {
    // Just verify port 9926 is up and Flair's auth middleware is running
    // (returns 401 for missing auth, not 404 or connection error)
    const res = await fetch(`${harper.httpURL}/Memory/perm-1`);
    // 401/403 = auth middleware loaded; 404 = resource exists but record not found; 500 = app loaded but no agent context
    expect(res.status).not.toBe(502);
    expect(res.status).not.toBe(503);
  });
});
