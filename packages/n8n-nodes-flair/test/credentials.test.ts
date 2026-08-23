import { describe, test, expect } from "bun:test";
import { FlairApi } from "../src/credentials/FlairApi.credentials";

describe("FlairApi credential", () => {
  const cred = new FlairApi();

  test("identifies as flairApi", () => {
    expect(cred.name).toBe("flairApi");
    expect(cred.displayName).toBe("Flair API");
  });

  test("declares the three required properties", () => {
    const names = cred.properties.map((p) => p.name);
    expect(names).toContain("baseUrl");
    expect(names).toContain("agentId");
    expect(names).toContain("adminPassword");
  });

  test("baseUrl defaults to localhost:19926 — stock `flair init` port (#1352 pin)", () => {
    const baseUrl = cred.properties.find((p) => p.name === "baseUrl")!;
    expect(baseUrl.default).toBe("http://localhost:19926");
    expect(baseUrl.required).toBe(true);
    // Colon-anchored regression pin (#1347 family, bob#91 pattern):
    // ":19926" contains the substring "9926", so a bare contains-check
    // could never catch a flip back to the fossilized spoke port. The
    // leading colon makes ":9926" match ONLY the old literal.
    expect(String(baseUrl.default)).toContain(":19926");
    expect(String(baseUrl.default)).not.toContain(":9926");
    // The description names the default too — pin it the same way so the
    // UI hint can't silently drift back either. (It may legitimately
    // MENTION :9926 as the spoke port; it must lead with :19926 and the
    // default itself must not regress.)
    expect(String(baseUrl.description)).toContain(":19926");
  });

  test("adminPassword is masked (password type)", () => {
    const pw = cred.properties.find((p) => p.name === "adminPassword")!;
    expect((pw as any).typeOptions?.password).toBe(true);
    expect(pw.required).toBe(true);
  });

  test("agentId is required (memory ownership scope)", () => {
    const agentId = cred.properties.find((p) => p.name === "agentId")!;
    expect(agentId.required).toBe(true);
  });

  test("authenticates via n8n's native HTTP Basic auth", () => {
    // Uses n8n's built-in auth.username / auth.password under
    // IAuthenticateGeneric — n8n handles base64 internally. Avoids
    // relying on Buffer being in n8n's expression sandbox (it isn't
    // always, see commit fixing 2026-05-11 incident).
    expect(cred.authenticate.type).toBe("generic");
    const auth = (cred.authenticate.properties as any).auth;
    expect(auth).toBeDefined();
    expect(auth.username).toBe("admin");
    expect(auth.password).toContain("$credentials.adminPassword");
    // No header-based Authorization — n8n constructs it from auth.{username,password}
    expect((cred.authenticate.properties as any).headers).toBeUndefined();
  });

  test("test request hits /Memory (auth-required) on the configured baseUrl", () => {
    // /Health is unauthenticated and would silently pass with bad creds —
    // /Memory returns 401 without a valid Authorization header.
    expect(cred.test.request.url).toBe("/Memory");
    expect(cred.test.request.baseURL).toContain("$credentials.baseUrl");
  });
});
