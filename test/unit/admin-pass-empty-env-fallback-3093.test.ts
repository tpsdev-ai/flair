/**
 * admin-pass-empty-env-fallback-3093.test.ts — Issue #3093.
 *
 * The updated credential reads in flair reembed, agent list, federation pairing,
 * memory hygiene, and the rem run cycle treat an empty FLAIR_ADMIN_PASS (as set
 * by a shell or other external setup) as unset and fall back to HDB_ADMIN_PASSWORD.
 *
 * Before this fix, `flair reembed` failed with "Admin password required" when
 * FLAIR_ADMIN_PASS was set to an empty string in the environment.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { authedRequest, envAdminPass } from "../../src/lib/auth-resolve.js";

const savedFlairPass = process.env.FLAIR_ADMIN_PASS;
const savedHdbPass = process.env.HDB_ADMIN_PASSWORD;

afterEach(() => {
  if (savedFlairPass === undefined) delete process.env.FLAIR_ADMIN_PASS;
  else process.env.FLAIR_ADMIN_PASS = savedFlairPass;

  if (savedHdbPass === undefined) delete process.env.HDB_ADMIN_PASSWORD;
  else process.env.HDB_ADMIN_PASSWORD = savedHdbPass;
});

describe("envAdminPass helper truth table (#3093)", () => {
  test("returns undefined when both variables are unset", () => {
    delete process.env.FLAIR_ADMIN_PASS;
    delete process.env.HDB_ADMIN_PASSWORD;
    expect(envAdminPass()).toBeUndefined();
  });

  test("returns undefined when FLAIR_ADMIN_PASS is unset and HDB_ADMIN_PASSWORD is empty", () => {
    delete process.env.FLAIR_ADMIN_PASS;
    process.env.HDB_ADMIN_PASSWORD = "";
    expect(envAdminPass()).toBeUndefined();
  });

  test("returns HDB_ADMIN_PASSWORD when FLAIR_ADMIN_PASS is unset and HDB_ADMIN_PASSWORD is set", () => {
    delete process.env.FLAIR_ADMIN_PASS;
    process.env.HDB_ADMIN_PASSWORD = "hdb-secret-pass";
    expect(envAdminPass()).toBe("hdb-secret-pass");
  });

  test("returns undefined when FLAIR_ADMIN_PASS is empty and HDB_ADMIN_PASSWORD is unset", () => {
    process.env.FLAIR_ADMIN_PASS = "";
    delete process.env.HDB_ADMIN_PASSWORD;
    expect(envAdminPass()).toBeUndefined();
  });

  test("returns undefined when both FLAIR_ADMIN_PASS and HDB_ADMIN_PASSWORD are empty", () => {
    process.env.FLAIR_ADMIN_PASS = "";
    process.env.HDB_ADMIN_PASSWORD = "";
    expect(envAdminPass()).toBeUndefined();
  });

  test("treats empty FLAIR_ADMIN_PASS as unset and falls back to HDB_ADMIN_PASSWORD", () => {
    process.env.FLAIR_ADMIN_PASS = "";
    process.env.HDB_ADMIN_PASSWORD = "hdb-fallback-pass";
    expect(envAdminPass()).toBe("hdb-fallback-pass");
  });

  test("returns FLAIR_ADMIN_PASS when set and HDB_ADMIN_PASSWORD is unset", () => {
    process.env.FLAIR_ADMIN_PASS = "flair-admin-pass";
    delete process.env.HDB_ADMIN_PASSWORD;
    expect(envAdminPass()).toBe("flair-admin-pass");
  });

  test("returns FLAIR_ADMIN_PASS when set and HDB_ADMIN_PASSWORD is empty", () => {
    process.env.FLAIR_ADMIN_PASS = "flair-admin-pass";
    process.env.HDB_ADMIN_PASSWORD = "";
    expect(envAdminPass()).toBe("flair-admin-pass");
  });

  test("returns FLAIR_ADMIN_PASS when both are set (FLAIR_ADMIN_PASS takes precedence)", () => {
    process.env.FLAIR_ADMIN_PASS = "flair-preferred-pass";
    process.env.HDB_ADMIN_PASSWORD = "hdb-fallback-pass";
    expect(envAdminPass()).toBe("flair-preferred-pass");
  });
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
