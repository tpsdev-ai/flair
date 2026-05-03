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
    expect(names).toContain("adminToken");
  });

  test("baseUrl defaults to localhost:9926", () => {
    const baseUrl = cred.properties.find((p) => p.name === "baseUrl")!;
    expect(baseUrl.default).toBe("http://localhost:9926");
    expect(baseUrl.required).toBe(true);
  });

  test("adminToken is masked (password type)", () => {
    const tok = cred.properties.find((p) => p.name === "adminToken")!;
    expect((tok as any).typeOptions?.password).toBe(true);
    expect(tok.required).toBe(true);
  });

  test("agentId is required (memory ownership scope)", () => {
    const agentId = cred.properties.find((p) => p.name === "agentId")!;
    expect(agentId.required).toBe(true);
  });

  test("authenticates via Bearer header", () => {
    expect(cred.authenticate.type).toBe("generic");
    const headers = (cred.authenticate.properties as any).headers;
    expect(headers.Authorization).toContain("Bearer");
    expect(headers.Authorization).toContain("$credentials.adminToken");
  });

  test("test request hits /Health on the configured baseUrl", () => {
    expect(cred.test.request.url).toBe("/Health");
    expect(cred.test.request.baseURL).toContain("$credentials.baseUrl");
  });
});
