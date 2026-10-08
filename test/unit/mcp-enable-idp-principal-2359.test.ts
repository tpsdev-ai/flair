/**
 * mcp-enable-idp-principal-2359.test.ts — flair#2359.
 *
 * `flair mcp enable`'s IdP provisioning
 * (provisionIdpIdentityMapping, src/lib/mcp-enable.ts) inserts the principal
 * Agent row through the operations API, so the Agent resource's own guard never
 * runs on it. It must refuse a principal outside the ONE shared agent-ID rule
 * before sending any request.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableMcp, provisionIdpIdentityMapping } from "../../src/lib/mcp-enable.js";

describe("flair#2359 — provisionIdpIdentityMapping refuses an out-of-rule principal before any ops call", () => {
  it("a dot in the principal id is refused with the named rule and no request is sent", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      provisionIdpIdentityMapping(
        {
          opsPortOrUrl: 19925,
          adminUser: "admin",
          adminPass: "throwaway-admin-pass-not-a-secret",
          principal: "bad.id",
          principalKind: "agent",
          idpProvider: "github",
          idpSubject: "subject-1",
        },
        { fetchImpl, now: () => "2026-10-08T00:00:00.000Z" },
      ),
    ).rejects.toThrow(/invalid agent id/);
    expect(calls).toBe(0);
  });
});

describe("flair#2359 — enableMcp refuses an out-of-rule principal before the dry run succeeds or anything is staged", () => {
  const INSTANCE = "https://flair.example.harperfabric.com";
  const params = {
    instance: INSTANCE,
    adminUser: "admin",
    adminPass: "throwaway-admin-pass-not-a-secret",
    idpProvider: "github" as const,
    idpClientId: "id",
    idpClientSecret: "throwaway-idp-secret-not-a-secret",
    idpSubject: "octocat",
    principal: "bad.id",
    principalKind: "human" as const,
  };

  function fetchCounter() {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }

  it("a dry run with an out-of-rule principal FAILS instead of reporting success, with no request", async () => {
    const { fetchImpl, calls } = fetchCounter();
    const res = await enableMcp({ ...params, dryRun: true }, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.refused?.message).toContain("invalid agent id");
    expect(calls()).toBe(0);
  });

  it("a real run with an out-of-rule principal is refused before any secrets are staged or pushed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-2359-enable-"));
    try {
      const { fetchImpl, calls } = fetchCounter();
      const stagingPath = join(dir, "oauth-secrets.env");
      const res = await enableMcp(
        { ...params, secretsStagingPath: stagingPath, confirmSecretsApplied: true },
        { fetchImpl },
      );
      expect(res.ok).toBe(false);
      expect(res.refused?.message).toContain("invalid agent id");
      expect(calls()).toBe(0);
      expect(existsSync(stagingPath), "a refused principal staged a secrets file").toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
