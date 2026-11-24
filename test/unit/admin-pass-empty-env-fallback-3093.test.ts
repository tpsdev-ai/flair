/**
 * admin-pass-empty-env-fallback-3093.test.ts — Issue #3093.
 *
 * An empty FLAIR_ADMIN_PASS (e.g. set from a missing or empty file) should be
 * treated as unset and fall back to HDB_ADMIN_PASSWORD.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { authedRequest } from "../../src/lib/auth-resolve.js";

const savedFlairPass = process.env.FLAIR_ADMIN_PASS;
const savedHdbPass = process.env.HDB_ADMIN_PASSWORD;

afterEach(() => {
  if (savedFlairPass === undefined) delete process.env.FLAIR_ADMIN_PASS;
  else process.env.FLAIR_ADMIN_PASS = savedFlairPass;

  if (savedHdbPass === undefined) delete process.env.HDB_ADMIN_PASSWORD;
  else process.env.HDB_ADMIN_PASSWORD = savedHdbPass;
});

describe("authedRequest tier 2 — empty FLAIR_ADMIN_PASS fallback (#3093)", () => {
  test("treats empty FLAIR_ADMIN_PASS as unset and falls back to HDB_ADMIN_PASSWORD", async () => {
    process.env.FLAIR_ADMIN_PASS = "";
    process.env.HDB_ADMIN_PASSWORD = "hdb-fallback-pass";

    let capturedAuth: string = "";
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("Authorization") ?? "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      await authedRequest("GET", "/HealthDetail", undefined, { baseUrl: "http://127.0.0.1:19999" });
      const expectedBasic = `Basic ${Buffer.from("admin:hdb-fallback-pass").toString("base64")}`;
      expect(capturedAuth).toBe(expectedBasic);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("uses FLAIR_ADMIN_PASS when non-empty even if HDB_ADMIN_PASSWORD is set", async () => {
    process.env.FLAIR_ADMIN_PASS = "flair-preferred-pass";
    process.env.HDB_ADMIN_PASSWORD = "hdb-fallback-pass";

    let capturedAuth: string = "";
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("Authorization") ?? "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      await authedRequest("GET", "/HealthDetail", undefined, { baseUrl: "http://127.0.0.1:19999" });
      const expectedBasic = `Basic ${Buffer.from("admin:flair-preferred-pass").toString("base64")}`;
      expect(capturedAuth).toBe(expectedBasic);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
