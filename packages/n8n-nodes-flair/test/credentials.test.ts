import { describe, test, expect } from "bun:test";
import { FlairApi } from "../src/credentials/FlairApi.credentials";

describe("FlairApi credential", () => {
  const cred = new FlairApi();

  test("identifies as flairApi", () => {
    expect(cred.name).toBe("flairApi");
    expect(cred.displayName).toBe("Flair API");
  });

  test("declares baseUrl, agentId, the agent key and the deprecated admin password", () => {
    const names = cred.properties.map((p) => p.name);
    expect(names).toContain("baseUrl");
    expect(names).toContain("agentId");
    expect(names).toContain("agentPrivateKey");
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

  test("agentId is required", () => {
    const agentId = cred.properties.find((p) => p.name === "agentId")!;
    expect(agentId.required).toBe(true);
  });

  test("agentPrivateKey is a masked secret and not required (legacy credentials have none)", () => {
    const key = cred.properties.find((p) => p.name === "agentPrivateKey")!;
    expect((key as any).typeOptions?.password).toBe(true);
    expect(key.required).toBeUndefined();
  });

  test("adminPassword is a masked secret named deprecated, and not required", () => {
    const admin = cred.properties.find((p) => p.name === "adminPassword")!;
    expect((admin as any).typeOptions?.password).toBe(true);
    expect(admin.displayName.toLowerCase()).toContain("deprecated");
    expect(admin.required).toBeUndefined();
  });

  test("uses the node credential test instead of declarative Basic auth", () => {
    // The old credential test used Basic; the node test generates Ed25519 signatures.
    expect((cred as any).authenticate).toBeUndefined();
    expect((cred as any).test).toBeUndefined();
  });
});
