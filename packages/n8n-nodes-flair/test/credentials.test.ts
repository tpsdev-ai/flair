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

  test("baseUrl defaults to localhost:9926", () => {
    const baseUrl = cred.properties.find((p) => p.name === "baseUrl")!;
    expect(baseUrl.default).toBe("http://localhost:9926");
    expect(baseUrl.required).toBe(true);
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
