/**
 * admin-user-resolve.test.ts — Unit tests for flair#1345
 *
 * `flair agent add` (and every sibling that sends Basic admin auth) used to
 * hardcode the username `admin` (DEFAULT_ADMIN_USER). With `authorizeLocal:
 * false` (#604/#610) those paths MUST send real credentials, and on an
 * instance whose superuser is not named `admin` there was no flag to say so
 * — the result was a bare 401 `{"error":"Login failed"}` whose hint text
 * only ever pointed at the password.
 *
 * Fix under test:
 *   - `resolveAdminUser(explicit?)` — flag > FLAIR_ADMIN_USER env > "admin"
 *     (exercised via the REAL export, not a reimplementation).
 *   - seedAgentViaOpsApi / seedFederationInstanceViaOpsApi 401 errors name
 *     BOTH possible causes (wrong password, wrong username) and the knob
 *     for each (--admin-pass / --admin-user + envs).
 *   - `--admin-user` is wired on every command that authenticates with an
 *     admin Basic credential it lets you set the password for.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveAdminUser, DEFAULT_ADMIN_USER, authedRequest } from "../../src/lib/auth-resolve.js";
import { seedAgentViaOpsApi, seedFederationInstanceViaOpsApi, program } from "../../src/cli.js";

// ─── Env save/restore ─────────────────────────────────────────────────────────

let origAdminUser: string | undefined;
let origAdminPass: string | undefined;
let origToken: string | undefined;

beforeEach(() => {
  origAdminUser = process.env.FLAIR_ADMIN_USER;
  origAdminPass = process.env.FLAIR_ADMIN_PASS;
  origToken = process.env.FLAIR_TOKEN;
  delete process.env.FLAIR_ADMIN_USER;
  delete process.env.FLAIR_ADMIN_PASS;
  delete process.env.FLAIR_TOKEN;
});

afterEach(() => {
  if (origAdminUser === undefined) delete process.env.FLAIR_ADMIN_USER;
  else process.env.FLAIR_ADMIN_USER = origAdminUser;
  if (origAdminPass === undefined) delete process.env.FLAIR_ADMIN_PASS;
  else process.env.FLAIR_ADMIN_PASS = origAdminPass;
  if (origToken === undefined) delete process.env.FLAIR_TOKEN;
  else process.env.FLAIR_TOKEN = origToken;
});

// ─── resolveAdminUser precedence: flag > env > default ────────────────────────

describe("resolveAdminUser — flag > FLAIR_ADMIN_USER > default (flair#1345)", () => {
  test("default is 'admin' when no flag and no env (existing behavior unchanged)", () => {
    expect(resolveAdminUser(undefined)).toBe("admin");
    expect(resolveAdminUser(undefined)).toBe(DEFAULT_ADMIN_USER);
  });

  test("FLAIR_ADMIN_USER env beats the default", () => {
    process.env.FLAIR_ADMIN_USER = "root";
    expect(resolveAdminUser(undefined)).toBe("root");
  });

  test("explicit flag value beats the env", () => {
    process.env.FLAIR_ADMIN_USER = "root";
    expect(resolveAdminUser("operator")).toBe("operator");
  });

  test("explicit flag value beats the default when no env", () => {
    expect(resolveAdminUser("operator")).toBe("operator");
  });

  test("empty-string explicit falls through to env then default (|| semantics)", () => {
    process.env.FLAIR_ADMIN_USER = "root";
    expect(resolveAdminUser("")).toBe("root");
    delete process.env.FLAIR_ADMIN_USER;
    expect(resolveAdminUser("")).toBe("admin");
  });
});

// ─── Seed functions send the resolved username in Basic auth ─────────────────

function stubFetch(status: number, body: string | null): { captured: { url?: string; auth?: string }; restore: () => void } {
  const origFetch = globalThis.fetch;
  const captured: { url?: string; auth?: string } = {};
  globalThis.fetch = (async (url: any, opts: any) => {
    captured.url = typeof url === "string" ? url : url.toString();
    captured.auth = opts?.headers?.Authorization ?? opts?.headers?.authorization;
    return new Response(body, { status });
  }) as any;
  return { captured, restore: () => { globalThis.fetch = origFetch; } };
}

describe("seedAgentViaOpsApi — Basic auth carries the caller's adminUser", () => {
  test("default path unchanged: adminUser 'admin' sends Basic admin:<pass>", async () => {
    const { captured, restore } = stubFetch(200, null);
    try {
      await seedAgentViaOpsApi(19925, "some-agent", "pubkeyb64==", "admin", "sekret");
    } finally {
      restore();
    }
    expect(captured.auth).toBe(`Basic ${Buffer.from("admin:sekret").toString("base64")}`);
  });

  test("a non-default adminUser is what actually goes on the wire", async () => {
    const { captured, restore } = stubFetch(200, null);
    try {
      await seedAgentViaOpsApi(19925, "some-agent", "pubkeyb64==", "operator", "sekret");
    } finally {
      restore();
    }
    expect(captured.auth).toBe(`Basic ${Buffer.from("operator:sekret").toString("base64")}`);
  });
});

// ─── 401 hint names BOTH causes, with the knob for each ──────────────────────

describe("ops-API seed 401 hint (flair#1345)", () => {
  async function seed401Message(adminUser: string, adminPass: string | undefined): Promise<string> {
    const { restore } = stubFetch(401, '{"error":"Login failed"}');
    try {
      await seedAgentViaOpsApi(19925, "some-agent", "pubkeyb64==", adminUser, adminPass);
      throw new Error("expected seedAgentViaOpsApi to throw on 401");
    } catch (err: any) {
      return String(err.message);
    } finally {
      restore();
    }
  }

  test("credentialed 401 names wrong password AND wrong username, with remedies", async () => {
    const msg = await seed401Message("operator", "bad-pass");
    expect(msg).toContain("Operations API insert failed (401)");
    expect(msg).toContain("Login failed"); // the raw server body is preserved
    expect(msg).toContain("'operator'"); // names the username actually tried
    expect(msg).toContain("wrong password");
    expect(msg).toContain("--admin-pass");
    expect(msg).toContain("FLAIR_ADMIN_PASS");
    expect(msg).toContain("wrong username");
    expect(msg).toContain("--admin-user");
    expect(msg).toContain("FLAIR_ADMIN_USER");
    // the password itself must never be echoed
    expect(msg).not.toContain("bad-pass");
  });

  test("credential-LESS 401 says no credentials were sent (not 'wrong password')", async () => {
    const msg = await seed401Message("admin", undefined);
    expect(msg).toContain("No admin credentials were sent");
    expect(msg).toContain("--admin-pass");
    expect(msg).toContain("--admin-user");
    expect(msg).not.toContain("wrong password");
  });

  test("positive control: a non-401 failure does NOT carry the credentials hint", async () => {
    const { restore } = stubFetch(500, "boom");
    let msg = "";
    try {
      await seedAgentViaOpsApi(19925, "some-agent", "pubkeyb64==", "admin", "sekret");
    } catch (err: any) {
      msg = String(err.message);
    } finally {
      restore();
    }
    expect(msg).toContain("Operations API insert failed (500)");
    expect(msg).not.toContain("--admin-user");
  });

  test("seedFederationInstanceViaOpsApi carries the same 401 hint", async () => {
    const { restore } = stubFetch(401, '{"error":"Login failed"}');
    let msg = "";
    try {
      await seedFederationInstanceViaOpsApi(19925, "inst-1", "pubkeyb64==", "hub", "operator", "bad-pass");
    } catch (err: any) {
      msg = String(err.message);
    } finally {
      restore();
    }
    expect(msg).toContain("Federation Instance insert via ops API failed (401)");
    expect(msg).toContain("--admin-user");
    expect(msg).toContain("FLAIR_ADMIN_USER");
    expect(msg).toContain("'operator'");
  });
});

// ─── authedRequest Basic tiers honor FLAIR_ADMIN_USER ────────────────────────

describe("authedRequest Basic tiers use resolveAdminUser (flair#1345)", () => {
  test("tier 2 (FLAIR_ADMIN_PASS env) sends FLAIR_ADMIN_USER, not hardcoded 'admin'", async () => {
    process.env.FLAIR_ADMIN_PASS = "envpass";
    process.env.FLAIR_ADMIN_USER = "customuser";
    const { captured, restore } = stubFetch(200, "{}");
    try {
      await authedRequest("GET", "/Health", undefined, { baseUrl: "http://127.0.0.1:1" });
    } finally {
      restore();
    }
    expect(captured.auth).toBe(`Basic ${Buffer.from("customuser:envpass").toString("base64")}`);
  });

  test("tier 2 default stays admin when FLAIR_ADMIN_USER is unset", async () => {
    process.env.FLAIR_ADMIN_PASS = "envpass";
    const { captured, restore } = stubFetch(200, "{}");
    try {
      await authedRequest("GET", "/Health", undefined, { baseUrl: "http://127.0.0.1:1" });
    } finally {
      restore();
    }
    expect(captured.auth).toBe(`Basic ${Buffer.from("admin:envpass").toString("base64")}`);
  });

  test("tier 1 (explicitAdminPass) honors opts.adminUser over env", async () => {
    process.env.FLAIR_ADMIN_USER = "envuser";
    const { captured, restore } = stubFetch(200, "{}");
    try {
      await authedRequest("GET", "/Health", undefined, {
        baseUrl: "http://127.0.0.1:1",
        explicitAdminPass: "flagpass",
        adminUser: "flaguser",
      });
    } finally {
      restore();
    }
    expect(captured.auth).toBe(`Basic ${Buffer.from("flaguser:flagpass").toString("base64")}`);
  });
});

// ─── --admin-user is wired on every admin-Basic command ──────────────────────
//
// The check that can fire: an explicit list, each asserted individually, plus
// a count. Removing the option from any one of these commands fails a named
// test, not a rollup.

describe("--admin-user flag wiring (flair#1345)", () => {
  function findCommand(path: string[]): any {
    let cur: any = program;
    for (const name of path) {
      cur = cur.commands.find((c: any) => c.name() === name);
      if (!cur) throw new Error(`command not found: ${path.join(" ")}`);
    }
    return cur;
  }

  const WIRED: string[][] = [
    ["init"],
    ["agent", "add"],
    ["agent", "list"],
    ["agent", "rotate-key"],
    ["agent", "remove"],
    ["mcp", "grant"],
    ["mcp", "revoke"],
    ["mcp", "enable"],
    ["mcp", "disable"],
    ["principal", "add"],
    ["principal", "list"],
    ["principal", "disable"],
    ["principal", "promote"],
    ["idp", "add"],
    ["idp", "list"],
    ["idp", "remove"],
    ["grant"],
    ["revoke"],
    ["federation", "pair"],
    ["federation", "token"],
    ["federation", "sync"],
    ["federation", "watch"],
    ["backup"],
    ["restore"],
    ["export"],
    ["import"],
  ];

  for (const path of WIRED) {
    test(`flair ${path.join(" ")} exposes --admin-user`, () => {
      const cmd = findCommand(path);
      const opt = cmd.options.find((o: any) => o.long === "--admin-user");
      expect(opt).toBeDefined();
      // and it still exposes --admin-pass — the pairing this feature completes
      expect(cmd.options.some((o: any) => o.long === "--admin-pass")).toBe(true);
    });
  }

  test("wiring count is pinned (update the WIRED list deliberately, not by drift)", () => {
    expect(WIRED.length).toBe(26);
  });
});
