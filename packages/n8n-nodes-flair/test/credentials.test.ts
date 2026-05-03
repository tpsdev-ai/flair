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

  test("authenticates via Basic header (admin:adminPassword base64)", () => {
    expect(cred.authenticate.type).toBe("generic");
    const headers = (cred.authenticate.properties as any).headers;
    expect(headers.Authorization).toContain("Basic");
    // Header constructs admin:<password> via n8n expression then base64-encodes
    expect(headers.Authorization).toContain("admin:");
    expect(headers.Authorization).toContain("$credentials.adminPassword");
    expect(headers.Authorization).toContain("base64");
    // Bearer must NOT be used — Flair admin auth is Basic
    expect(headers.Authorization).not.toContain("Bearer");
  });

  test("test request hits /Memory (auth-required) on the configured baseUrl", () => {
    // /Health is unauthenticated and would silently pass with bad creds —
    // /Memory returns 401 without a valid Authorization header.
    expect(cred.test.request.url).toBe("/Memory");
    expect(cred.test.request.baseURL).toContain("$credentials.baseUrl");
  });
});
