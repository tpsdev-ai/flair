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
import { provisionIdpIdentityMapping } from "../../src/lib/mcp-enable.js";

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
