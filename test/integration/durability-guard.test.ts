import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

let harper: HarperInstance;
let authHeader: string;

describe("memory durability guards (integration)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    authHeader = "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

    // Create a permanent memory
    await fetch(`${harper.opsURL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": authHeader },
      body: JSON.stringify({
        operation: "insert",
        table: "Memory",
        records: [{
          id: "perm-1",
          agentId: "test",
          content: "permanent memory",
          durability: "permanent",
          createdAt: new Date().toISOString(),
        }],
      }),
    });

    // Create a standard memory
    await fetch(`${harper.opsURL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": authHeader },
      body: JSON.stringify({
        operation: "insert",
        table: "Memory",
        records: [{
          id: "std-1",
          agentId: "test",
          content: "standard memory",
          durability: "standard",
          createdAt: new Date().toISOString(),
        }],
      }),
    });
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test("permanent memory rejects DELETE via REST", async () => {
    const res = await fetch(`${harper.httpURL}/Memory/perm-1`, {
      method: "DELETE",
      headers: { "Authorization": authHeader },
    });
    // Should be 403 (durability guard) or the record should still exist
    if (res.status === 403) {
      const body = await res.json();
      expect(body.error).toBe("permanent_memory_cannot_be_deleted");
    }
    // Verify it still exists
    const check = await fetch(`${harper.httpURL}/Memory/perm-1`, {
      headers: { "Authorization": authHeader },
    });
    expect(check.status).toBe(200);
  });

  test("standard memory allows DELETE via REST", async () => {
    const res = await fetch(`${harper.httpURL}/Memory/std-1`, {
      method: "DELETE",
      headers: { "Authorization": authHeader },
    });
    expect([200, 204]).toContain(res.status);
  });
});
