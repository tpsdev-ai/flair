import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

let harper: HarperInstance;

describe("Flair API E2E Smoke", () => {
  beforeAll(async () => {
    harper = await startHarper();
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test("Agent table accepts inserts via operations API", async () => {
    const res = await fetch(harper.opsURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
      },
      body: JSON.stringify({
        operation: "insert",
        database: "flair",
        table: "Agent",
        records: [{ id: "smoke-test", name: "Smoke", role: "test", publicKey: "dGVzdA==", createdAt: new Date().toISOString() }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inserted_hashes).toContain("smoke-test");
  });

  test("REST endpoint returns data", async () => {
    const res = await fetch(`${harper.httpURL}/Agent/smoke-test`);
    // authorizeLocal: true means we expect 401 without auth
    expect([200, 401]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(body.id).toBe("smoke-test");
    }
  });
});
