import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

let harper: HarperInstance;

describe("Flair API E2E Smoke", () => {
  beforeAll(async () => {
    harper = await startHarper();
  });

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test("health check returns 200", async () => {
    const res = await fetch(`${harper.httpURL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("unauthenticated access returns 401", async () => {
    const res = await fetch(`${harper.httpURL}/Agent`);
    expect(res.status).toBe(401);
  });
});
